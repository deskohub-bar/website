import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  type DotyposReservation,
  DotyposReservationIdSchema,
  DotyposRuntimeConfigSchema,
  DotyposService,
  DotyposTableIdSchema,
  DotyposUnavailable,
  type IDotyposService,
  makeDotyposRuntimeConfigLayer,
} from "@deskohub/dotypos";
import { Cause, Effect, Exit, Layer, Predicate, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import type {
  LatePaymentRecovery,
  LatePaymentRecoveryState,
} from "@/db/schema";
import {
  type AccountingDocumentSnapshot,
  coworkAccountingDocumentSnapshotSchema,
  meetingRoomAccountingDocumentSnapshotSchema,
  officeAccountingDocumentSnapshotSchema,
} from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import {
  makeCoworkInvoiceDocument,
  makeMeetingRoomInvoiceDocument,
  makeOfficeInvoiceDocument,
} from "@/features/accounting/invoice.test-utils";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { discountIdSchema } from "@/features/discounts/contracts";
import { DiscountClaimError } from "@/features/discounts/errors";
import {
  type IWorkspaceAvailabilityService,
  WorkspaceAvailabilityService,
  WorkspaceTableUnavailableError,
} from "@/features/reservation/backend/workspace-availability.service";
import {
  type IWorkspaceReservationRepository,
  type WorkspaceReservation,
  WorkspaceReservationRepository,
  WorkspaceReservationStateError,
} from "@/features/reservation/backend/workspace-reservation.repository";
import {
  dotyposCreatedReservationFixture,
  dotyposHoldFixture,
  payableReservationFixture,
} from "@/features/reservation/backend/workspace-reservation.test-utils";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { moneyWithValue } from "@/shared/money/money";
import {
  type EffectTrace,
  recordEffectTrace,
  startEffectTrace,
} from "@/shared/testing/effect-trace.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { ReservationFulfillment } from "../fulfillment/reservation-fulfillment.service";
import { UnpaidHoldRelease } from "../holds/unpaid-hold-release.service";
import {
  type ILatePaymentRecoveryRepository,
  LatePaymentRecoveryRepository,
  LatePaymentRecoverySessionTakenError,
  LatePaymentRecoveryStateError,
  OriginalHoldNotReusableError,
} from "../repositories/late-payment-recovery.repository";
import { administrationForcedPaymentCancellationFailureCode } from "../repositories/payment-lifecycle.repository";
import {
  type IWorkspaceTableAssignmentService,
  TableAssignmentUnavailableError,
  WorkspaceTableAssignmentService,
} from "../reservation/workspace-table-assignment.service";
import { LatePaymentRecoveryService } from "./late-payment-recovery.service";

interface Scenario {
  readonly attachedTableMove?: boolean;
  /** The recovery's stored state; null when no recovery exists. */
  readonly recoveryState?: LatePaymentRecoveryState | null;
  readonly claimed?: boolean;
  readonly reservation?: WorkspaceReservation | null;
  /** Overrides each `findById` in turn; later reads use the stateful row. */
  readonly findByIdSequence?: ReadonlyArray<WorkspaceReservation | null>;
  readonly originalStatus?: DotyposReservation["status"];
  readonly getReservationStatus?: IDotyposService["getReservationStatus"];
  /** The original Dotypos reservation's bounds, read for its stay. */
  readonly originalBounds?: {
    readonly startDate: string;
    readonly endDate: string;
  };
  /** Each `hasNewerActiveReservation` answer in turn; the last one repeats. */
  readonly newerReservation?: ReadonlyArray<boolean>;
  readonly snapshot?: AccountingDocumentSnapshot | null;
  readonly overlapping?: ReadonlyArray<{
    readonly id: string;
    readonly status: "NEW" | "CONFIRMED";
    readonly note: string | null;
  }>;
  readonly createReservation?: IDotyposService["createReservation"];
  readonly endsWhileWaitingAt?: Temporal.Instant;
  readonly claimCancellation?: boolean;
  readonly ensureAvailable?: IWorkspaceAvailabilityService["ensureAvailable"];
  readonly assignTableId?: IWorkspaceTableAssignmentService["assignTableId"];
  readonly cancelReservation?: IDotyposService["cancelReservation"];
  readonly markCancelled?: (row: {
    current: WorkspaceReservation | null;
  }) => IWorkspaceReservationRepository["markCancelled"];
  readonly completeUsingOriginalReservation?: ILatePaymentRecoveryRepository["completeUsingOriginalReservation"];
  readonly completeWithReplacement?: ILatePaymentRecoveryRepository["completeWithReplacement"];
}

const paymentAttemptId = paymentAttemptIdSchema.make("attempt-id");
const workspaceReservationId =
  workspaceReservationIdSchema.make("reservation-id");
const dotyposReservationId = DotyposReservationIdSchema.make(
  "dotypos-reservation-id"
);
const dotyposCustomerId = DotyposCustomerIdSchema.make("dotypos-customer-id");
const tableId = DotyposTableIdSchema.make("table-id");
const startedAt = Temporal.Now.instant();

const dotyposConfig = makeDotyposRuntimeConfigLayer(
  Schema.decodeUnknownSync(DotyposRuntimeConfigSchema)({
    apiUrl: "https://dotypos.example.test",
    apiTimeout: 1000,
    clientId: "test-client",
    clientSecret: "test-client-secret",
    refreshToken: "test-refresh-token",
    cloudId: "test-cloud",
    branchId: "test-branch",
    employeeId: "test-employee",
    reservationTableIds: [tableId],
  })
);

const dotyposResponse = (
  method: "GET" | "POST",
  path: string,
  response: Response
) => {
  const fetchFixture = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/signin/token") {
        return Response.json({ accessToken: "test-access-token" });
      }
      if (request.method === method && pathname === path) {
        return response.clone();
      }
      throw new Error(
        `Unexpected Dotypos request: ${request.method} ${pathname}`
      );
    },
    { preconnect: globalThis.fetch.preconnect }
  );
  return DotyposService.Live.pipe(
    Layer.provide(
      Layer.merge(
        dotyposConfig,
        Layer.succeed(FetchHttpClient.Fetch, fetchFixture)
      )
    )
  );
};

