import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  type CreateDotyposReservationInput,
  DotyposCustomerIdSchema,
  type DotyposReservationId,
  DotyposReservationIdSchema,
  DotyposService,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { Effect, Layer, Schema } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import type {
  LatePaymentRecovery,
  LatePaymentRecoveryState,
} from "@/db/schema";
import { accountingDocumentSnapshotSchema } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import {
  makeCoworkInvoiceDocument,
  makeMeetingRoomInvoiceDocument,
} from "@/features/accounting/invoice.test-utils";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { DiscountClaimError } from "@/features/discounts/errors";
import {
  WorkspaceAvailabilityService,
  WorkspaceTableUnavailableError,
} from "@/features/reservation/backend/workspace-availability.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import {
  dotyposCreatedReservationFixture,
  dotyposHoldFixture,
  workspaceReservationFixture,
} from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { ReservationFulfillment } from "../fulfillment/reservation-fulfillment.service";
import { UnpaidHoldRelease } from "../holds/unpaid-hold-release.service";
import {
  LatePaymentRecoveryRepository,
  LatePaymentRecoveryStateError,
  OriginalHoldNotReusableError,
} from "../repositories/late-payment-recovery.repository";
import {
  TableAssignmentUnavailableError,
  WorkspaceTableAssignmentService,
} from "../reservation/workspace-table-assignment.service";
import {
  LatePaymentRecoveryService,
  latePaymentRecoveryMaxExecutionSeconds,
} from "./late-payment-recovery.service";

type OriginalHoldStatus = "NEW" | "CONFIRMED" | "CANCELLED";

const paymentAttemptId = paymentAttemptIdSchema.make("attempt-id");
const reservationId = workspaceReservationIdSchema.make("reservation-id");
const originalReservationId = DotyposReservationIdSchema.make(
  "dotypos-reservation-id"
);
const customerId = DotyposCustomerIdSchema.make("dotypos-customer-id");
const recoveryCreatedAt = Temporal.Instant.from("2026-01-01T00:00:00Z");
const recovery: LatePaymentRecovery = {
  paymentAttemptId,
  workspaceReservationId: reservationId,
  originalDotyposReservationId: originalReservationId,
  recoveredDotyposReservationId: null,
  webhookEventId: null,
  providerOperationId: null,
  providerStatus: "EXECUTED",
  state: "pending",
  failureCode: null,
  verifiedPaidAt: recoveryCreatedAt,
  claimedAt: null,
  completedAt: null,
  createdAt: recoveryCreatedAt,
  updatedAt: recoveryCreatedAt,
};

type Recoveries = LatePaymentRecoveryRepository["Service"];
type EnsureAvailable =
  WorkspaceAvailabilityService["Service"]["ensureAvailable"];
type AssignTableId =
  WorkspaceTableAssignmentService["Service"]["assignTableId"];

/**
 * Wires the recovery service to stateful fakes so each test can assert the
 * order in which the original hold is released and the reservation recreated.
 */
