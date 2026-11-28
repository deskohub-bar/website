import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterEach, expect, mock, test } from "bun:test";
import {
  DotyposBranchIdSchema,
  DotyposCloudIdSchema,
  DotyposCustomerIdSchema,
  DotyposRejected,
  type DotyposReservation,
  type DotyposReservationBooking,
  DotyposReservationIdSchema,
  DotyposReservationNotRestorable,
  DotyposService,
  DotyposTableIdSchema,
  DotyposUnavailable,
  DotyposUncertain,
  DotyposVersionConflict,
  RestoreCancelledReservationResult,
} from "@deskohub/dotypos";
import { EmailServiceError } from "@deskohub/email/backend/service";
import { testEmailAddress } from "@deskohub/test-email";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Data, Effect, Layer, Logger, References } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { WorkspaceReservationEmailService } from "@/features/checkout/backend/fulfillment/workspace-reservation-email.service";
import {
  PaymentRefundReconciliationError,
  PaymentRefundService,
} from "@/features/checkout/backend/payment/payment-refund.service";
import { WorkspaceTableAssignmentService } from "@/features/checkout/backend/reservation/workspace-table-assignment.service";
import { checkoutSessionKeySchema } from "@/features/checkout/checkout-identifiers";
import {
  type WorkspaceReservation,
  WorkspaceReservationRepository,
  WorkspaceReservationSessionTakenError,
} from "@/features/reservation/backend/workspace-reservation.repository";
import {
  WorkspaceReservationDetailsError,
  WorkspaceReservationService,
} from "@/features/reservation/backend/workspace-reservation.service";
import {
  workspaceReservationDetailsFixture,
  workspaceReservationFixture,
} from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  type ReservationAccessGrant,
  ReservationAccessIssuanceError,
  ReservationAccessService,
} from "@/features/reservation-access";
import { reservationAccessGrantIdSchema } from "@/features/reservation-access/reservation-access";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";
import type { RestorationRefundAttempt } from "./reservation-restoration-refund";

// getRestorationBooking is a plain function, so the test swaps it per case and
// otherwise delegates, keeping every other importer on the real one.
const restorationBookingModule = await import(
  "@/features/checkout/backend/reservation/restoration-booking"
);
const realGetRestorationBooking =
  restorationBookingModule.getRestorationBooking;
let getRestorationBooking:
  | typeof restorationBookingModule.getRestorationBooking
  | undefined;
mock.module(
  "@/features/checkout/backend/reservation/restoration-booking",
  () => ({
    ...restorationBookingModule,
    getRestorationBooking: (
      input: Parameters<typeof realGetRestorationBooking>[0]
    ) => (getRestorationBooking ?? realGetRestorationBooking)(input),
  })
);
afterEach(() => {
  getRestorationBooking = undefined;
});

const { ReservationRestorationService } = await import(
  "./reservation-restoration.service"
);

const id = workspaceReservationIdSchema.make("reservation-restore");
const otherId = workspaceReservationIdSchema.make("reservation-successor");
const dotyposReservationId = DotyposReservationIdSchema.make("dotypos-restore");
const dotyposCustomerId = DotyposCustomerIdSchema.make("customer-restore");
const dotyposTableId = DotyposTableIdSchema.make("table-restore");
const cancelledAt = Temporal.Instant.from("2026-08-10T10:00:00Z");

const upcoming = {
  startDate: "2099-06-10T08:00:00Z",
  endDate: "2099-06-10T16:00:00Z",
};
const ended = {
  startDate: "2020-06-10T08:00:00Z",
  endDate: "2020-06-10T16:00:00Z",
};

const cancelledReservation: WorkspaceReservation = workspaceReservationFixture({
  id,
  checkoutSessionKey: checkoutSessionKeySchema.make("checkout-restore"),
  dotyposCustomerId,
  dotyposReservationId,
  reservationState: "cancelled",
  paymentState: "paid",
  failureCode: null,
  reservationConfirmedAt: Temporal.Instant.from("2026-08-01T10:00:00Z"),
  reservationCancelledAt: cancelledAt,
  reservationHoldExpiredAt: null,
  cancellationEmailSentAt: Temporal.Instant.from("2026-08-10T10:01:00Z"),
  reservationDetails: {
    kind: "cowork",
    entryTier: "open-space",
    coffee: false,
  },
});

const confirmedReservation: WorkspaceReservation = {
  ...cancelledReservation,
  reservationState: "confirmed",
  reservationCancelledAt: null,
  cancellationEmailSentAt: null,
};

const dotyposReservation = (
  input: Partial<DotyposReservation> = {}
): DotyposReservation => ({
  _branchId: DotyposBranchIdSchema.make("branch"),
  _cloudId: DotyposCloudIdSchema.make("cloud"),
  _customerId: dotyposCustomerId,
  _tableId: dotyposTableId,
  id: dotyposReservationId,
  seats: "1",
  status: "CANCELLED",
  ...upcoming,
  ...input,
});

const booking: DotyposReservationBooking = {
  customerId: dotyposCustomerId,
  tableId: dotyposTableId,
  startDate: new Date(upcoming.startDate),
  endDate: new Date(upcoming.endDate),
  seats: 1,
};

const details = workspaceReservationDetailsFixture({
  id,
  dotyposReservationId,
});

