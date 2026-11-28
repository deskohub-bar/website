import "@/shared/polyfills/temporal";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import { PostHogDistinctId } from "@deskohub/analytics-posthog/identifiers";
import {
  DotyposCustomerIdSchema,
  type DotyposReservationId,
  DotyposReservationIdSchema,
  DotyposService,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { IWorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { payableReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import type { IProviderPaymentFinalizationService } from "../payment/provider-payment-finalization.service";
import {
  expiredPaymentTransitionFixture,
  pendingNexiAttemptFixture,
} from "./reservation-hold-cleanup.test-utils";

/** The deadline every cleanup below was scheduled for, before `checkedAt`. */
const holdExpiresAt = Temporal.Instant.from("2026-06-02T09:50:00.000Z");
const holdCreatedAt = holdExpiresAt.subtract({ minutes: 10 });
/** The expired hold the cleanups below find on their order. */
const dueHold = {
  dotyposReservationId: DotyposReservationIdSchema.make(
    "dotypos-reservation-id"
  ),
  reservationHoldExpiresAt: holdExpiresAt,
};
const storedHold = {
  ...dueHold,
  reservationCreatedAt: holdCreatedAt,
  createdAt: holdCreatedAt,
  updatedAt: holdCreatedAt,
};
const claimStamp = Temporal.Instant.from("2026-06-02T10:00:00.500Z");

describe("ReservationHoldCleanupService", () => {
  test.each([
    { window: "legacy", verification: "paid" },
    { window: "shared", verification: "pending" },
    { window: "shared", verification: "recovery_pending" },
  ] as const)(
    "keeps the $window hold when its exposed card verifies as $verification",
    async ({ window, verification }) => {
      const { ProviderPaymentFinalizationService } = await import(
        "../payment/provider-payment-finalization.service"
      );
      const { PaymentLifecycleRepository } = await import(
        "../repositories/payment-lifecycle.repository"
      );
      const { ReservationHoldCleanupService } = await import(
        "./reservation-hold-cleanup.service"
      );
      const { QrPaymentRepository } = await import(
        "../repositories/qr-payment.repository"
      );
      const { UnpaidHoldRelease } = await import(
        "./unpaid-hold-release.service"
      );
      const { WorkspaceReservationRepository } = await import(
        "@/features/reservation/backend/workspace-reservation.repository"
      );
      const { recordCheckoutAnalytics } = await import(
        "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
      );

      const orderId = workspaceReservationIdSchema.make(
        "0198c1a2-a205-7a6d-8074-1f4a191643f8"
      );
      const attemptId = paymentAttemptIdSchema.make(
        "attempt-cleanup-provider-paid"
      );
      const qrAttemptId = paymentAttemptIdSchema.make("active-qr-attempt");
      const cancelReservation = mock(() => Effect.void);
      const claimCancellation = mock(() => Effect.succeed(null));
      const expirePublicPaymentWindow = mock(() => Effect.succeed(true));
      const finalization: IProviderPaymentFinalizationService = {
        finalizePendingProviderPayment: mock(() =>
          Effect.succeed(verification)
        ),
      };
      const reservations = {
        findById: mock(() =>
          Effect.succeed(
            payableReservationFixture({
              id: orderId,
              paymentState: "pending",
              activePaymentAttemptId:
                window === "shared" ? qrAttemptId : attemptId,
              ...storedHold,
            })
          )
        ),
        claimCancellation,
        recordHoldCleanupSkipped: mock(() => Effect.void),
      };
      const dotypos = {
        cancelReservation,
      };

      const outcome = await Effect.gen(function* () {
        const cleanup = yield* ReservationHoldCleanupService;
        return yield* cleanup.cancelOrderHold({
          orderId,
          holdExpiresAt,
          checkedAt: Temporal.Instant.from("2026-06-02T10:00:00.000Z"),
        });
      }).pipe(
        Effect.provide(
          ReservationHoldCleanupService.Default.pipe(
            Layer.provide(UnpaidHoldRelease.Default),
            Layer.provide(makeRecordingAdvisoryLock().layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProviderPaymentFinalizationService, finalization),
                Layer.mock(QrPaymentRepository, {
                  findPaymentWindow: (reservationId) =>
                    Effect.succeed(
                      window === "shared"
                        ? {
                            orderId:
                              standaloneReservationOrderId(reservationId),
                            expiresAt: holdExpiresAt,
                            accountKey: "account-1",
                            cardAttemptId: attemptId,
                            qrAttemptId,
                          }
                        : null
                    ),
                  findCardAttempt: () =>
                    Effect.succeed(
                      pendingNexiAttemptFixture(
                        orderId,
                        attemptId,
                        holdExpiresAt.subtract({ minutes: 10 })
                      )
                    ),
                }),
                Layer.mock(PaymentLifecycleRepository, {
                  markTerminal: mock(() => Effect.die("not used")),
                  expirePublicPaymentWindow,
                }),
                Layer.mock(WorkspaceReservationRepository, reservations),
                recordCheckoutAnalytics().layer,
                Layer.mock(DotyposService, dotypos)
              )
            )
          )
        ),
        Effect.runPromise
      );

      expect(outcome).toBe("skipped");
      expect(finalization.finalizePendingProviderPayment).toHaveBeenCalledWith({
        orderId,
        paymentAttemptId: attemptId,
        abandonmentCheckedAt: Temporal.Instant.from("2026-06-02T10:00:00.000Z"),
        ...(window === "shared" && { sharedWindowCutoff: holdExpiresAt }),
      });
      expect(expirePublicPaymentWindow).not.toHaveBeenCalled();
      expect(claimCancellation).not.toHaveBeenCalled();
      expect(cancelReservation).not.toHaveBeenCalled();
    }
  );

  test("counts unconfirmed pending payment cleanup as skipped without cancelling", async () => {
    const { ProviderPaymentFinalizationService } = await import(
      "../payment/provider-payment-finalization.service"
    );
    const { PaymentLifecycleRepository } = await import(
      "../repositories/payment-lifecycle.repository"
    );
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    const { UnpaidHoldRelease } = await import("./unpaid-hold-release.service");
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );

    const orderId = workspaceReservationIdSchema.make(
      "0198c1a2-f317-74b0-8c00-931fc7799e18"
    );
    const attemptId = paymentAttemptIdSchema.make(
      "attempt-cleanup-provider-pending"
    );
    const now = Temporal.Instant.from("2026-06-02T10:00:00.000Z");
    const activeReservation = payableReservationFixture({
      id: orderId,
      paymentState: "pending",
      activePaymentAttemptId: attemptId,
      ...storedHold,
    });
    const selectExpiredHolds = mock(() => Effect.succeed([activeReservation]));
    const recordHoldCleanupSkipped = mock(() => Effect.void);
    const claimCancellation = mock(() => Effect.die("not used"));
    const cancelReservation = mock(() => Effect.die("not used"));
    const finalization: IProviderPaymentFinalizationService = {
      finalizePendingProviderPayment: mock(() =>
        Effect.succeed("pending" as const)
      ),
    };
    const reservations = {
      selectExpiredHolds,
      findById: mock(() => Effect.succeed(activeReservation)),
      recordHoldCleanupSkipped,
      claimCancellation,
    };
    const dotypos = {
      cancelReservation,
    };

    const runSweep = () =>
      Effect.gen(function* () {
        const cleanup = yield* ReservationHoldCleanupService;
        return yield* cleanup.sweepExpiredHolds({ now, limit: 1 });
      }).pipe(
        Effect.provide(
          ReservationHoldCleanupService.Default.pipe(
            Layer.provide(UnpaidHoldRelease.Default),
            Layer.provide(makeRecordingAdvisoryLock().layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProviderPaymentFinalizationService, finalization),
                Layer.mock(PaymentLifecycleRepository, {
                  markTerminal: mock(() => Effect.die("not used")),
                }),
                Layer.mock(WorkspaceReservationRepository, reservations),
                recordCheckoutAnalytics().layer,
                Layer.mock(DotyposService, dotypos)
              )
            )
          )
        ),
        Effect.runPromise
      );

    await expect(runSweep()).resolves.toEqual({
      cancelled: 0,
      skipped: 1,
      failed: 0,
    });
    await expect(runSweep()).resolves.toEqual({
      cancelled: 0,
      skipped: 1,
      failed: 0,
    });

    expect(recordHoldCleanupSkipped).toHaveBeenCalledTimes(2);
    expect(recordHoldCleanupSkipped).toHaveBeenCalledWith({
      id: orderId,
      holdExpiredAt: now,
      failureCode: "payment_outcome_unconfirmed_before_cleanup",
    });
    expect(finalization.finalizePendingProviderPayment).toHaveBeenCalledTimes(
      2
    );
    expect(claimCancellation).not.toHaveBeenCalled();
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  test("expires a verified abandoned payment attempt before cancelling the hold", async () => {
    const { PaymentLifecycleRepository } = await import(
      "../repositories/payment-lifecycle.repository"
    );
    const { ProviderPaymentFinalizationService } = await import(
      "../payment/provider-payment-finalization.service"
    );
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    const { UnpaidHoldRelease } = await import("./unpaid-hold-release.service");
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );

    const orderId = workspaceReservationIdSchema.make(
      "0198c1a2-eb5e-70fc-815d-10d00be06855"
    );
    const attemptId = paymentAttemptIdSchema.make("attempt-cleanup-abandoned");
    const checkedAt = Temporal.Instant.from("2026-06-02T10:00:00.000Z");
    const claimed = payableReservationFixture({
      ...storedHold,
      id: orderId,
      reservationState: "cancelling",
      paymentState: "expired",
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      updatedAt: claimStamp,
    });
    const claimCancellation = mock(() => Effect.succeed(claimed));
    const cancelReservation = mock(() => Effect.void);
    const markCancelled = mock(() => Effect.void);
    const markTerminalForReservation = mock(() =>
      Effect.succeed(
        expiredPaymentTransitionFixture(
          orderId,
          attemptId,
          Temporal.Now.instant()
        )
      )
    );
    const analytics = recordCheckoutAnalytics();
    await Effect.gen(function* () {
      const cleanup = yield* ReservationHoldCleanupService;
      return yield* cleanup.cancelOrderHold({
        orderId,
        holdExpiresAt,
        checkedAt,
      });
    }).pipe(
      Effect.provide(
        ReservationHoldCleanupService.Default.pipe(
          Layer.provide(UnpaidHoldRelease.Default),
          Layer.provide(makeRecordingAdvisoryLock().layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderPaymentFinalizationService, {
                finalizePendingProviderPayment: mock(() =>
                  Effect.succeed("abandoned" as const)
                ),
              } satisfies IProviderPaymentFinalizationService),
              Layer.mock(PaymentLifecycleRepository, {
                markTerminal: markTerminalForReservation,
              }),
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() =>
                  Effect.succeed(
                    payableReservationFixture({
                      id: orderId,
                      paymentState: "pending",
                      activePaymentAttemptId: attemptId,
                      ...storedHold,
                    })
                  )
                ),
                claimCancellation,
                markCancelled,
              }),
              analytics.layer,
              Layer.mock(DotyposService, {
                getReservationStatus: mock(() =>
                  Effect.succeed("NEW" as const)
                ),
                cancelReservation,
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    expect(markTerminalForReservation).toHaveBeenCalledWith({
      id: attemptId,
      orderId,
      state: "expired",
      failureCode: "payment_abandoned_after_provider_cutoff",
    });

    expect(claimCancellation).toHaveBeenCalledWith({
      id: orderId,
      expectedHold: dueHold,
      cause: "hold_expired",
    });
    expect(cancelReservation).toHaveBeenCalledWith("dotypos-reservation-id");
    expect(markCancelled).toHaveBeenCalledWith({
      id: orderId,
      claimedAt: claimStamp,
      cancelledAt: expect.any(Temporal.Instant),
      holdExpiredAt: checkedAt,
    });
    expect(analytics.messages).toContainEqual(
      expect.objectContaining({
        distinctId: orderId,
        event: "reservation abandoned",
      })
    );
  });

  test("does not cancel an expired hold when provider verification fails transiently", async () => {
    const { PaymentLifecycleRepository } = await import(
      "../repositories/payment-lifecycle.repository"
    );
    const { ProviderPaymentFinalizationService } = await import(
      "../payment/provider-payment-finalization.service"
    );
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    const { UnpaidHoldRelease } = await import("./unpaid-hold-release.service");
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );

    const orderId = workspaceReservationIdSchema.make(
      "0198c1a2-f317-737f-823d-4c70fc76ec7b"
    );
    const attemptId = paymentAttemptIdSchema.make(
      "attempt-cleanup-provider-failed"
    );
    const markTerminalForReservation = mock(() => Effect.die("not used"));
    const claimCancellation = mock(() => Effect.succeed(null));
    const cancelReservation = mock(() => Effect.void);

    await Effect.gen(function* () {
      const cleanup = yield* ReservationHoldCleanupService;
      return yield* cleanup.cancelOrderHold({ orderId, holdExpiresAt });
    }).pipe(
      Effect.provide(
        ReservationHoldCleanupService.Default.pipe(
          Layer.provide(UnpaidHoldRelease.Default),
          Layer.provide(makeRecordingAdvisoryLock().layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderPaymentFinalizationService, {
                finalizePendingProviderPayment: mock(() =>
                  Effect.succeed("provider_verification_failed" as const)
                ),
              } satisfies IProviderPaymentFinalizationService),
              Layer.mock(PaymentLifecycleRepository, {
                markTerminal: markTerminalForReservation,
              }),
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() =>
                  Effect.succeed(
                    payableReservationFixture({
                      id: orderId,
                      paymentState: "pending",
                      activePaymentAttemptId: attemptId,
                      ...storedHold,
                    })
                  )
                ),
                claimCancellation,
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(DotyposService, {
                cancelReservation,
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    expect(markTerminalForReservation).not.toHaveBeenCalled();
    expect(claimCancellation).not.toHaveBeenCalled();
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  test("sweeps expired holds under their live Dotypos status", async () => {
    const { ProviderPaymentFinalizationService } = await import(
      "../payment/provider-payment-finalization.service"
    );
    const { PaymentLifecycleRepository } = await import(
      "../repositories/payment-lifecycle.repository"
    );
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    const { UnpaidHoldRelease } = await import("./unpaid-hold-release.service");
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );

    // One expired hold per live Dotypos status, and one whose status can't
    // be read. None has a pending payment, so each goes straight to release.
    const statuses = [
      ["reservation-sweep-new", "NEW"],
      ["reservation-sweep-cancelled", "CANCELLED"],
      ["0198c1a2-9857-77d2-8d7f-92c5539c944f", "CONFIRMED"],
      ["0198c1a2-ff26-7e37-87c0-67407bb1b189", undefined],
    ] as const;
    const holdOf = (id: string) =>
      DotyposReservationIdSchema.make(`dotypos-${id}`);
    const orderOf = (id: WorkspaceReservationId) =>
      payableReservationFixture({
        ...storedHold,
        id,
        dotyposReservationId: holdOf(id),
        dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
        updatedAt: claimStamp,
      });
    const orders = statuses.map(([id]) =>
      orderOf(workspaceReservationIdSchema.make(id))
    );

    const markCancelled = mock((_: { readonly id: string }) => Effect.void);
    const markCancellationFailed = mock<
      IWorkspaceReservationRepository["markCancellationFailed"]
    >(() => Effect.void);
    const cancelReservation = mock((_: DotyposReservationId) => Effect.void);
    const getReservationStatus = mock((hold: DotyposReservationId) => {
      const [, status] = requireValue(
        statuses.find(([id]) => holdOf(id) === hold),
        "fixture for Dotypos hold"
      );
      return status
        ? Effect.succeed(status)
        : Effect.fail(
            new DotyposUnavailable({
              operation: "getReservationStatus",
              reason: "server",
            })
          );
    });
    const analytics = recordCheckoutAnalytics();

    const summary = await Effect.gen(function* () {
      const cleanup = yield* ReservationHoldCleanupService;
      return yield* cleanup.sweepExpiredHolds({
        now: Temporal.Instant.from("2026-06-02T10:00:00.000Z"),
        limit: orders.length,
      });
    }).pipe(
      Effect.provide(
        ReservationHoldCleanupService.Default.pipe(
          Layer.provide(UnpaidHoldRelease.Default),
          Layer.provide(makeRecordingAdvisoryLock().layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderPaymentFinalizationService, {
                finalizePendingProviderPayment: mock(() =>
                  Effect.die("not used")
                ),
              } satisfies IProviderPaymentFinalizationService),
              Layer.mock(PaymentLifecycleRepository, {
                markTerminal: mock(() => Effect.die("not used")),
              }),
              Layer.mock(WorkspaceReservationRepository, {
                selectExpiredHolds: mock(() => Effect.succeed(orders)),
                findById: mock((id) =>
                  Effect.succeed(
                    orders.find((order) => order.id === id) ?? null
                  )
                ),
                claimCancellation: mock(({ id }) =>
                  Effect.succeed({
                    ...orderOf(id),
                    reservationState: "cancelling" as const,
                  })
                ),
                markCancelled,
                markCancellationFailed,
              }),
              analytics.layer,
              Layer.mock(DotyposService, {
                getReservationStatus,
                cancelReservation,
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    expect(summary).toEqual({ cancelled: 2, skipped: 1, failed: 1 });
    expect(getReservationStatus).toHaveBeenCalledTimes(orders.length);
    expect(cancelReservation.mock.calls).toEqual([
      [holdOf("reservation-sweep-new")],
    ]);
    expect(markCancelled.mock.calls.map(([marker]) => marker.id)).toEqual([
      "reservation-sweep-new",
      "reservation-sweep-cancelled",
    ]);
    expect(markCancellationFailed.mock.calls.map(([marker]) => marker)).toEqual(
      [
        {
          id: workspaceReservationIdSchema.make(
            "0198c1a2-9857-77d2-8d7f-92c5539c944f"
          ),
          claimedAt: claimStamp,
          failureCode: "dotypos_cancel_failed",
        },
        {
          id: workspaceReservationIdSchema.make(
            "0198c1a2-ff26-7e37-87c0-67407bb1b189"
          ),
          claimedAt: claimStamp,
          failureCode: "dotypos_cancel_failed",
        },
      ]
    );
    expect(
      analytics.messages
        .filter(({ event }) => event === "reservation abandoned")
        .map(({ distinctId }) => distinctId)
    ).toEqual([
      PostHogDistinctId.make("reservation-sweep-new"),
      PostHogDistinctId.make("reservation-sweep-cancelled"),
    ]);
  });
});