const makeRecoveryHarness = (options: {
  readonly reservation: ReturnType<typeof workspaceReservationFixture>;
  readonly originalStatus: OriginalHoldStatus;
  /** False when another run holds a fresh processing claim. */
  readonly claimed?: boolean;
  readonly newerReservation?: boolean;
  /** A newer reservation wins between recreation and settlement. */
  readonly supersededAtSettlement?: boolean;
  /** A replacement an interrupted earlier run already created in Dotypos. */
  readonly resumedReplacementId?: string;
  readonly ensureAvailable?: EnsureAvailable;
  readonly assignTableId?: AssignTableId;
  /** The paid checkout's accounting document; a cowork one by default. */
  readonly invoiceDocument?: ReturnType<typeof makeMeetingRoomInvoiceDocument>;
  readonly completeUsingOriginalReservation?: Recoveries["completeUsingOriginalReservation"];
}) => {
  const events: string[] = [];
  let reservation = { ...options.reservation };
  let recoveryState: LatePaymentRecoveryState = "pending";
  let settlementAttempted = false;
  const settleAs = <Input>(
    state: Extract<
      LatePaymentRecoveryState,
      "recovered" | "refund_required" | "review_required"
    >
  ) =>
    mock((_input: Input) =>
      Effect.sync(() => {
        events.push(
          state === "recovered" ? "completeWithReplacement" : `settle:${state}`
        );
        recoveryState = state;
      })
    );
  const spies = {
    claim: mock<Recoveries["claim"]>(() =>
      Effect.succeed(
        options.claimed === false ? null : { ...recovery, state: "processing" }
      )
    ),
    completeUsingOriginalReservation: mock<
      Recoveries["completeUsingOriginalReservation"]
    >((input) => {
      events.push("completeUsingOriginalReservation");
      return (
        options.completeUsingOriginalReservation?.(input) ??
        Effect.sync(() => {
          recoveryState = "recovered";
        })
      );
    }),
    completeWithReplacement: options.supersededAtSettlement
      ? mock<Recoveries["completeWithReplacement"]>(() => {
          events.push("completeWithReplacement");
          settlementAttempted = true;
          return Effect.fail(
            new LatePaymentRecoveryStateError({
              operation: "settle",
              paymentAttemptId,
              message: "A newer reservation prevents recovery.",
            })
          );
        })
      : settleAs<Parameters<Recoveries["completeWithReplacement"]>[0]>(
          "recovered"
        ),
    requireRefund:
      settleAs<Parameters<Recoveries["requireRefund"]>[0]>("refund_required"),
    requireReview:
      settleAs<Parameters<Recoveries["requireReview"]>[0]>("review_required"),
    claimCancellation: mock(() =>
      Effect.sync(() => {
        events.push("claimCancellation");
        reservation = { ...reservation, reservationState: "cancelling" };
        return reservation;
      })
    ),
    markCancelled: mock(() =>
      Effect.sync(() => {
        events.push("markCancelled");
        reservation = { ...reservation, reservationState: "cancelled" };
      })
    ),
    markCancellationFailed: mock(() =>
      Effect.sync(() => {
        events.push("markCancellationFailed");
        reservation = {
          ...reservation,
          reservationState: "cancellation_failed",
        };
      })
    ),
    getReservationStatus: mock(() =>
      Effect.sync(() => {
        events.push("getReservationStatus");
        return options.originalStatus;
      })
    ),
    cancelReservation: mock((id: DotyposReservationId) => {
      events.push(`cancelReservation:${id}`);
      return Effect.void;
    }),
    ensureAvailable: mock<EnsureAvailable>((...args) => {
      events.push("ensureAvailable");
      return options.ensureAvailable?.(...args) ?? Effect.void;
    }),
    assignTableId: mock<AssignTableId>((...args) => {
      events.push("assignTableId");
      return (
        options.assignTableId?.(...args) ??
        Effect.succeed(DotyposTableIdSchema.make("table-id"))
      );
    }),
    createReservation: mock((input: CreateDotyposReservationInput) => {
      events.push("createReservation");
      return Effect.succeed(
        dotyposCreatedReservationFixture("replacement-id", input)
      );
    }),
    fulfillPaidOrder: mock(() => {
      events.push("fulfillPaidOrder");
      return Effect.void;
    }),
  };
  const snapshot = Schema.decodeUnknownSync(accountingDocumentSnapshotSchema)({
    ...(options.invoiceDocument ?? makeCoworkInvoiceDocument("en-US")),
    workspaceReservationId: reservationId,
    dotyposReservationId: originalReservationId,
    dotyposCustomerId: customerId,
  });
  const layer = LatePaymentRecoveryService.Default.pipe(
    Layer.provide(UnpaidHoldRelease.Default),
    Layer.provide(makeRecordingAdvisoryLock().layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(LatePaymentRecoveryRepository, {
          findByPaymentAttemptId: mock(() =>
            Effect.sync(() => ({ ...recovery, state: recoveryState }))
          ),
          claim: spies.claim,
          hasNewerActiveReservation: mock(() =>
            Effect.sync(
              () => (options.newerReservation ?? false) || settlementAttempted
            )
          ),
          completeUsingOriginalReservation:
            spies.completeUsingOriginalReservation,
          completeWithReplacement: spies.completeWithReplacement,
          requireRefund: spies.requireRefund,
          requireReview: spies.requireReview,
        }),
        Layer.mock(WorkspaceReservationRepository, {
          hasAttachedOpenSpaceMove: () => Effect.succeed(false),
          findById: mock(() => Effect.sync(() => reservation)),
          claimCancellation: spies.claimCancellation,
          markCancelled: spies.markCancelled,
          markCancellationFailed: spies.markCancellationFailed,
        }),
        Layer.mock(AccountingDocumentSnapshots, {
          find: mock(() => Effect.succeed(snapshot)),
        }),
        Layer.mock(WorkspaceAvailabilityService, {
          ensureAvailable: spies.ensureAvailable,
        }),
        Layer.mock(DotyposService, {
          getReservationStatus: spies.getReservationStatus,
          cancelReservation: spies.cancelReservation,
          listActiveReservationsOverlapping: mock(() =>
            Effect.succeed(
              options.resumedReplacementId
                ? [
                    {
                      ...dotyposHoldFixture(options.resumedReplacementId),
                      status: "CONFIRMED" as const,
                      note: `Payment order: ${reservationId}`,
                    },
                  ]
                : []
            )
          ),
          createReservation: spies.createReservation,
        }),
        Layer.mock(WorkspaceTableAssignmentService, {
          assignTableId: spies.assignTableId,
        }),
        Layer.mock(ReservationFulfillment, {
          run: spies.fulfillPaidOrder,
        })
      )
    )
  );
  const recover = () =>
    Effect.gen(function* () {
      const service = yield* LatePaymentRecoveryService;
      return yield* service.recover({
        paymentAttemptId,
      });
    }).pipe(Effect.provide(layer), Effect.result, Effect.runPromise);
  return { events, recover, spies };
};