const accessGrant = (
  overrides: Partial<ReservationAccessGrant> = {}
): ReservationAccessGrant => ({
  id: reservationAccessGrantIdSchema.make("grant-restore"),
  reservationId: id,
  provider: "igloohome",
  credentialType: "algopin_hourly",
  deviceId: "EK1",
  state: "issued",
  providerCredentialId: null,
  accessName: "Deskohub grant-restore",
  scheduledAccessStartsAt: Temporal.Instant.from(upcoming.startDate),
  accessStartsAt: Temporal.Instant.from(upcoming.startDate),
  accessEndsAt: Temporal.Instant.from(upcoming.endDate),
  provisioningStartedAt: null,
  issuedAt: Temporal.Instant.from("2026-08-01T10:00:00Z"),
  failedAt: null,
  failureCode: null,
  createdAt: Temporal.Instant.from("2026-08-01T10:00:00Z"),
  updatedAt: Temporal.Instant.from("2026-08-01T10:00:00Z"),
  ...overrides,
});

const paidAttempt: RestorationRefundAttempt = {
  amountExponent: 2,
  amountValue: 45_000,
  currency: "CZK",
  refundState: "not_required",
  refundedAmountValue: null,
  state: "paid",
};

const refundedAttempt = (
  refundedAmountValue: number
): RestorationRefundAttempt => ({
  ...paidAttempt,
  refundState: "refunded",
  refundedAmountValue,
});

const queryError = () =>
  new EffectDrizzleQueryError({
    query: "select",
    params: [],
    cause: new Error("synthetic query failure"),
  });

const accessIssuanceError = () =>
  new ReservationAccessIssuanceError({
    reservationId: id,
    outcome: "rejected",
    message: "synthetic access failure",
  });

const emailError = () =>
  new EmailServiceError("synthetic email failure", undefined, undefined, {
    failureKind: "provider",
  });

const detailsError = () =>
  new WorkspaceReservationDetailsError({
    reservationId: id,
    errorCode: "dotypos_reservation_load_failed",
    message: "synthetic details failure",
  });

class TestRestorationBookingChanged extends Data.TaggedError(
  "RestorationBookingChanged"
)<{ readonly message: string }> {}

class TestRestorationBookingUnreadable extends Data.TaggedError(
  "RestorationBookingUnreadable"
)<{ readonly message: string; readonly cause?: unknown }> {}

const sessionTaken = () =>
  Effect.fail(
    new WorkspaceReservationSessionTakenError({
      reservationId: id,
      message: "checkout session taken",
    })
  );

/** No other active reservation at the preflight, then a successor holding the checkout session on every later read. */
const successorAfterPreflight = () => {
  let reads = 0;
  return () =>
    Effect.succeed(
      reads++ === 0 ? null : { ...cancelledReservation, id: otherId }
    );
};

type Fakes = {
  readonly reservations: readonly WorkspaceReservation[];
  readonly findById: WorkspaceReservationRepository["Service"]["findById"];
  readonly findCurrentByCheckoutSessionKey: WorkspaceReservationRepository["Service"]["findCurrentByCheckoutSessionKey"];
  readonly hasRecordedCancellation: WorkspaceReservationRepository["Service"]["hasRecordedCancellation"];
  readonly markAdministrationRestored: WorkspaceReservationRepository["Service"]["markAdministrationRestored"];
  readonly getReservationWithoutCustomer: DotyposService["Service"]["getReservationWithoutCustomer"];
  readonly restoreCancelledReservation: DotyposService["Service"]["restoreCancelledReservation"];
  readonly cancelReservation: DotyposService["Service"]["cancelReservation"];
  readonly loadGrant: ReservationAccessService["Service"]["loadGrant"];
  readonly prepareRestoredAccess: ReservationAccessService["Service"]["prepareRestoredAccess"];
  readonly issueRestoredAccess: ReservationAccessService["Service"]["issueRestoredAccess"];
  readonly reconcileReservationRefunds: PaymentRefundService["Service"]["reconcileReservationRefunds"];
  readonly getAssignedTableAvailability: WorkspaceTableAssignmentService["Service"]["getAssignedTableAvailability"];
  readonly getReservation: WorkspaceReservationService["Service"]["getReservation"];
  readonly sendRestorationEmail: WorkspaceReservationEmailService["Service"]["sendRestorationEmail"];
  readonly getRestorationBooking: typeof realGetRestorationBooking;
  readonly acknowledgeRefundedPayment: boolean;
  readonly sendRestorationEmailRequested: boolean;
  /** Fails the next SQL statement after the reservation write: the cancellation event's retraction. */
  readonly failRetraction: boolean;
};