const recoveryRow = (state: LatePaymentRecoveryState): LatePaymentRecovery => ({
  paymentAttemptId,
  workspaceReservationId,
  originalDotyposReservationId: dotyposReservationId,
  state,
  webhookEventId: null,
  providerOperationId: null,
  providerStatus: null,
  recoveredDotyposReservationId:
    state === "recovered" ? dotyposReservationId : null,
  failureCode:
    state === "refund_required" || state === "review_required"
      ? "late_payment_fixture_failure"
      : null,
  verifiedPaidAt: startedAt,
  claimedAt: state === "processing" ? startedAt : null,
  completedAt: state === "pending" || state === "processing" ? null : startedAt,
  createdAt: startedAt,
  updatedAt: startedAt,
});

const expiredHeld = payableReservationFixture({
  id: workspaceReservationId,
  activePaymentAttemptId: paymentAttemptId,
  dotyposReservationId,
  dotyposCustomerId,
  reservationDetails: { kind: "cowork", entryTier: "basic", coffee: true },
  productTier: "basic",
  productCoffee: true,
  reservationHoldExpiresAt: startedAt.subtract({ minutes: 20 }),
  updatedAt: startedAt.subtract({ minutes: 20 }),
});

const currentHeld: WorkspaceReservation = {
  ...expiredHeld,
  reservationHoldExpiresAt: startedAt.add({ minutes: 5 }),
  updatedAt: startedAt,
};

const withSnapshotKeys = (
  document: AccountingDocumentSnapshot
): AccountingDocumentSnapshot => ({
  ...document,
  workspaceReservationId,
  dotyposReservationId,
  dotyposCustomerId,
});

const succeed =
  <A>(value: A) =>
  () =>
    Effect.succeed(value);
const fail =
  <E>(error: E) =>
  () =>
    Effect.fail(error);

const recoveryStateError = new LatePaymentRecoveryStateError({
  operation: "settle",
  paymentAttemptId,
  message: "A newer reservation prevents recovery.",
});

const discountClaimError = new DiscountClaimError({
  operation: "redeem",
  reason: "usage_limit_reached",
  message: "The code has no remaining uses.",
});

const reservationStateError = new WorkspaceReservationStateError({
  operation: "markCancelled",
  reservationId: workspaceReservationId,
  message: "The reservation is no longer cancelling.",
});

/**
 * Wires the recovery to stateful fakes: cancellation and settlement writes
 * change what later reads return, as the repositories would.
 */