const coworkReservation = workspaceReservationFixture({
  id: reservationId,
  activePaymentAttemptId: paymentAttemptId,
  dotyposCustomerId: customerId,
  dotyposReservationId: originalReservationId,
  paymentState: "pending",
  fulfillmentState: "not_started",
  reservationConfirmedAt: null,
  paidAt: null,
  fulfilledAt: null,
  reservationDetails: { kind: "cowork", entryTier: "basic", coffee: true },
});

const expiredHeldReservation: typeof coworkReservation = {
  ...coworkReservation,
  reservationState: "held",
  reservationHoldExpiresAt: Temporal.Now.instant().subtract({ minutes: 20 }),
  updatedAt: Temporal.Now.instant().subtract({ minutes: 20 }),
};

const currentHeldReservation: typeof coworkReservation = {
  ...coworkReservation,
  reservationState: "held",
  reservationHoldExpiresAt: Temporal.Now.instant().add({ minutes: 5 }),
  updatedAt: Temporal.Now.instant(),
};

const releaseEvents = [
  "getReservationStatus",
  "claimCancellation",
  "cancelReservation:dotypos-reservation-id",
  "markCancelled",
];

const recreationEvents = [
  "ensureAvailable",
  "assignTableId",
  "createReservation",
  "completeWithReplacement",
  "fulfillPaidOrder",
];