/** Runs one restore over fakes, recording each call, the SQL its transaction ran, the order of both, and the levels it logged. */
const restoreWith = async (overrides: Partial<Fakes> = {}) => {
  const database = await makeRecordingWorkspaceDatabase();
  const events: { readonly name: string; readonly at: number }[] = [];
  /** Records when the fake runs, relative to the SQL statements so far. */
  const traced =
    <Args extends readonly unknown[], A, E, R>(
      name: string,
      fake: (...args: Args) => Effect.Effect<A, E, R>
    ) =>
    (...args: Args) =>
      Effect.sync(() => {
        events.push({ name, at: database.statements.length });
      }).pipe(Effect.andThen(() => fake(...args)));
  const queue = [...(overrides.reservations ?? [cancelledReservation])];
  const fakes: Omit<
    Fakes,
    | "reservations"
    | "acknowledgeRefundedPayment"
    | "sendRestorationEmailRequested"
    | "failRetraction"
  > = {
    findById: () =>
      Effect.succeed((queue.length > 1 ? queue.shift() : queue[0]) ?? null),
    findCurrentByCheckoutSessionKey: () => Effect.succeed(null),
    hasRecordedCancellation: () => Effect.succeed(true),
    markAdministrationRestored: () =>
      Effect.succeed({
        reservation: confirmedReservation,
        paymentAttempts: [paidAttempt],
      }),
    getReservationWithoutCustomer: () => Effect.succeed(dotyposReservation()),
    restoreCancelledReservation: () =>
      Effect.succeed(
        RestoreCancelledReservationResult.Restored({
          reservation: dotyposReservation({ status: "CONFIRMED" }),
        })
      ),
    cancelReservation: () => Effect.void,
    loadGrant: () => Effect.succeed(null),
    prepareRestoredAccess: () => Effect.succeed("issue"),
    issueRestoredAccess: () => Effect.succeed("issued"),
    reconcileReservationRefunds: () => Effect.succeed([paidAttempt]),
    getAssignedTableAvailability: () => Effect.succeed("available"),
    getReservation: () => Effect.succeed(details),
    sendRestorationEmail: () => Effect.void,
    getRestorationBooking: () => Effect.succeed(booking),
    ...overrides,
  };
  const markAdministrationRestored: Fakes["markAdministrationRestored"] =
    overrides.failRetraction
      ? (input) =>
          fakes
            .markAdministrationRestored(input)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  database.failNextQueriesWith(
                    new Error("events unavailable"),
                    1
                  )
                )
              )
            )
      : fakes.markAdministrationRestored;
  const calls = {
    findById: mock(fakes.findById),
    findCurrentByCheckoutSessionKey: mock(
      fakes.findCurrentByCheckoutSessionKey
    ),
    hasRecordedCancellation: mock(fakes.hasRecordedCancellation),
    markAdministrationRestored: mock(
      traced("markAdministrationRestored", markAdministrationRestored)
    ),
    getReservationWithoutCustomer: mock(fakes.getReservationWithoutCustomer),
    restoreCancelledReservation: mock(
      traced("restoreCancelledReservation", fakes.restoreCancelledReservation)
    ),
    cancelReservation: mock(
      traced("cancelReservation", fakes.cancelReservation)
    ),
    loadGrant: mock(fakes.loadGrant),
    prepareRestoredAccess: mock(
      traced("prepareRestoredAccess", fakes.prepareRestoredAccess)
    ),
    issueRestoredAccess: mock(
      traced("issueRestoredAccess", fakes.issueRestoredAccess)
    ),
    reconcileReservationRefunds: mock(fakes.reconcileReservationRefunds),
    getAssignedTableAvailability: mock(fakes.getAssignedTableAvailability),
    getReservation: mock(fakes.getReservation),
    sendRestorationEmail: mock(
      traced("sendRestorationEmail", fakes.sendRestorationEmail)
    ),
    getRestorationBooking: mock(fakes.getRestorationBooking),
  };
  getRestorationBooking = calls.getRestorationBooking;

  const logs: { readonly level: string; readonly annotations: object }[] = [];
  const result = await Effect.gen(function* () {
    const service = yield* ReservationRestorationService;
    return yield* service.restore({
      actor: {
        source: "assistant",
        administrator: {
          accountId: customerAccountIdSchema.make("restore-operator"),
          email: testEmailAddress("restore-operator"),
        },
      },
      reservationId: id,
      acknowledgeRefundedPayment: overrides.acknowledgeRefundedPayment ?? false,
      sendRestorationEmail: overrides.sendRestorationEmailRequested ?? true,
    });
  }).pipe(
    Effect.provide(
      ReservationRestorationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            database.layer,
            makeRecordingAdvisoryLock().layer,
            Layer.mock(AccountingDocumentSnapshots, {}),
            Layer.mock(DotyposService, {
              getReservationWithoutCustomer:
                calls.getReservationWithoutCustomer,
              restoreCancelledReservation: calls.restoreCancelledReservation,
              cancelReservation: calls.cancelReservation,
            }),
            Layer.mock(WorkspaceReservationEmailService, {
              sendRestorationEmail: calls.sendRestorationEmail,
            }),
            Layer.mock(PaymentRefundService, {
              reconcileReservationRefunds: calls.reconcileReservationRefunds,
            }),
            Layer.mock(WorkspaceReservationRepository, {
              findById: calls.findById,
              findCurrentByCheckoutSessionKey:
                calls.findCurrentByCheckoutSessionKey,
              hasRecordedCancellation: calls.hasRecordedCancellation,
              markAdministrationRestored: calls.markAdministrationRestored,
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: calls.getReservation,
            }),
            Layer.mock(WorkspaceTableAssignmentService, {
              getAssignedTableAvailability: calls.getAssignedTableAvailability,
            }),
            Layer.mock(ReservationAccessService, {
              loadGrant: calls.loadGrant,
              prepareRestoredAccess: calls.prepareRestoredAccess,
              issueRestoredAccess: calls.issueRestoredAccess,
            })
          )
        )
      )
    ),
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          logs.push({
            level: options.logLevel,
            annotations: options.fiber.getRef(References.CurrentLogAnnotations),
          });
        }),
      ])
    ),
    Effect.result,
    Effect.runPromise
  );
  const statements = database.statements.map(({ sql }) => sql);
  const timeline = [
    ...database.statements.flatMap(({ sql }, index) => [
      ...events.filter(({ at }) => at === index).map(({ name }) => name),
      sql.trimStart().split(/\s/)[0]?.toLowerCase() ?? "",
    ]),
    ...events
      .filter(({ at }) => at === database.statements.length)
      .map(({ name }) => name),
  ];
  return {
    result,
    calls,
    logs,
    committed: statements.some((sql) => /^commit\b/i.test(sql)),
    rolledBack: statements.some((sql) => /^rollback\b/i.test(sql)),
    retracted: database.statements.some(
      ({ sql, params }) =>
        /^update "customer_events"/i.test(sql) &&
        params.includes(id) &&
        params.includes("reservation-cancelled")
    ),
    /** The provider calls and transaction statements a restore's ordering rests on, in the order they ran. */
    order: timeline.filter((step) =>
      [
        "restoreCancelledReservation",
        "begin",
        "prepareRestoredAccess",
        "markAdministrationRestored",
        "update",
        "commit",
        "rollback",
        "cancelReservation",
        "issueRestoredAccess",
        "sendRestorationEmail",
      ].includes(step)
    ),
  };
};