const recover = async (scenario: Scenario) => {
  const trace: EffectTrace = startEffectTrace();
  const row = {
    current:
      scenario.reservation === undefined ? expiredHeld : scenario.reservation,
  };
  let recoveryState =
    scenario.recoveryState === undefined ? "pending" : scenario.recoveryState;
  const findByIdSequence = [...(scenario.findByIdSequence ?? [])];
  const newerAnswers = [...(scenario.newerReservation ?? [false])];
  const settleAs = (state: LatePaymentRecoveryState) => () =>
    Effect.sync(() => {
      recoveryState = state;
    });
  const setRowState = (
    reservationState: WorkspaceReservation["reservationState"]
  ) => {
    if (row.current !== null) {
      row.current = { ...row.current, reservationState };
    }
  };
  const calls = {
    ensureAvailable: mock(scenario.ensureAvailable ?? succeed(undefined)),
    createReservation: mock<IDotyposService["createReservation"]>(
      scenario.createReservation ??
        ((input) =>
          Effect.succeed(
            dotyposCreatedReservationFixture("replacement-id", input)
          ))
    ),
  };
  const recoveries = trace.recordCalls("recoveries", {
    findByPaymentAttemptId: () =>
      Effect.sync(() =>
        recoveryState === null ? null : recoveryRow(recoveryState)
      ),
    claim: succeed(
      scenario.claimed === false ? null : recoveryRow("processing")
    ),
    hasNewerActiveReservation: () =>
      Effect.sync(
        () =>
          (newerAnswers.length > 1 ? newerAnswers.shift() : newerAnswers[0]) ??
          false
      ),
    completeUsingOriginalReservation:
      scenario.completeUsingOriginalReservation ?? settleAs("recovered"),
    completeWithReplacement:
      scenario.completeWithReplacement ?? settleAs("recovered"),
    requireRefund: settleAs("refund_required"),
    requireReview: settleAs("review_required"),
  });
  const reservations = trace.recordCalls("reservations", {
    hasAttachedOpenSpaceMove: () =>
      Effect.succeed(scenario.attachedTableMove ?? false),
    findById: () =>
      Effect.sync(() => {
        const next = findByIdSequence.shift();
        return next === undefined ? row.current : next;
      }),
    claimCancellation:
      scenario.claimCancellation === false
        ? succeed(null)
        : () =>
            Effect.sync(() => {
              setRowState("cancelling");
              return row.current;
            }),
    markCancelled:
      scenario.markCancelled?.(row) ??
      (() => Effect.sync(() => setRowState("cancelled"))),
    takeOverStaleCancellation: () => Effect.sync(() => row.current),
    markCancellationFailed: () =>
      Effect.sync(() => setRowState("cancellation_failed")),
  });
  const dotypos = trace.recordCalls("dotypos", {
    getReservationStatus:
      scenario.getReservationStatus ??
      succeed(scenario.originalStatus ?? "NEW"),
    getReservationWithoutCustomer: succeed({
      ...dotyposHoldFixture(dotyposReservationId),
      ...scenario.originalBounds,
    }),
    cancelReservation: scenario.cancelReservation ?? succeed(undefined),
    listActiveReservationsOverlapping: succeed(
      scenario.overlapping?.map(({ id, status, note }) => ({
        ...dotyposHoldFixture(id),
        status,
        note,
      })) ?? []
    ),
    createReservation: calls.createReservation,
  });
  const snapshot =
    scenario.snapshot === null
      ? null
      : withSnapshotKeys(
          scenario.snapshot ?? makeCoworkInvoiceDocument("en-US")
        );

  const bookingEnd = scenario.endsWhileWaitingAt?.epochMilliseconds;
  const advisoryLock =
    bookingEnd === undefined
      ? makeRecordingAdvisoryLock().layer
      : Layer.succeed(WorkspaceDatabaseAdvisoryLock, {
          withTransactionPermit: (effect) => effect,
          withLock: ([namespace], effect) =>
            namespace === "reservation-capacity"
              ? TestClock.setTime(bookingEnd + 1).pipe(Effect.andThen(effect))
              : effect,
          withLocks: (_keys, effect) => effect,
        });
  const recovery = Effect.gen(function* () {
    const service = yield* LatePaymentRecoveryService;
    return yield* recordEffectTrace(
      trace,
      service.recover({ paymentAttemptId })
    );
  }).pipe(
    Effect.provide(
      LatePaymentRecoveryService.Default.pipe(
        Layer.provide(UnpaidHoldRelease.Default),
        Layer.provide(advisoryLock),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(LatePaymentRecoveryRepository, recoveries),
            Layer.mock(WorkspaceReservationRepository, reservations),
            Layer.mock(AccountingDocumentSnapshots, {
              find: trace.recordCalls("snapshots", {
                find: succeed(snapshot),
              }).find,
            }),
            Layer.mock(WorkspaceAvailabilityService, {
              ensureAvailable: trace.recordCalls("availability", {
                ensureAvailable: calls.ensureAvailable,
              }).ensureAvailable,
            }),
            Layer.mock(DotyposService, dotypos),
            Layer.mock(WorkspaceTableAssignmentService, {
              assignTableId: trace.recordCalls("tableAssignments", {
                assignTableId: scenario.assignTableId ?? succeed(tableId),
              }).assignTableId,
            }),
            Layer.mock(ReservationFulfillment, {
              run: trace.recordCalls("fulfillment", {
                run: succeed(undefined),
              }).run,
            })
          )
        )
      )
    )
  );
  const exit = await Effect.runPromise(
    bookingEnd === undefined
      ? recovery
      : TestClock.setTime(bookingEnd - 1).pipe(
          Effect.andThen(recovery),
          Effect.provide(TestClock.layer())
        )
  );
  return {
    outcome: outcomeOf(exit),
    cause: Exit.isFailure(exit) ? exit.cause : undefined,
    trace: trace.entries,
    calls,
  };
};