describe("LatePaymentRecoveryService with an expired or released hold", () => {
  test("releases an expired hold that Dotypos still reports NEW and runs normal reservation creation", async () => {
    const harness = makeRecoveryHarness({
      reservation: expiredHeldReservation,
      originalStatus: "NEW",
    });

    const result = await harness.recover();

    expect(result).toMatchObject({ _tag: "Success", success: "recovered" });
    expect(
      harness.spies.completeUsingOriginalReservation
    ).not.toHaveBeenCalled();
    expect(harness.events).toEqual([...releaseEvents, ...recreationEvents]);
    expect(harness.spies.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CONFIRMED", tableId: "table-id" })
    );
    expect(harness.spies.completeWithReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveredDotyposReservationId: "replacement-id",
        reservationState: "confirmed",
      })
    );
  });

  test("recreates an early-setup meeting room from its setup start", async () => {
    const harness = makeRecoveryHarness({
      reservation: {
        ...expiredHeldReservation,
        reservationDetails: {
          kind: "meeting-room",
          duration: { unit: "hour", amount: 4 },
          earlySetup: true,
        },
      },
      originalStatus: "NEW",
      // Booked 08:00–12:00 UTC.
      invoiceDocument: makeMeetingRoomInvoiceDocument("en-US"),
    });

    const result = await harness.recover();

    expect(result).toMatchObject({ _tag: "Success", success: "recovered" });
    // Availability checks the occupied interval of an early-setup booking.
    expect(harness.spies.ensureAvailable).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "meeting-room",
        startsAt: "2099-02-03T08:00:00Z",
        endsAt: "2099-02-03T12:00:00Z",
        earlySetup: true,
      })
    );
    expect(harness.spies.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: new Date("2099-02-03T07:45:00Z"),
        endDate: new Date("2099-02-03T12:00:00Z"),
      })
    );
  });

  test("requires a refund when the slot of an expired hold was taken", async () => {
    const harness = makeRecoveryHarness({
      reservation: expiredHeldReservation,
      originalStatus: "NEW",
      ensureAvailable: () =>
        Effect.fail(
          new WorkspaceTableUnavailableError({
            date: "2099-01-01",
            reservation: { kind: "cowork", entryTier: "basic" },
          })
        ),
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.events).toEqual([
      ...releaseEvents,
      "ensureAvailable",
      "settle:refund_required",
    ]);
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "late_payment_reservation_unavailable",
      })
    );
  });

  test("requires a refund when table assignment finds no free table", async () => {
    const harness = makeRecoveryHarness({
      reservation: expiredHeldReservation,
      originalStatus: "NEW",
      assignTableId: () =>
        Effect.fail(
          new TableAssignmentUnavailableError({
            requiredTags: ["tier:basic"],
            message:
              "No available Dotypos workspace table matches tags: tier:basic",
          })
        ),
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.spies.createReservation).not.toHaveBeenCalled();
    expect(harness.spies.fulfillPaidOrder).not.toHaveBeenCalled();
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "late_payment_reservation_unavailable",
      })
    );
  });

  test("releases and recreates a hold whose cleanup cancellation failed", async () => {
    const harness = makeRecoveryHarness({
      reservation: {
        ...currentHeldReservation,
        reservationState: "cancellation_failed",
      },
      originalStatus: "NEW",
    });

    const result = await harness.recover();

    expect(result).toMatchObject({ _tag: "Success", success: "recovered" });
    expect(
      harness.spies.completeUsingOriginalReservation
    ).not.toHaveBeenCalled();
    expect(harness.events).toEqual([...releaseEvents, ...recreationEvents]);
  });

  test("recreates a cancellation-failed hold that Dotypos already reports cancelled", async () => {
    const harness = makeRecoveryHarness({
      reservation: {
        ...currentHeldReservation,
        reservationState: "cancellation_failed",
      },
      originalStatus: "CANCELLED",
    });

    const result = await harness.recover();

    expect(result).toMatchObject({ _tag: "Success", success: "recovered" });
    expect(harness.events).toEqual([
      "getReservationStatus",
      "claimCancellation",
      "markCancelled",
      ...recreationEvents,
    ]);
    expect(harness.spies.completeWithReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveredDotyposReservationId: "replacement-id",
      })
    );
  });

  test("reuses a current hold without releasing it", async () => {
    const harness = makeRecoveryHarness({
      reservation: currentHeldReservation,
      originalStatus: "NEW",
    });

    const result = await harness.recover();

    expect(result).toMatchObject({ _tag: "Success", success: "recovered" });
    expect(harness.events).toEqual([
      "getReservationStatus",
      "completeUsingOriginalReservation",
      "fulfillPaidOrder",
    ]);
    // A processing claim only counts as stale once a run could have finished.
    const { staleProcessingBefore } = requireValue(
      harness.spies.claim.mock.calls[0]?.[0],
      "late-payment recovery claim input"
    );
    expect(
      Temporal.Now.instant().since(staleProcessingBefore).total("seconds")
    ).toBeGreaterThan(latePaymentRecoveryMaxExecutionSeconds);
  });

  test("continues through release and recreation when the hold deadline passes during reuse", async () => {
    // 61 s remained at the first check, 59 s at the locked settlement.
    const harness = makeRecoveryHarness({
      reservation: currentHeldReservation,
      originalStatus: "NEW",
      completeUsingOriginalReservation: () =>
        Effect.fail(
          new OriginalHoldNotReusableError({
            paymentAttemptId,
            message: "The hold reached its reuse margin.",
          })
        ),
    });

    const result = await harness.recover();

    expect(result).toMatchObject({ _tag: "Success", success: "recovered" });
    expect(harness.events).toEqual([
      "getReservationStatus",
      "completeUsingOriginalReservation",
      ...releaseEvents,
      ...recreationEvents,
    ]);
    expect(harness.spies.requireRefund).not.toHaveBeenCalled();
  });

  test("keeps other settlement conflicts during reuse retryable", async () => {
    const harness = makeRecoveryHarness({
      reservation: currentHeldReservation,
      originalStatus: "NEW",
      completeUsingOriginalReservation: () =>
        Effect.fail(
          new LatePaymentRecoveryStateError({
            operation: "settle",
            paymentAttemptId,
            message: "A newer reservation prevents recovery.",
          })
        ),
    });

    const result = await harness.recover();

    expect(result._tag).toBe("Failure");
    expect(harness.spies.cancelReservation).not.toHaveBeenCalled();
    expect(harness.spies.requireRefund).not.toHaveBeenCalled();
    expect(harness.spies.fulfillPaidOrder).not.toHaveBeenCalled();
  });

  test("releases the original hold before refunding a superseded checkout reservation", async () => {
    const harness = makeRecoveryHarness({
      reservation: currentHeldReservation,
      originalStatus: "NEW",
      newerReservation: true,
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.events).toEqual([
      ...releaseEvents,
      "settle:refund_required",
    ]);
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "late_payment_newer_reservation" })
    );
  });

  test("releases a current hold before refunding an unavailable discount", async () => {
    const harness = makeRecoveryHarness({
      reservation: currentHeldReservation,
      originalStatus: "NEW",
      completeUsingOriginalReservation: () =>
        Effect.fail(
          new DiscountClaimError({
            operation: "redeem",
            reason: "usage_limit_reached",
            message: "The code has no remaining uses.",
          })
        ),
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.events).toEqual([
      "getReservationStatus",
      "completeUsingOriginalReservation",
      ...releaseEvents,
      "settle:refund_required",
    ]);
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "late_payment_discount_unavailable",
      })
    );
  });
});

