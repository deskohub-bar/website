import "@/shared/polyfills/temporal";
import { NoReservationInvitees } from "@/features/reservation-invitees/backend/reservation-invitees.test-utils";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposReservationIdSchema,
  DotyposService,
  DotyposTableSchema,
} from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Schema } from "effect";
import type { LatePaymentRecoveryState } from "@/db/schema";
import {
  type PaymentAttemptId,
  paymentAttemptIdSchema,
} from "@/features/checkout/checkout-identifiers";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { ReservationRecords } from "@/features/reservation/backend/reservation-records";
import { SeatingMapReleaseGate } from "@/features/reservation/backend/seating-map-release-gate";
import {
  type WorkspaceReservation,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import {
  dotyposHoldFixture,
  workspaceReservationFixture,
} from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { ReviewSandboxMock } from "@/features/review-accounts/backend/review-sandbox.service.mock";
import { dotyposCustomerFixture } from "@/shared/testing/dotypos-customer.test-utils";
import { pendingNexiAttemptFixture } from "../holds/reservation-hold-cleanup.test-utils";
import { LatePaymentVerificationService } from "../payment/late-payment-verification.service";
import { ProviderPaymentFinalizationService } from "../payment/provider-payment-finalization.service";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import {
  type PaymentAttempt,
  PaymentAttemptRepository,
} from "../repositories/payment-attempt.repository";
import { CheckoutStatusService } from "./checkout-status.service";
import {
  observePaymentPagesAs,
  testReservationPaymentWindow,
} from "./payment-page-provider-status.test-utils";

import { latePaymentRecoveryFixture } from "./testing/checkout-payment-fixture";

const testEmailAddressForLate = testEmailAddress("late");

const createdAt = Temporal.Instant.from("2026-06-01T10:00:00Z");
const reservationId = workspaceReservationIdSchema.make(
  "0198c1a2-4e99-7263-8b3c-c431ca140117"
);
const attemptId = paymentAttemptIdSchema.make("late-attempt");
const oldAttemptId = paymentAttemptIdSchema.make("old-attempt");
const customerId = DotyposCustomerIdSchema.make("customer-id");
const originalDotyposReservationId =
  DotyposReservationIdSchema.make("dotypos-original");
const confirmedDotyposReservationId =
  DotyposReservationIdSchema.make("dotypos-confirmed");

const reservationFixture = workspaceReservationFixture({
  id: reservationId,
  dotyposCustomerId: customerId,
  dotyposReservationId: originalDotyposReservationId,
  locale: "en-US",
  reservationState: "cancelled",
  paymentState: "expired",
  fulfillmentState: "not_started",
  activePaymentAttemptId: attemptId,
  reservationCreatedAt: createdAt,
  reservationConfirmedAt: null,
  reservationCancelledAt: createdAt,
  cancellationCause: "hold_expired",
  paidAt: null,
  fulfilledAt: null,
  createdAt,
  updatedAt: createdAt,
});

const openTable = Schema.decodeSync(DotyposTableSchema)({
  _cloudId: "cloud-id",
  display: true,
  enabled: true,
  id: "open-table",
  name: "9",
  locationName: "Open space",
  tags: ["cowork:open-space"],
});

const makeHarness = (options: {
  readonly reservation?: Partial<WorkspaceReservation>;
  readonly recovery?: {
    readonly state: LatePaymentRecoveryState;
    readonly paymentAttemptId?: PaymentAttemptId;
  };
  readonly finalizationResult?: "not_pending" | "paid" | "pending";
}) => {
  const reservation = { ...reservationFixture, ...options.reservation };
  const recovery = options.recovery;
  const recoveryRow = recovery
    ? latePaymentRecoveryFixture({
        paymentAttemptId: recovery.paymentAttemptId ?? attemptId,
        workspaceReservationId: reservationId,
        originalDotyposReservationId,
        verifiedPaidAt: createdAt,
        ...(recovery.state === "recovered"
          ? {
              state: recovery.state,
              recoveredDotyposReservationId: confirmedDotyposReservationId,
            }
          : { state: recovery.state }),
      })
    : null;
  const displayableAttempt: PaymentAttempt | null =
    reservation.paymentState === "paid"
      ? {
          ...pendingNexiAttemptFixture(reservationId, attemptId, createdAt),
          state: "paid",
          refundState:
            recoveryRow?.paymentAttemptId === attemptId &&
            recoveryRow.state === "refund_required"
              ? "required"
              : "not_required",
        }
      : null;
  const startRecoveryIfSettled = mock(() =>
    Effect.succeed("recovery_started" as const)
  );
  const layer = CheckoutStatusService.Default.pipe(
    Layer.provide(testReservationPaymentWindow()),
    Layer.provide(NoReservationInvitees),
    Layer.provide(observePaymentPagesAs("unknown").layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderPaymentFinalizationService, {
          finalizePendingProviderPayment: mock(() =>
            Effect.succeed(options.finalizationResult ?? "not_pending")
          ),
        }),
        Layer.mock(WorkspaceReservationRepository, {
          findById: mock(() => Effect.succeed(reservation)),
        }),
        Layer.mock(PaymentAttemptRepository, {
          findDisplayableForReservation: mock(() =>
            Effect.succeed(displayableAttempt)
          ),
        }),
        Layer.mock(LatePaymentRecoveryRepository, {
          findLatestByWorkspaceReservationId: mock(() =>
            Effect.succeed(recoveryRow)
          ),
        }),
        Layer.mock(LatePaymentVerificationService, { startRecoveryIfSettled }),
        ReservationRecords.Provider.pipe(
          Layer.provideMerge(
            Layer.mock(DotyposService, {
              listActiveReservationsOverlapping: () => Effect.succeed([]),
              getReservationWithoutCustomer: mock<
                DotyposService["Service"]["getReservationWithoutCustomer"]
              >((id) =>
                Effect.succeed({
                  ...dotyposHoldFixture(id),
                  _customerId: customerId,
                  _tableId: openTable.id,
                  startDate: "2026-06-20T00:00:00.000+02:00",
                  endDate: "2026-06-20T17:00:00.000+02:00",
                  seats: "1",
                  status:
                    id === confirmedDotyposReservationId
                      ? "CONFIRMED"
                      : "CANCELLED",
                })
              ),
              getCustomer: mock(() =>
                Effect.succeedSome(
                  dotyposCustomerFixture(customerId, {
                    email: testEmailAddressForLate,
                  })
                )
              ),
            })
          )
        ),
        Layer.mock(AdvisoryAvailabilityInventory, {
          tables: Effect.succeed([openTable]),
        }),
        SeatingMapReleaseGate.fromDecision(true),
        ReviewSandboxMock({})
      )
    )
  );
  const getStatus = () =>
    Effect.gen(function* () {
      const service = yield* CheckoutStatusService;
      return yield* service.getStatus({
        orderId: reservationId,
        returnOutcome: "success",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);
  const refreshStatus = () =>
    Effect.gen(function* () {
      const service = yield* CheckoutStatusService;
      return yield* service.refreshStatus({
        orderId: reservationId,
        returnOutcome: "success",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);
  return { getStatus, refreshStatus, startRecoveryIfSettled };
};

const refundedReservation: Partial<WorkspaceReservation> = {
  paymentState: "paid",
  paidAt: createdAt,
  fulfillmentState: "not_started",
  failureCode: "late_payment_reservation_unavailable",
};

describe("CheckoutStatusService for late payments", () => {
  test("tells the customer a late payment that needs a refund will be refunded", async () => {
    const status = await makeHarness({
      reservation: refundedReservation,
      recovery: { state: "refund_required" },
    }).getStatus();

    expect(status.status).toBe("late_payment_refund");
    expect(status).not.toHaveProperty("table");
    expect(status).not.toHaveProperty("tableMap");
  });

  for (const state of ["pending", "processing"] as const) {
    test(`shows a ${state} late-payment recovery as being checked`, async () => {
      const status = await makeHarness({
        recovery: { state },
      }).getStatus();

      expect(status.status).toBe("late_payment_checking");
      expect(status).not.toHaveProperty("tableMap");
    });
  }

  test("shows a late payment awaiting operator review truthfully", async () => {
    const status = await makeHarness({
      reservation: { paymentState: "paid", paidAt: createdAt },
      recovery: { state: "review_required" },
    }).getStatus();

    expect(status.status).toBe("late_payment_review");
    expect(status).toMatchObject({
      supportContactPrefill: { email: testEmailAddressForLate },
    });
  });

  test("does not prefill support contact for a refund the customer need not chase", async () => {
    const status = await makeHarness({
      reservation: refundedReservation,
      recovery: { state: "refund_required" },
    }).getStatus();

    expect(status).toMatchObject({ supportContactPrefill: undefined });
  });

  test("shows a recovered late payment as an ordinary confirmed reservation", async () => {
    const status = await makeHarness({
      reservation: {
        dotyposReservationId: confirmedDotyposReservationId,
        reservationState: "confirmed",
        paymentState: "paid",
        paidAt: createdAt,
        reservationConfirmedAt: createdAt,
        reservationCancelledAt: null,
        cancellationCause: null,
        fulfillmentState: "fulfilled",
        fulfilledAt: createdAt,
      },
      recovery: { state: "recovered" },
    }).getStatus();

    expect(status.status).toBe("fulfilled");
  });

  test("keeps a reservation paid by its active attempt confirmed when a superseded attempt needs a refund", async () => {
    const status = await makeHarness({
      reservation: {
        dotyposReservationId: confirmedDotyposReservationId,
        reservationState: "confirmed",
        paymentState: "paid",
        paidAt: createdAt,
        reservationConfirmedAt: createdAt,
        reservationCancelledAt: null,
        cancellationCause: null,
        fulfillmentState: "fulfilled",
        fulfilledAt: createdAt,
      },
      recovery: { state: "refund_required", paymentAttemptId: oldAttemptId },
    }).getStatus();

    expect(status.status).toBe("fulfilled");
  });

  test("shows a refund for a superseded attempt when the reservation was not otherwise paid", async () => {
    const status = await makeHarness({
      reservation: { paymentState: "expired" },
      recovery: { state: "refund_required", paymentAttemptId: oldAttemptId },
    }).getStatus();

    expect(status.status).toBe("late_payment_refund");
  });

  test("verifies a terminal attempt with the provider on refresh", async () => {
    const harness = makeHarness({ finalizationResult: "not_pending" });

    await harness.refreshStatus();

    expect(harness.startRecoveryIfSettled).toHaveBeenCalledWith({
      orderId: "0198c1a2-4e99-7263-8b3c-c431ca140117",
      verificationDeadline: expect.anything(),
    });
  });

  test("does not look for a late payment while the payment is still pending", async () => {
    const harness = makeHarness({ finalizationResult: "pending" });

    await harness.refreshStatus();

    expect(harness.startRecoveryIfSettled).not.toHaveBeenCalled();
  });
});