/** The success value, or the failure's message, or the defect. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.squash(exit.cause);
  const kind = Cause.hasDies(exit.cause) ? "die" : "fail";
  return `${kind}: ${Predicate.hasProperty(failure, "message") ? failure.message : String(failure)}`;
};

describe("LatePaymentRecoveryService.recover settled recoveries", () => {
  test("ignores a payment attempt without a recovery", async () => {
    const { outcome, trace } = await recover({ recoveryState: null });

    expect(outcome).toBe("ignored");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
      ]
    `);
  });

  test("re-runs fulfillment for a recovered reservation", async () => {
    const { outcome, trace } = await recover({ recoveryState: "recovered" });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("keeps a recovery that ended requiring a refund", async () => {
    const { outcome, trace } = await recover({
      recoveryState: "refund_required",
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
      ]
    `);
  });

  test("keeps a recovery that ended requiring review", async () => {
    const { outcome, trace } = await recover({
      recoveryState: "review_required",
    });

    expect(outcome).toBe("review_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
      ]
    `);
  });

  test("waits for an attached table move before claiming a recovery", async () => {
    const { outcome, trace } = await recover({ attachedTableMove: true });
    expect(outcome).toBe(
      "fail: A table move is still retiring the original reservation hold."
    );
    expect(trace).not.toContain(
      "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)"
    );
  });

  test("retries a recovery another run is processing", async () => {
    const { outcome, trace } = await recover({ claimed: false });

    expect(outcome).toBe("fail: Late-payment recovery is already processing.");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
      ]
    `);
  });

  test("dies when the claimed recovery's reservation is missing", async () => {
    const { outcome, trace } = await recover({ reservation: null });

    expect(outcome).toBe(
      "die: Late-payment recovery reservation missing despite its foreign key."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
      ]
    `);
  });

  test("refunds a payment whose attempt was superseded", async () => {
    const { outcome, trace } = await recover({
      reservation: {
        ...expiredHeld,
        activePaymentAttemptId: paymentAttemptIdSchema.make("newer-attempt"),
      },
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_superseded_attempt, completedAt=<Instant>)",
      ]
    `);
  });

  test("refunds a payment for a reservation an operator force-cancelled", async () => {
    const { outcome, trace } = await recover({
      reservation: {
        ...expiredHeld,
        failureCode: administrationForcedPaymentCancellationFailureCode,
      },
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_after_administration_cancellation, completedAt=<Instant>)",
      ]
    `);
  });
});

describe("LatePaymentRecoveryService.recover original hold reuse", () => {
  test("reuses a current NEW hold", async () => {
    const { outcome, trace } = await recover({ reservation: currentHeld });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call recoveries.completeUsingOriginalReservation(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, reservationState=held, completedAt=<Instant>)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("reuses a current hold Dotypos already confirmed", async () => {
    const { outcome, trace } = await recover({
      reservation: currentHeld,
      originalStatus: "CONFIRMED",
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call recoveries.completeUsingOriginalReservation(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, reservationState=confirmed, completedAt=<Instant>)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("recreates an overnight Reserved Desk with the stay of its original Dotypos bounds", async () => {
    const reservedDesk = {
      ...currentHeld,
      reservationDetails: {
        kind: "cowork",
        entryTier: "reserved-desk",
        coffee: true,
      },
    } satisfies WorkspaceReservation;
    const recreate = (originalBounds: Scenario["originalBounds"]) =>
      recover({
        reservation: reservedDesk,
        originalStatus: "CANCELLED",
        originalBounds,
      });
    const assignment = (trace: ReadonlyArray<string>) =>
      trace.find((line) =>
        line.startsWith("call tableAssignments.assignTableId(")
      );

    // Prague winter time (UTC+1): noon on 2099-01-01 to noon on 2099-01-02.
    const overnight = await recreate({
      startDate: "2099-01-01T11:00:00Z",
      endDate: "2099-01-02T11:00:00Z",
    });
    const day = await recreate({
      startDate: "2098-12-31T23:00:00Z",
      endDate: "2099-01-01T23:00:00Z",
    });

    expect(overnight.outcome).toBe("recovered");
    expect(overnight.trace).toContain(
      "call dotypos.getReservationWithoutCustomer(dotypos-reservation-id)"
    );
    expect(assignment(overnight.trace)).toContain("stay=overnight");
    expect(day.outcome).toBe("recovered");
    expect(assignment(day.trace)).toContain("entryTier=reserved-desk");
    expect(assignment(day.trace)).not.toContain("stay=");
  });

  test("recreates a current hold Dotypos already cancelled", async () => {
    const { outcome, trace } = await recover({
      reservation: currentHeld,
      originalStatus: "CANCELLED",
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("recreates from a snapshot signed before staff labels with its stored discount label", async () => {
    const document = Schema.decodeUnknownSync(
      coworkAccountingDocumentSnapshotSchema
    )(makeCoworkInvoiceDocument("de-DE"));
    const storedLabel = "Sommerrabatt";
    const atPrice = (value: number) =>
      moneyWithValue(value, document.quote.payment.expectedPrice);
    const { calls, outcome } = await recover({
      reservation: currentHeld,
      originalStatus: "CANCELLED",
      snapshot: {
        ...document,
        quote: {
          ...document.quote,
          payment: {
            ...document.quote.payment,
            discounts: [
              {
                discount: {
                  id: discountIdSchema.make("summer-sale"),
                  label: storedLabel,
                  adjustment: { kind: "percentage", basisPoints: 1000 },
                },
                subtotalBefore: atPrice(35_000),
                amount: atPrice(3500),
                subtotalAfter: atPrice(31_500),
              },
            ],
          },
        },
      },
    });

    expect(outcome).toBe("recovered");
    expect(calls.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ note: expect.stringContaining(storedLabel) })
    );
  });

  test("releases a reused hold and refunds when its discount is gone", async () => {
    const { outcome, trace } = await recover({
      reservation: currentHeld,
      completeUsingOriginalReservation: fail(discountClaimError),
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call recoveries.completeUsingOriginalReservation(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, reservationState=held, completedAt=<Instant>)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_discount_unavailable, completedAt=<Instant>)",
      ]
    `);
  });

  test("requires review when a reused hold with a gone discount can't be released", async () => {
    const { outcome, trace } = await recover({
      reservation: currentHeld,
      findByIdSequence: [
        currentHeld,
        { ...currentHeld, reservationState: "confirmed" },
      ],
      completeUsingOriginalReservation: fail(discountClaimError),
    });

    expect(outcome).toBe("review_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call recoveries.completeUsingOriginalReservation(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, reservationState=held, completedAt=<Instant>)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call recoveries.requireReview(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_reservation_state_unexpected, completedAt=<Instant>)",
      ]
    `);
  });

  test("rechecks newer reservations and recreates when the hold stops being reusable", async () => {
    const { outcome, trace } = await recover({
      reservation: currentHeld,
      newerReservation: [false, true],
      completeUsingOriginalReservation: fail(
        new OriginalHoldNotReusableError({
          paymentAttemptId,
          message: "The hold reached its reuse margin.",
        })
      ),
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call recoveries.completeUsingOriginalReservation(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, reservationState=held, completedAt=<Instant>)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_newer_reservation, completedAt=<Instant>)",
      ]
    `);
  });

  test("keeps other reuse settlement failures retryable", async () => {
    const { outcome, trace } = await recover({
      reservation: currentHeld,
      completeUsingOriginalReservation: fail(recoveryStateError),
    });

    expect(outcome).toBe("fail: Late-payment recovery failed.");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call recoveries.completeUsingOriginalReservation(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, reservationState=held, completedAt=<Instant>)",
      ]
    `);
  });

  test("skips reuse when a newer reservation exists", async () => {
    const { outcome, trace } = await recover({
      reservation: currentHeld,
      newerReservation: [true],
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_newer_reservation, completedAt=<Instant>)",
      ]
    `);
  });

  test("dies when the reservation disappears before release", async () => {
    const { cause, trace } = await recover({
      findByIdSequence: [expiredHeld, null],
    });

    expect(cause && Cause.hasDies(cause)).toBe(true);
    expect(cause && Cause.hasFails(cause)).toBe(false);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
      ]
    `);
  });

  test("dies when the reservation disappears after release", async () => {
    const { outcome, trace } = await recover({
      reservation: { ...expiredHeld, reservationState: "cancelled" },
      findByIdSequence: [
        { ...expiredHeld, reservationState: "cancelled" },
        { ...expiredHeld, reservationState: "cancelled" },
        null,
      ],
    });

    expect(outcome).toBe(
      "die: Late-payment recovery reservation disappeared after release."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call reservations.findById(reservation-id)",
      ]
    `);
  });
});

describe("LatePaymentRecoveryService.recover original hold release", () => {
  test("recreates an already released reservation without touching Dotypos", async () => {
    const { outcome, trace } = await recover({
      reservation: { ...expiredHeld, reservationState: "cancelled" },
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("requires review for a reservation in an unexpected state", async () => {
    const { outcome, trace } = await recover({
      reservation: { ...expiredHeld, reservationState: "confirmed" },
    });

    expect(outcome).toBe("review_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call recoveries.requireReview(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_reservation_state_unexpected, completedAt=<Instant>)",
      ]
    `);
  });

  test("waits for a fresh hold cancellation another workflow owns", async () => {
    const { outcome, trace } = await recover({
      reservation: {
        ...expiredHeld,
        reservationState: "cancelling",
        updatedAt: Temporal.Now.instant(),
      },
    });

    expect(outcome).toBe(
      "fail: Late-payment recovery is waiting for hold cancellation."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
      ]
    `);
  });

  test("takes over a stale hold cancellation instead of claiming it again", async () => {
    const { outcome, trace } = await recover({
      reservation: { ...expiredHeld, reservationState: "cancelling" },
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.takeOverStaleCancellation(id=reservation-id, staleBefore=<Instant>)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("requires review when Dotypos confirmed the original hold", async () => {
    const { outcome, trace } = await recover({ originalStatus: "CONFIRMED" });

    expect(outcome).toBe("review_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call recoveries.requireReview(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_original_confirmed, completedAt=<Instant>)",
      ]
    `);
  });

  test("retries when Dotypos returns an unsupported original hold status", async () => {
    const provider = dotyposResponse(
      "GET",
      `/clouds/test-cloud/reservations/${dotyposReservationId}`,
      Response.json({
        ...dotyposHoldFixture(dotyposReservationId),
        status: "COMPLETED",
      })
    );
    const { cause, outcome, trace } = await recover({
      getReservationStatus: (id) =>
        Effect.flatMap(DotyposService, (dotypos) =>
          dotypos.getReservationStatus(id)
        ).pipe(Effect.provide(provider)),
    });

    expect(outcome).toBe("fail: Late-payment recovery failed.");
    expect(cause && Cause.squash(cause)).toMatchObject({
      cause: {
        _tag: "DotyposRejected",
        request: "reservation.status",
        reason: "invalid-response",
      },
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "span getReservationStatus",
        "span POST",
        "span GET",
      ]
    `);
  });

  test("retries when the original hold's cancellation can't be claimed", async () => {
    const { outcome, trace } = await recover({ claimCancellation: false });

    expect(outcome).toBe(
      "fail: Late-payment recovery could not claim the original hold cancellation."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
      ]
    `);
  });

  test("records a cancellation Dotypos already made without cancelling again", async () => {
    const { outcome, trace } = await recover({
      reservation: { ...expiredHeld, reservationState: "cancellation_failed" },
      originalStatus: "CANCELLED",
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("marks the cancellation failed and retries when Dotypos can't cancel the hold", async () => {
    const { outcome, trace } = await recover({
      cancelReservation: fail(
        new DotyposUnavailable({
          operation: "cancelReservation",
          reason: "timeout",
        })
      ),
    });

    expect(outcome).toBe("fail: Late-payment recovery failed.");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=reservation-id, claimedAt=<Instant>, failureCode=dotypos_cancel_failed)",
      ]
    `);
  });

  test("accepts a cancellation a concurrent cleanup finished", async () => {
    const { outcome, trace } = await recover({
      markCancelled: (row) => () =>
        Effect.suspend(() => {
          if (row.current !== null) {
            row.current = { ...row.current, reservationState: "cancelled" };
          }
          return Effect.fail(reservationStateError);
        }),
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("keeps the cancelled marker failure when no cleanup finished the cancellation", async () => {
    const { outcome, trace } = await recover({
      markCancelled: () => fail(reservationStateError),
    });

    expect(outcome).toBe("fail: Late-payment recovery failed.");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
      ]
    `);
  });
});

describe("LatePaymentRecoveryService.recover reservation recreation", () => {
  test("recreates a cowork reservation from its snapshot", async () => {
    const { outcome, trace, calls } = await recover({});

    expect(outcome).toBe("recovered");
    expect(calls.ensureAvailable.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "coffee": true,
            "date": "2099-01-01",
            "entryTier": "basic",
            "kind": "cowork",
          },
        ],
      ]
    `);
    expect(calls.createReservation.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "customerId": "dotypos-customer-id",
            "endDate": 2099-01-01T23:00:00.000Z,
            "note": 
      "Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč"
      ,
            "seats": 1,
            "startDate": 2098-12-31T23:00:00.000Z,
            "status": "CONFIRMED",
            "tableId": "table-id",
          },
        ],
      ]
    `);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("recreates an early-setup meeting room from its snapshot", async () => {
    const { outcome, calls } = await recover({
      reservation: {
        ...expiredHeld,
        reservationDetails: {
          kind: "meeting-room",
          duration: { unit: "hour", amount: 4 },
          earlySetup: true,
        },
      },
      snapshot: Schema.decodeUnknownSync(
        meetingRoomAccountingDocumentSnapshotSchema
      )(makeMeetingRoomInvoiceDocument("cs-CZ")),
    });

    expect(outcome).toBe("recovered");
    expect(calls.ensureAvailable.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "duration": {
              "amount": 4,
              "unit": "hour",
            },
            "earlySetup": true,
            "endsAt": "2099-02-03T12:00:00Z",
            "kind": "meeting-room",
            "reservationDate": "2099-02-03",
            "startsAt": "2099-02-03T08:00:00Z",
          },
        ],
      ]
    `);
    expect(calls.createReservation.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "customerId": "dotypos-customer-id",
            "endDate": 2099-02-03T12:00:00.000Z,
            "note": 
      "Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Zasedací místnost
      Datum: 2099-02-03
      Čas: 2099-02-03T08:00:00Z-2099-02-03T12:00:00Z
      Délka: 4 hodiny
      Příprava od: 08:45
      Cena: 980 Kč"
      ,
            "seats": 1,
            "startDate": 2099-02-03T07:45:00.000Z,
            "status": "CONFIRMED",
            "tableId": "table-id",
          },
        ],
      ]
    `);
  });

  test("recreates an office reservation from its snapshot", async () => {
    const snapshot = Schema.decodeUnknownSync(
      officeAccountingDocumentSnapshotSchema
    )(makeOfficeInvoiceDocument("en-US"));
    const { outcome, calls } = await recover({
      reservation: {
        ...expiredHeld,
        reservationDetails: snapshot.reservation,
      },
      snapshot,
    });

    expect(outcome).toBe("recovered");
    expect(calls.ensureAvailable.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "endsOn": "2099-06-21",
            "kind": "office",
            "seats": 3,
            "startsOn": "2099-06-20",
          },
        ],
      ]
    `);
    expect(calls.createReservation.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "customerId": "dotypos-customer-id",
            "endDate": 2099-06-21T22:00:00.000Z,
            "note": 
      "Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Soukromá kancelář
      Termín: 2099-06-20-2099-06-21
      Počet míst: 3
      Cena: 2 950 Kč"
      ,
            "seats": 3,
            "startDate": 2099-06-19T22:00:00.000Z,
            "status": "CONFIRMED",
            "tableId": "table-id",
          },
        ],
      ]
    `);
  });

  test("refunds when the snapshot is unavailable", async () => {
    const { outcome, trace } = await recover({ snapshot: null });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_snapshot_unavailable, completedAt=<Instant>)",
      ]
    `);
  });

  test("refunds a newer reservation when the snapshot is unavailable", async () => {
    const { outcome, trace } = await recover({
      snapshot: null,
      newerReservation: [true],
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_newer_reservation, completedAt=<Instant>)",
      ]
    `);
  });

  test("refunds when the snapshot describes another kind of reservation", async () => {
    const { outcome, trace } = await recover({
      snapshot: Schema.decodeUnknownSync(
        meetingRoomAccountingDocumentSnapshotSchema
      )(makeMeetingRoomInvoiceDocument("en-US")),
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_snapshot_unavailable, completedAt=<Instant>)",
      ]
    `);
  });

  test("refunds a reservation that already ended", async () => {
    const document = Schema.decodeUnknownSync(
      coworkAccountingDocumentSnapshotSchema
    )(makeCoworkInvoiceDocument("en-US"));
    const { outcome, trace } = await recover({
      snapshot: {
        ...document,
        reservation: {
          kind: "cowork",
          date: plainDateStringSchema.make("2020-01-01"),
        },
      },
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_reservation_ended, completedAt=<Instant>)",
      ]
    `);
  });

  test("requires review when several replacements carry the recovery marker", async () => {
    const replacement = {
      status: "CONFIRMED" as const,
      note: "Booked online\nPayment order: reservation-id",
    };
    const { outcome, trace } = await recover({
      overlapping: [
        { ...replacement, id: "replacement-a" },
        { id: "unrelated", status: "NEW", note: null },
        { ...replacement, id: "replacement-b" },
      ],
    });

    expect(outcome).toBe("review_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call recoveries.requireReview(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_replacement_ambiguous, completedAt=<Instant>)",
      ]
    `);
  });

  test("cancels an orphaned replacement and refunds a newer reservation", async () => {
    const { outcome, trace } = await recover({
      newerReservation: [true],
      overlapping: [
        {
          id: "replacement-id",
          status: "NEW",
          note: "Payment order: reservation-id",
        },
      ],
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call dotypos.cancelReservation(replacement-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_newer_reservation, completedAt=<Instant>)",
      ]
    `);
  });

  test("resumes a held replacement an interrupted run created", async () => {
    const { outcome, trace } = await recover({
      overlapping: [
        {
          id: "replacement-id",
          status: "NEW",
          note: "Platební objednávka: reservation-id",
        },
      ],
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=held, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test("resumes a confirmed replacement an interrupted run created", async () => {
    const { outcome, trace } = await recover({
      overlapping: [
        {
          id: "replacement-id",
          status: "CONFIRMED",
          note: "Platební objednávka: reservation-id",
        },
      ],
    });

    expect(outcome).toBe("recovered");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call fulfillment.run(reservation-id)",
      ]
    `);
  });

  test.each([false, true])(
    "settles without a new provider write after the interval ends during the date wait (confirmed replacement: %s)",
    async (hasReplacement) => {
      const endsAt = Temporal.Instant.from(
        getCoworkReservationInterval("basic", "2099-01-01").endsAt
      );
      const { calls, outcome, trace } = await recover({
        endsWhileWaitingAt: endsAt,
        overlapping: hasReplacement
          ? [
              {
                id: "replacement-id",
                status: "CONFIRMED",
                note: "Platební objednávka: reservation-id",
              },
            ]
          : [],
      });

      expect(calls.createReservation).not.toHaveBeenCalled();
      if (hasReplacement) {
        expect(outcome).toBe("recovered");
        expect(trace).toContainEqual(
          expect.stringContaining(
            "recoveredDotyposReservationId=replacement-id, reservationState=confirmed"
          )
        );
      } else {
        expect(outcome).toBe("refund_required");
        expect(trace).toContainEqual(
          expect.stringContaining("failureCode=late_payment_reservation_ended")
        );
      }
    }
  );

  test("refunds when the slot is no longer available", async () => {
    const { outcome, trace } = await recover({
      ensureAvailable: fail(
        new WorkspaceTableUnavailableError({
          date: "2099-01-01",
          reservation: { kind: "cowork", entryTier: "basic" },
        })
      ),
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_reservation_unavailable, completedAt=<Instant>)",
      ]
    `);
  });

  test("refunds when no table can be assigned", async () => {
    const { outcome, trace } = await recover({
      assignTableId: fail(
        new TableAssignmentUnavailableError({
          requiredTags: ["tier:basic"],
          message: "No available Dotypos workspace table matches tags",
        })
      ),
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Error Workspace Dotypos reservation creation failed (cause=<TableAssignmentUnavailableError>) {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_reservation_unavailable, completedAt=<Instant>)",
      ]
    `);
  });

  test("retries when Dotypos returns no ID for a created replacement", async () => {
    const provider = dotyposResponse(
      "POST",
      "/clouds/test-cloud/reservations",
      Response.json([
        {
          ...dotyposHoldFixture("replacement-id"),
          id: "",
          status: "CONFIRMED",
        },
      ])
    );
    const { cause, outcome, trace } = await recover({
      createReservation: (input) =>
        Effect.flatMap(DotyposService, (dotypos) =>
          dotypos.createReservation(input)
        ).pipe(Effect.provide(provider)),
    });

    expect(outcome).toBe("fail: Late-payment recovery failed.");
    expect(cause && Cause.squash(cause)).toMatchObject({
      cause: {
        _tag: "DotyposUncertain",
        request: "reservation.create",
        reason: "invalid-response",
        message: "Reservation ID is required",
      },
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "span createReservation",
        "Info Dotypos reservation request build started {customerId,date,dotyposCustomerId,endsAt,entryTier,input,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,status,tableId} in createReservation",
        "Info Dotypos reservation API call started {customerId,date,dotyposCustomerId,endsAt,entryTier,input,locale,paymentOrderId,requestBody,reservationKind,reservationStatus,seats,startsAt,status,tableId} in createReservation",
        "span dotyposService.createReservation",
        "span POST",
        "span POST",
        "Error Workspace Dotypos reservation creation failed (cause=<DotyposUncertain>) {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
      ]
    `);
  });

  test("cancels the replacement and refunds when a newer reservation wins at settlement", async () => {
    const { outcome, trace } = await recover({
      newerReservation: [false, true],
      completeWithReplacement: fail(recoveryStateError),
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "call dotypos.cancelReservation(replacement-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_newer_reservation, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
      ]
    `);
  });

  test("cancels the replacement and refunds when an older reservation owns the checkout session", async () => {
    const { outcome, trace } = await recover({
      newerReservation: [false, false],
      completeWithReplacement: fail(
        new LatePaymentRecoverySessionTakenError({
          paymentAttemptId: recoveryStateError.paymentAttemptId,
        })
      ),
    });

    expect(outcome).toBe("refund_required");
    expect(
      trace.filter(
        (event) =>
          event.includes("cancelReservation(replacement-id)") ||
          event.includes("recoveries.requireRefund")
      )
    ).toEqual([
      "call dotypos.cancelReservation(replacement-id)",
      "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_checkout_session_taken, completedAt=<Instant>)",
    ]);
  });

  test("keeps a settlement conflict without a newer reservation retryable", async () => {
    const { outcome, trace } = await recover({
      completeWithReplacement: fail(recoveryStateError),
    });

    expect(outcome).toBe("fail: Late-payment recovery failed.");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
      ]
    `);
  });

  test("cancels the replacement and refunds when the discount is gone at settlement", async () => {
    const { outcome, trace } = await recover({
      completeWithReplacement: fail(discountClaimError),
    });

    expect(outcome).toBe("refund_required");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentRecovery.recover",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call reservations.hasAttachedOpenSpaceMove(reservation-id)",
        "call recoveries.claim(paymentAttemptId=attempt-id, staleProcessingBefore=<Instant>)",
        "call reservations.findById(reservation-id)",
        "call recoveries.hasNewerActiveReservation(reservation-id)",
        "span latePaymentRecovery.releaseOriginalHold",
        "span unpaidHoldRelease.release",
        "call reservations.findById(reservation-id)",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.claimCancellation(id=reservation-id, cause=late_payment)",
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=reservation-id, claimedAt=<Instant>, cancelledAt=<Instant>)",
        "call reservations.findById(reservation-id)",
        "span latePaymentRecovery.recreateReservation",
        "call snapshots.find(attempt-id)",
        "span normalizeReservationIntervalFields",
        "call dotypos.listActiveReservationsOverlapping(startDate=<Date>, endDate=<Date>)",
        "call availability.ensureAvailable(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "span createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation input received {date,entryTier,locale,paymentOrderId,reservationKind,reservationStatus} in createWorkspaceDotyposReservation",
        "span normalizeReservationIntervalFields",
        "call tableAssignments.assignTableId(kind=cowork, entryTier=basic, coffee=true, date=2099-01-01)",
        "Info Workspace Dotypos reservation input built {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "Info Workspace Dotypos reservation creation started {date,dotyposCustomerId,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        
      "call dotypos.createReservation(customerId=dotypos-customer-id, startDate=<Date>, endDate=<Date>, seats=1, tableId=table-id, status=CONFIRMED, note=Rezervace z Deskohub Workspace po zaplacení
      Platební objednávka: reservation-id
      Produkt: Basic Day Pass
      Datum: 2099-01-01
      Káva: ano
      Cena: 340 Kč)"
      ,
        "Info Workspace Dotypos reservation creation completed {date,dotyposCustomerId,dotyposReservationId,dotyposReservationStatus,endsAt,entryTier,locale,paymentOrderId,reservationKind,reservationStatus,seats,startsAt,tableId} in createWorkspaceDotyposReservation",
        "call recoveries.completeWithReplacement(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, recoveredDotyposReservationId=replacement-id, reservationState=confirmed, completedAt=<Instant>)",
        "call dotypos.cancelReservation(replacement-id)",
        "call recoveries.requireRefund(paymentAttemptId=attempt-id, workspaceReservationId=reservation-id, failureCode=late_payment_discount_unavailable, completedAt=<Instant>)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
      ]
    `);
  });
});