const restored = async (overrides: Partial<Fakes> = {}) => {
  const run = await restoreWith(overrides);
  if (run.result._tag === "Failure") {
    throw new Error(`restore refused: ${run.result.failure.reason}`);
  }
  return { ...run, value: run.result.success };
};

const refused = async (overrides: Partial<Fakes> = {}) => {
  const run = await restoreWith(overrides);
  if (run.result._tag === "Success") {
    throw new Error("restore succeeded");
  }
  const { code, reason, refundedPayment } = run.result.failure;
  return { ...run, code, reason, refundedPayment };
};

/** Each case's refusal, one restore at a time, since the cases share the swapped getRestorationBooking. */
const refusals = async (cases: readonly Partial<Fakes>[]) => {
  const outcomes: { readonly code: string; readonly reason: string }[] = [];
  for (const overrides of cases) {
    const { code, reason } = await refused(overrides);
    outcomes.push({ code, reason });
  }
  return outcomes;
};

test("restores an upcoming reservation: checks the table, confirms Dotypos, records, issues access, and emails", async () => {
  const run = await restored();

  expect(run.value).toEqual({
    outcome: "restored",
    email: "sent",
    access: "issued",
  });
  expect(run.calls.getAssignedTableAvailability).toHaveBeenCalledTimes(1);
  expect(run.calls.restoreCancelledReservation).toHaveBeenCalledWith({
    reservationId: dotyposReservationId,
    expectedBooking: booking,
  });
  expect(run.calls.markAdministrationRestored).toHaveBeenCalledWith({
    audit: expect.objectContaining({
      actorAccountId: "restore-operator",
      source: "assistant",
    }),
    id,
    cancelledAt,
    restoredAt: expect.any(Temporal.Instant),
  });
  expect(run.calls.prepareRestoredAccess).toHaveBeenCalledWith(
    expect.objectContaining({
      reservationId: id,
      reservedFrom: Temporal.Instant.from(upcoming.startDate),
      reservedUntil: Temporal.Instant.from(upcoming.endDate),
    })
  );
  expect(run.calls.issueRestoredAccess).toHaveBeenCalledWith({
    reservationId: id,
    reservedFrom: Temporal.Instant.from(upcoming.startDate),
    reservedUntil: Temporal.Instant.from(upcoming.endDate),
  });
  expect(run.calls.sendRestorationEmail).toHaveBeenCalledWith({
    reservation: details,
    accessReissued: true,
  });
  expect(run.calls.cancelReservation).not.toHaveBeenCalled();
  expect(run).toMatchObject({ committed: true, retracted: true });
  // Dotypos before the transaction, the reservation and its event inside it,
  // access and email only after it committed.
  expect(run.order).toEqual([
    "restoreCancelledReservation",
    "begin",
    "prepareRestoredAccess",
    "markAdministrationRestored",
    "update",
    "commit",
    "issueRestoredAccess",
    "sendRestorationEmail",
  ]);
});

test("restores an ended reservation without a table check or new access", async () => {
  const endedRecord = dotyposReservation(ended);
  const run = await restored({
    getReservationWithoutCustomer: () => Effect.succeed(endedRecord),
    prepareRestoredAccess: () => Effect.succeed("not_needed"),
  });

  expect(run.value).toEqual({
    outcome: "restored",
    email: "sent",
    access: "not_needed",
  });
  expect(run.calls.getAssignedTableAvailability).not.toHaveBeenCalled();
  expect(run.calls.issueRestoredAccess).not.toHaveBeenCalled();
  expect(run.calls.sendRestorationEmail).toHaveBeenCalledWith({
    reservation: details,
    accessReissued: false,
  });
  expect(run.committed).toBe(true);
});