describe("LatePaymentRecoveryService settlement decisions", () => {
  test("keeps a fresh processing claim retryable", async () => {
    const harness = makeRecoveryHarness({
      reservation: currentHeldReservation,
      originalStatus: "NEW",
      claimed: false,
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LatePaymentRecoveryError" },
    });
    expect(harness.events).toEqual([]);
  });

  test("requires a refund instead of recreating an operator force-cancelled reservation", async () => {
    const harness = makeRecoveryHarness({
      reservation: {
        ...currentHeldReservation,
        reservationState: "cancelled",
        failureCode: "admin_forced_payment_cancellation",
      },
      originalStatus: "CANCELLED",
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.events).toEqual(["settle:refund_required"]);
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "late_payment_after_administration_cancellation",
      })
    );
  });

  test("requires a refund without disturbing a newer active payment attempt", async () => {
    const harness = makeRecoveryHarness({
      reservation: {
        ...currentHeldReservation,
        activePaymentAttemptId: paymentAttemptIdSchema.make("newer-attempt-id"),
      },
      originalStatus: "NEW",
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.events).toEqual(["settle:refund_required"]);
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "late_payment_superseded_attempt",
      })
    );
  });

  test("requires a refund when the purchased historical Profi monitor setup is unavailable", async () => {
    const harness = makeRecoveryHarness({
      reservation: {
        ...coworkReservation,
        reservationDetails: {
          kind: "cowork",
          entryTier: "profi",
          coffee: true,
          monitorOption: "2x27-qhd",
        },
        reservationState: "cancelled",
        reservationHoldExpiresAt: Temporal.Now.instant(),
        updatedAt: Temporal.Now.instant(),
      },
      originalStatus: "CANCELLED",
      ensureAvailable: () =>
        Effect.fail(
          new WorkspaceTableUnavailableError({
            date: "2099-01-01",
            reservation: {
              kind: "cowork",
              entryTier: "profi",
              monitorOption: "2x27-qhd",
            },
          })
        ),
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.spies.ensureAvailable).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cowork",
        entryTier: "profi",
        monitorOption: "2x27-qhd",
      })
    );
    expect(harness.events).toEqual([
      "ensureAvailable",
      "settle:refund_required",
    ]);
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "late_payment_reservation_unavailable",
      })
    );
  });

  test("cancels a resumed replacement when a newer reservation wins before settlement", async () => {
    const harness = makeRecoveryHarness({
      reservation: {
        ...currentHeldReservation,
        reservationState: "cancelled",
      },
      originalStatus: "CANCELLED",
      resumedReplacementId: "replacement-id",
      supersededAtSettlement: true,
    });

    const result = await harness.recover();

    expect(result).toMatchObject({
      _tag: "Success",
      success: "refund_required",
    });
    expect(harness.events).toEqual([
      "completeWithReplacement",
      "cancelReservation:replacement-id",
      "settle:refund_required",
    ]);
    expect(harness.spies.requireRefund).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "late_payment_newer_reservation" })
    );
  });
});