test("refuses a reservation Workspace can't restore as it records it", async () => {
  expect(
    await refusals([
      { findById: () => Effect.succeed(null) },
      { findById: () => Effect.fail(queryError()) },
      {
        reservations: [
          { ...cancelledReservation, reservationState: "cancelling" },
        ],
      },
      {
        reservations: [{ ...cancelledReservation, reservationState: "draft" }],
      },
      {
        reservations: [{ ...cancelledReservation, paymentState: "pending" }],
      },
      {
        findCurrentByCheckoutSessionKey: () => Effect.fail(queryError()),
      },
      {
        reservations: [confirmedReservation],
        hasRecordedCancellation: () => Effect.succeed(false),
      },
    ])
  ).toEqual([
    { code: "not_found", reason: "not_found" },
    { code: "restoration_failed", reason: "details_unavailable" },
    { code: "not_restorable", reason: "cancellation_in_progress" },
    { code: "not_restorable", reason: "invalid_state" },
    { code: "not_restorable", reason: "invalid_state" },
    { code: "restoration_failed", reason: "details_unavailable" },
    { code: "not_restorable", reason: "invalid_state" },
  ]);
});

test("refuses a reservation another one of its checkout superseded without touching Dotypos", async () => {
  const run = await refused({
    findCurrentByCheckoutSessionKey: () =>
      Effect.succeed({ ...cancelledReservation, id: otherId }),
  });

  expect(run).toMatchObject({ code: "not_restorable", reason: "superseded" });
  expect(run.calls.getReservationWithoutCustomer).not.toHaveBeenCalled();
  expect(run.calls.restoreCancelledReservation).not.toHaveBeenCalled();
  expect(run.calls.cancelReservation).not.toHaveBeenCalled();
});

test("a successor that took the checkout after this restore's Dotypos write gets that write cancelled again", async () => {
  const run = await refused({
    markAdministrationRestored: sessionTaken,
    findCurrentByCheckoutSessionKey: successorAfterPreflight(),
  });

  expect(run).toMatchObject({ code: "not_restorable", reason: "superseded" });
  expect(run.calls.cancelReservation).toHaveBeenCalledWith(
    dotyposReservationId
  );
  expect(run.order).toEqual([
    "restoreCancelledReservation",
    "begin",
    "prepareRestoredAccess",
    "markAdministrationRestored",
    "rollback",
    "cancelReservation",
  ]);
  expect(run.calls.issueRestoredAccess).not.toHaveBeenCalled();
  expect(run.calls.sendRestorationEmail).not.toHaveBeenCalled();
});

test("a failed compensating cancel is logged for an operator and still refuses", async () => {
  const run = await refused({
    markAdministrationRestored: sessionTaken,
    findCurrentByCheckoutSessionKey: successorAfterPreflight(),
    cancelReservation: () =>
      Effect.fail(
        new DotyposUnavailable({
          operation: "cancelReservation",
          reason: "server",
        })
      ),
  });

  expect(run.reason).toBe("superseded");
  expect(run.logs).toContainEqual(
    expect.objectContaining({
      level: "Error",
      annotations: expect.objectContaining({ dotyposReservationId }),
    })
  );
});

// The compensating cancel targets the reservation by id, so the restore
// rereads it first: another restore may have finished it since the rollback.
test("a superseded restore cancels its Dotypos write only while the reservation is still its cancellation with a successor", async () => {
  const finishedMeanwhile = await restored({
    reservations: [cancelledReservation, confirmedReservation],
    getReservationWithoutCustomer: () =>
      Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
    markAdministrationRestored: sessionTaken,
    findCurrentByCheckoutSessionKey: successorAfterPreflight(),
  });
  const cancelledAgain = await refused({
    reservations: [
      cancelledReservation,
      {
        ...cancelledReservation,
        reservationCancelledAt: Temporal.Instant.from("2026-08-12T10:00:00Z"),
      },
    ],
    markAdministrationRestored: sessionTaken,
    findCurrentByCheckoutSessionKey: successorAfterPreflight(),
  });
  const noSuccessor = await refused({
    markAdministrationRestored: sessionTaken,
  });
  const rereadFailed = await refused({
    findById: (() => {
      let reads = 0;
      return () =>
        reads++ === 0
          ? Effect.succeed(cancelledReservation)
          : Effect.fail(queryError());
    })(),
    markAdministrationRestored: sessionTaken,
    findCurrentByCheckoutSessionKey: successorAfterPreflight(),
  });

  expect(finishedMeanwhile.value).toEqual({
    outcome: "already_confirmed",
    email: "not_requested",
    access: "not_needed",
  });
  expect(finishedMeanwhile.calls.issueRestoredAccess).not.toHaveBeenCalled();
  expect(finishedMeanwhile.calls.sendRestorationEmail).not.toHaveBeenCalled();
  for (const run of [cancelledAgain, noSuccessor, rereadFailed]) {
    expect(run).toMatchObject({ code: "not_restorable", reason: "superseded" });
    expect(run.logs).toContainEqual(
      expect.objectContaining({
        level: "Error",
        annotations: expect.objectContaining({ reservationId: id }),
      })
    );
  }
  for (const run of [
    finishedMeanwhile,
    cancelledAgain,
    noSuccessor,
    rereadFailed,
  ]) {
    expect(run.calls.cancelReservation).not.toHaveBeenCalled();
  }
});

test("a successor of a restore Dotypos had already confirmed is only logged, never cancelled in Dotypos", async () => {
  const run = await refused({
    getReservationWithoutCustomer: () =>
      Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
    restoreCancelledReservation: () =>
      Effect.succeed(
        RestoreCancelledReservationResult.AlreadyConfirmed({
          reservation: dotyposReservation({ status: "CONFIRMED" }),
        })
      ),
    markAdministrationRestored: sessionTaken,
    findCurrentByCheckoutSessionKey: successorAfterPreflight(),
  });

  expect(run).toMatchObject({ code: "not_restorable", reason: "superseded" });
  expect(run.calls.cancelReservation).not.toHaveBeenCalled();
  expect(run.logs).toContainEqual(
    expect.objectContaining({
      level: "Error",
      annotations: expect.objectContaining({ dotyposReservationId }),
    })
  );
});

test("requires acknowledging what Nexi already refunded, in full or in part", async () => {
  const full = await refused({
    reconcileReservationRefunds: () =>
      Effect.succeed([refundedAttempt(45_000)]),
  });
  const partial = await refused({
    reconcileReservationRefunds: () =>
      Effect.succeed([refundedAttempt(20_000)]),
  });

  expect(full).toMatchObject({
    code: "not_restorable",
    reason: "refund_acknowledgement_required",
    refundedPayment: {
      amount: { value: 45_000, exponent: 2, currency: "CZK" },
      coverage: "full",
    },
  });
  expect(partial).toMatchObject({
    code: "not_restorable",
    reason: "refund_acknowledgement_required",
    refundedPayment: {
      amount: { value: 20_000, exponent: 2, currency: "CZK" },
      coverage: "partial",
    },
  });
  expect(full.calls.restoreCancelledReservation).not.toHaveBeenCalled();
});

test("restores a refunded payment the administrator acknowledged", async () => {
  const run = await restored({
    acknowledgeRefundedPayment: true,
    reconcileReservationRefunds: () =>
      Effect.succeed([refundedAttempt(45_000)]),
    markAdministrationRestored: () =>
      Effect.succeed({
        reservation: confirmedReservation,
        paymentAttempts: [refundedAttempt(45_000)],
      }),
  });

  expect(run.value.outcome).toBe("restored");
  expect(run.committed).toBe(true);
});

test("a refund Nexi recorded between the check and the write refuses the restore and commits nothing", async () => {
  const run = await refused({
    markAdministrationRestored: () =>
      Effect.succeed({
        reservation: confirmedReservation,
        paymentAttempts: [refundedAttempt(45_000)],
      }),
  });

  expect(run).toMatchObject({
    code: "not_restorable",
    reason: "refund_acknowledgement_required",
    refundedPayment: { coverage: "full" },
  });
  expect(run).toMatchObject({
    committed: false,
    rolledBack: true,
    retracted: false,
  });
  expect(run.calls.issueRestoredAccess).not.toHaveBeenCalled();
  expect(run.calls.sendRestorationEmail).not.toHaveBeenCalled();
});

// The refusal leaves Dotypos confirmed while Workspace keeps the reservation
// cancelled; the acknowledged retry finds Dotypos already confirmed and
// completes the restore.
test("a refund recorded after the Dotypos write recovers through an acknowledged retry", async () => {
  const refundedSince = {
    markAdministrationRestored: () =>
      Effect.succeed({
        reservation: confirmedReservation,
        paymentAttempts: [refundedAttempt(45_000)],
      }),
  };
  const refusal = await refused(refundedSince);
  const retry = await restored({
    ...refundedSince,
    acknowledgeRefundedPayment: true,
    reconcileReservationRefunds: () =>
      Effect.succeed([refundedAttempt(45_000)]),
    getReservationWithoutCustomer: () =>
      Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
    restoreCancelledReservation: () =>
      Effect.succeed(
        RestoreCancelledReservationResult.AlreadyConfirmed({
          reservation: dotyposReservation({ status: "CONFIRMED" }),
        })
      ),
  });

  expect(refusal).toMatchObject({
    reason: "refund_acknowledgement_required",
    committed: false,
  });
  expect(refusal.calls.restoreCancelledReservation).toHaveBeenCalledTimes(1);
  expect(refusal.calls.cancelReservation).not.toHaveBeenCalled();
  expect(retry.value).toEqual({
    outcome: "restored",
    email: "sent",
    access: "issued",
  });
  expect(retry.committed).toBe(true);
});

test("refuses a restore Dotypos, the refunds, the table or the access grant can't support", async () => {
  expect(
    await refusals([
      {
        reconcileReservationRefunds: () =>
          Effect.fail(
            new PaymentRefundReconciliationError({
              message: "Nexi failed",
              cause: new Error("NexiFailed"),
            })
          ),
      },
      {
        getAssignedTableAvailability: () => Effect.succeed("unavailable"),
      },
      {
        getAssignedTableAvailability: () =>
          Effect.fail(
            new DotyposUnavailable({
              operation: "listReservations",
              reason: "server",
            })
          ),
      },
      {
        getReservationWithoutCustomer: () =>
          Effect.fail(
            new DotyposUnavailable({
              operation: "getReservationWithoutCustomer",
              reason: "timeout",
            })
          ),
      },
      {
        getReservationWithoutCustomer: () =>
          Effect.fail(
            new DotyposRejected({
              operation: "getReservationWithoutCustomer",
              reason: "not-found",
            })
          ),
      },
      {
        getReservationWithoutCustomer: () =>
          Effect.succeed(dotyposReservation({ status: "NEW" })),
      },
      {
        getRestorationBooking: () =>
          Effect.fail(
            new TestRestorationBookingChanged({ message: "changed" })
          ),
      },
      {
        getRestorationBooking: () =>
          Effect.fail(
            new TestRestorationBookingUnreadable({ message: "unreadable" })
          ),
      },
      {
        getReservationWithoutCustomer: () =>
          Effect.succeed(dotyposReservation({ endDate: "not a date" })),
      },
      { loadGrant: () => Effect.fail(accessIssuanceError()) },
      { loadGrant: () => Effect.succeed(accessGrant({ state: "issued" })) },
    ])
  ).toEqual([
    { code: "restoration_failed", reason: "refund_check_failed" },
    { code: "not_restorable", reason: "table_unavailable" },
    { code: "restoration_failed", reason: "dotypos_failed" },
    { code: "restoration_failed", reason: "dotypos_failed" },
    { code: "not_restorable", reason: "changed_in_dotypos" },
    { code: "not_restorable", reason: "changed_in_dotypos" },
    { code: "not_restorable", reason: "changed_in_dotypos" },
    { code: "restoration_failed", reason: "details_unavailable" },
    { code: "restoration_failed", reason: "details_unavailable" },
    { code: "restoration_failed", reason: "details_unavailable" },
    { code: "not_restorable", reason: "access_uncertain" },
  ]);
});

test("maps each failed Dotypos restore write", async () => {
  expect(
    await refusals([
      {
        restoreCancelledReservation: () =>
          Effect.fail(
            new DotyposReservationNotRestorable({
              reservationId: dotyposReservationId,
              reason: "booking-changed",
              status: "CANCELLED",
              changedFields: ["seats"],
              message: "booking changed",
            })
          ),
      },
      {
        restoreCancelledReservation: () =>
          Effect.fail(
            new DotyposRejected({
              operation: "restoreCancelledReservation",
              reason: "not-found",
            })
          ),
      },
      {
        restoreCancelledReservation: () =>
          Effect.fail(
            new DotyposVersionConflict({
              operation: "restoreCancelledReservation",
            })
          ),
      },
      {
        restoreCancelledReservation: () =>
          Effect.fail(
            new DotyposUnavailable({
              operation: "restoreCancelledReservation",
              reason: "server",
            })
          ),
      },
      {
        restoreCancelledReservation: () =>
          Effect.fail(
            new DotyposUncertain({
              operation: "restoreCancelledReservation",
              reason: "timeout",
            })
          ),
      },
    ])
  ).toEqual([
    { code: "not_restorable", reason: "changed_in_dotypos" },
    { code: "not_restorable", reason: "changed_in_dotypos" },
    { code: "restoration_failed", reason: "dotypos_failed" },
    { code: "restoration_failed", reason: "dotypos_failed" },
    { code: "restoration_failed", reason: "dotypos_failed" },
  ]);
});

test("refuses a restore its transaction can't record, rolling it back", async () => {
  const uncertain = await refused({
    prepareRestoredAccess: () => Effect.succeed("uncertain"),
  });
  const accessStorage = await refused({
    prepareRestoredAccess: () => Effect.fail(accessIssuanceError()),
  });
  const reservationWrite = await refused({
    markAdministrationRestored: () => Effect.fail(queryError()),
  });
  const retraction = await refused({ failRetraction: true });

  expect(uncertain).toMatchObject({
    code: "not_restorable",
    reason: "access_uncertain",
    rolledBack: true,
  });
  expect(uncertain.calls.markAdministrationRestored).not.toHaveBeenCalled();
  expect(accessStorage).toMatchObject({
    code: "restoration_failed",
    reason: "record_failed",
    rolledBack: true,
  });
  expect(reservationWrite).toMatchObject({
    code: "restoration_failed",
    reason: "record_failed",
    rolledBack: true,
    retracted: false,
  });
  expect(retraction).toMatchObject({
    code: "restoration_failed",
    reason: "record_failed",
    rolledBack: true,
  });
  for (const run of [uncertain, accessStorage, reservationWrite, retraction]) {
    expect(run.committed).toBe(false);
    expect(run.calls.issueRestoredAccess).not.toHaveBeenCalled();
  }
});

test("a retried restore that already finished reports it without acting again", async () => {
  const run = await restored({
    reservations: [confirmedReservation],
    getReservationWithoutCustomer: () =>
      Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
  });

  expect(run.value).toEqual({
    outcome: "already_confirmed",
    email: "not_requested",
    access: "not_needed",
  });
  expect(run.calls.restoreCancelledReservation).not.toHaveBeenCalled();
  expect(run.calls.markAdministrationRestored).not.toHaveBeenCalled();
  expect(run.calls.issueRestoredAccess).not.toHaveBeenCalled();
  expect(run.calls.sendRestorationEmail).not.toHaveBeenCalled();
  expect(run.calls.cancelReservation).not.toHaveBeenCalled();
});

test("a confirmed reservation Dotypos holds differently was not restored by Workspace", async () => {
  expect(
    await refusals([
      {
        reservations: [confirmedReservation],
        getReservationWithoutCustomer: () =>
          Effect.succeed(dotyposReservation({ status: "CANCELLED" })),
      },
      {
        reservations: [confirmedReservation],
        getReservationWithoutCustomer: () =>
          Effect.succeed(
            dotyposReservation({
              status: "CONFIRMED",
              _customerId: DotyposCustomerIdSchema.make("customer-other"),
            })
          ),
      },
      {
        reservations: [confirmedReservation],
        getReservationWithoutCustomer: () =>
          Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
        getRestorationBooking: () =>
          Effect.fail(
            new TestRestorationBookingChanged({ message: "changed" })
          ),
      },
    ])
  ).toEqual([
    { code: "not_restorable", reason: "changed_in_dotypos" },
    { code: "not_restorable", reason: "changed_in_dotypos" },
    { code: "not_restorable", reason: "changed_in_dotypos" },
  ]);
});

test("finishes a restore that confirmed Dotypos but crashed before recording it", async () => {
  const run = await restored({
    getReservationWithoutCustomer: () =>
      Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
    restoreCancelledReservation: () =>
      Effect.succeed(
        RestoreCancelledReservationResult.AlreadyConfirmed({
          reservation: dotyposReservation({ status: "CONFIRMED" }),
        })
      ),
  });

  expect(run.value).toEqual({
    outcome: "restored",
    email: "sent",
    access: "issued",
  });
  expect(run.committed).toBe(true);
});

test("a reservation write that lost to a concurrent change settles from the reservation as it now stands", async () => {
  const lost = { markAdministrationRestored: () => Effect.succeed(null) };
  const finished = await restored({
    ...lost,
    reservations: [cancelledReservation, confirmedReservation],
    getReservationWithoutCustomer: () =>
      Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
  });
  const notInDotypos = await refused({
    ...lost,
    reservations: [cancelledReservation, confirmedReservation],
  });
  const cancelling = await refused({
    ...lost,
    reservations: [
      cancelledReservation,
      { ...cancelledReservation, reservationState: "cancelling" },
    ],
  });

  expect(finished.value).toEqual({
    outcome: "already_confirmed",
    email: "not_requested",
    access: "not_needed",
  });
  expect(finished.rolledBack).toBe(true);
  expect(finished.calls.issueRestoredAccess).not.toHaveBeenCalled();
  expect(finished.calls.sendRestorationEmail).not.toHaveBeenCalled();
  expect(notInDotypos).toMatchObject({
    code: "not_restorable",
    reason: "invalid_state",
  });
  expect(cancelling).toMatchObject({
    code: "not_restorable",
    reason: "cancellation_in_progress",
  });
});

// The losing restore planned access before the winner's grant committed, so
// it sees that grant as uncertain; the reread shows the restore finished.
test("a refusal of a restore another one finished meanwhile reports it already confirmed", async () => {
  const run = await restored({
    reservations: [cancelledReservation, confirmedReservation],
    getReservationWithoutCustomer: () =>
      Effect.succeed(dotyposReservation({ status: "CONFIRMED" })),
    prepareRestoredAccess: () => Effect.succeed("uncertain"),
  });

  expect(run.value).toEqual({
    outcome: "already_confirmed",
    email: "not_requested",
    access: "not_needed",
  });
  expect(run.rolledBack).toBe(true);
  expect(run.calls.issueRestoredAccess).not.toHaveBeenCalled();
  expect(run.calls.sendRestorationEmail).not.toHaveBeenCalled();
  expect(run.calls.cancelReservation).not.toHaveBeenCalled();
});

test("tells the customer only when asked and when they were told about the cancellation", async () => {
  const notRequested = await restored({ sendRestorationEmailRequested: false });
  const notAvailable = await restored({
    reservations: [{ ...cancelledReservation, cancellationEmailSentAt: null }],
  });
  const sendFailed = await restored({
    sendRestorationEmail: () => Effect.fail(emailError()),
  });
  const detailsFailed = await restored({
    getReservation: () => Effect.fail(detailsError()),
  });

  expect(
    [notRequested, notAvailable, sendFailed, detailsFailed].map(
      ({ value }) => value
    )
  ).toEqual([
    { outcome: "restored", email: "not_requested", access: "issued" },
    { outcome: "restored", email: "not_available", access: "issued" },
    { outcome: "restored", email: "failed", access: "issued" },
    { outcome: "restored", email: "failed", access: "issued" },
  ]);
  expect(notRequested.calls.sendRestorationEmail).not.toHaveBeenCalled();
  expect(notAvailable.calls.sendRestorationEmail).not.toHaveBeenCalled();
});

// The restore stands with access "failed": the grant stays pending and the
// administration access retry issues it, as
// reservation-access-administration.service.test.ts ("retries a pending grant
// whose issuance never ran, as a restored reservation's") covers.
test("keeps the restore when its new access can't be issued", async () => {
  const run = await restored({
    issueRestoredAccess: () => Effect.succeed("failed"),
  });

  expect(run.value).toEqual({
    outcome: "restored",
    email: "sent",
    access: "failed",
  });
  expect(run.committed).toBe(true);
  expect(run.calls.sendRestorationEmail).toHaveBeenCalledWith({
    reservation: details,
    accessReissued: false,
  });
});

test("keeps the restored transition when both code issuance and booker email fail", async () => {
  const run = await restored({
    issueRestoredAccess: () => Effect.succeed("failed"),
    sendRestorationEmail: () => Effect.fail(emailError()),
  });

  expect(run.value).toEqual({
    outcome: "restored",
    email: "failed",
    access: "failed",
  });
  expect(run.committed).toBe(true);
  expect(run.calls.sendRestorationEmail).toHaveBeenCalledWith({
    reservation: details,
    accessReissued: false,
  });
});
