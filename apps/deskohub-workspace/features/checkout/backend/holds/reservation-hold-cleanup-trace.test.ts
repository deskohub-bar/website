import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DotyposReservationIdSchema,
  DotyposService,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { Cause, Effect, Exit, Layer, Predicate } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  type EffectTrace,
  recordEffectTrace,
  startEffectTrace,
} from "@/shared/testing/effect-trace.test-utils";
import {
  expiredPaymentTransitionFixture,
  holdCleanupQueryFailure,
} from "./reservation-hold-cleanup.test-utils";

mock.module("server-only", () => ({}));

const { ReservationHoldCleanupService } = await import(
  "./reservation-hold-cleanup.service"
);
const { HoldCancellationInProgress, UnpaidHoldRelease } = await import(
  "./unpaid-hold-release.service"
);
const { ProviderPaymentDeferral, ProviderPaymentFinalizationService } =
  await import("../payment/provider-payment-finalization.service");
const { PaymentLifecycleRepository } = await import(
  "../repositories/payment-lifecycle.repository"
);
const { PaymentLifecycleStateError } = await import(
  "../repositories/payment-lifecycle-state"
);
const { WorkspaceReservationRepository, WorkspaceReservationStateError } =
  await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
const { CheckoutAnalytics } = await import(
  "../analytics/checkout-analytics.service"
);
const { silentCheckoutAnalytics } = await import(
  "../analytics/checkout-analytics.service.mock"
);

interface Collaborators {
  readonly reservations?: Partial<
    typeof WorkspaceReservationRepository.Service
  >;
  readonly paymentLifecycle?: Partial<
    typeof PaymentLifecycleRepository.Service
  >;
  readonly finalization?: Partial<
    typeof ProviderPaymentFinalizationService.Service
  >;
  readonly dotypos?: Partial<typeof DotyposService.Service>;
}

const orderId = workspaceReservationIdSchema.make(
  "0198c1a2-61c4-7e64-83f3-b3b69dc0dac5"
);
const checkedAt = Temporal.Instant.from("2026-07-01T08:00:00.000Z");
const holdExpiresAt = Temporal.Instant.from("2026-07-01T07:50:00.000Z");
const paymentAttemptId = paymentAttemptIdSchema.make("payment-attempt-id");

const heldOrder = workspaceReservationFixture({
  id: orderId,
  reservationState: "held",
  paymentState: "pending",
  fulfillmentState: "not_started",
  activePaymentAttemptId: paymentAttemptId,
  dotyposReservationId: DotyposReservationIdSchema.make(
    "dotypos-reservation-id"
  ),
  reservationHoldExpiresAt: holdExpiresAt,
  reservationConfirmedAt: null,
  paidAt: null,
  fulfilledAt: null,
});

/** Claimed long ago, so another cleanup may take the claim over. */
const cancellingOrder = workspaceReservationFixture({
  ...heldOrder,
  reservationState: "cancelling",
  updatedAt: Temporal.Instant.from("2026-07-01T08:00:00.500Z"),
});

const succeed =
  <const A>(value: A) =>
  () =>
    Effect.succeed(value);
const fail =
  <E>(error: E) =>
  () =>
    Effect.fail(error);

const paymentLifecycleStateError = new PaymentLifecycleStateError({
  operation: "markTerminal",
  paymentReference: { type: "paymentAttemptId", id: paymentAttemptId },
  message: "The payment attempt is no longer pending.",
});

const reservationStateError = new WorkspaceReservationStateError({
  operation: "markCancelled",
  reservationId: orderId,
  message: "The reservation is no longer cancelling.",
});

/** Collaborators of a cleanup that claims and cancels the held order. */
const cancellingCollaborators = (
  overrides: Collaborators = {}
): Collaborators => ({
  ...overrides,
  reservations: {
    findById: succeed(heldOrder),
    claimCancellation: succeed(cancellingOrder),
    takeOverStaleCancellation: succeed(cancellingOrder),
    markCancelled: succeed(undefined),
    markCancellationFailed: succeed(undefined),
    recordHoldCleanupSkipped: succeed(undefined),
    ...overrides.reservations,
  },
  paymentLifecycle: {
    markTerminal: succeed(
      expiredPaymentTransitionFixture(orderId, paymentAttemptId, checkedAt)
    ),
    ...overrides.paymentLifecycle,
  },
  finalization: {
    finalizePendingProviderPayment: succeed("terminal"),
    ...overrides.finalization,
  },
  dotypos: {
    getReservationStatus: succeed("NEW"),
    cancelReservation: succeed(undefined),
    ...overrides.dotypos,
  },
});

const cancelOrderHold = async (
  collaborators: Collaborators,
  input: { readonly checkedAt?: Temporal.Instant } = { checkedAt }
) => {
  const trace: EffectTrace = startEffectTrace();
  const record = <Methods extends object>(
    service: string,
    methods: Methods | undefined
  ) => trace.recordCalls(service, methods ?? {});
  const exit = await Effect.gen(function* () {
    const cleanup = yield* ReservationHoldCleanupService;
    return yield* recordEffectTrace(
      trace,
      cleanup.cancelOrderHold({
        orderId: orderId,
        holdExpiresAt,
        ...input,
      })
    );
  }).pipe(
    Effect.provide(
      ReservationHoldCleanupService.Default.pipe(
        Layer.provide(UnpaidHoldRelease.Default),
        Layer.provide(makeRecordingAdvisoryLock().layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(
              WorkspaceReservationRepository,
              record("reservations", collaborators.reservations)
            ),
            Layer.mock(
              PaymentLifecycleRepository,
              record("paymentLifecycle", collaborators.paymentLifecycle)
            ),
            Layer.mock(
              ProviderPaymentFinalizationService,
              record("finalization", collaborators.finalization)
            ),
            Layer.mock(
              DotyposService,
              record("dotypos", collaborators.dotypos)
            ),
            Layer.mock(
              CheckoutAnalytics,
              trace.recordCalls("checkoutAnalytics", silentCheckoutAnalytics)
            )
          )
        )
      )
    ),
    Effect.runPromise
  );
  return {
    outcome: outcomeOf(exit),
    failure: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
    trace: trace.entries,
  };
};

/** The success value, or the failure's message. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.squash(exit.cause);
  return Predicate.hasProperty(failure, "message") ? failure.message : failure;
};

const dotyposUnavailable = new DotyposUnavailable({
  operation: "cancelReservation",
  reason: "timeout",
});

describe("ReservationHoldCleanupService.cancelOrderHold trace", () => {
  test("fails when the order can't be loaded", async () => {
    const { outcome, trace } = await cancelOrderHold({
      reservations: {
        findById: fail(holdCleanupQueryFailure("reservations", "db down")),
      },
    });

    expect(outcome).toBe(
      "Reservation hold cancellation state could not be loaded."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
      ]
    `);
  });

  test("fails when provider finalization fails", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: {
          finalizePendingProviderPayment: fail(
            holdCleanupQueryFailure(
              "payment attempt lookup",
              "database unavailable during provider verification"
            )
          ),
        },
      })
    );

    expect(outcome).toBe(
      "Payment lifecycle finalization failed during hold cleanup."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
      ]
    `);
  });

  test("skips a hold whose provider payment finalized paid", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: { finalizePendingProviderPayment: succeed("paid") },
      })
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Warn Reservation hold cancellation skipped: provider finalized paid {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("defers a hold whose empty provider order is inside the abandonment window", async () => {
    const deferral = new ProviderPaymentDeferral({
      abandonmentCutoff: Temporal.Instant.from("2026-07-01T08:30:00.000Z"),
    });
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: { finalizePendingProviderPayment: succeed(deferral) },
      })
    );

    expect(outcome).toBe(deferral);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation deferred: empty provider order is inside abandonment window (abandonmentCutoff=<Instant>) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("expires an abandoned payment attempt, then cancels the hold", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: { finalizePendingProviderPayment: succeed("abandoned") },
      })
    );

    expect(outcome).toBe("cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation expiring payment attempt (reason=abandoned) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call paymentLifecycle.markTerminal(id=payment-attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=expired, failureCode=payment_abandoned_after_provider_cutoff)",
        "Info Reservation hold cancellation expired payment attempt (reason=abandoned) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentAttemptExpirationChanged,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentAttemptExpirationChanged,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, cancelledAt=<Instant>, holdExpiredAt=<Instant>)",
        "Info Reservation hold marked cancelled {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentAttemptExpirationChanged,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call checkoutAnalytics.reservationAbandoned(reservation=<Object>, timestamp=<Instant>)",
      ]
    `);
  });

  test("records a skipped cleanup when the abandoned attempt changed state", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: { finalizePendingProviderPayment: succeed("abandoned") },
        paymentLifecycle: { markTerminal: fail(paymentLifecycleStateError) },
      })
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation expiring payment attempt (reason=abandoned) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call paymentLifecycle.markTerminal(id=payment-attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=expired, failureCode=payment_abandoned_after_provider_cutoff)",
        "Warn Reservation hold cancellation payment attempt expiration failed (orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, cause=<PaymentLifecycleStateError>) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Warn Reservation hold cancellation skipped: payment attempt state changed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.recordHoldCleanupSkipped(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, holdExpiredAt=<Instant>, failureCode=payment_outcome_unconfirmed_before_cleanup)",
      ]
    `);
  });

  test("fails when the abandoned attempt can't be expired", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: { finalizePendingProviderPayment: succeed("abandoned") },
        paymentLifecycle: {
          markTerminal: fail(
            holdCleanupQueryFailure("reservations", "db down")
          ),
        },
      })
    );

    expect(outcome).toBe(
      "Payment attempt expiration failed during hold cleanup."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation expiring payment attempt (reason=abandoned) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call paymentLifecycle.markTerminal(id=payment-attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=expired, failureCode=payment_abandoned_after_provider_cutoff)",
        "Warn Reservation hold cancellation payment attempt expiration failed (orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, cause=<EffectDrizzleQueryError>) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("records a skipped sweep cleanup while the payment outcome is unconfirmed", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: { finalizePendingProviderPayment: succeed("pending") },
      })
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Warn Reservation hold cancellation skipped: payment outcome unconfirmed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.recordHoldCleanupSkipped(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, holdExpiredAt=<Instant>, failureCode=payment_outcome_unconfirmed_before_cleanup)",
      ]
    `);
  });

  test("skips an unscheduled cleanup while the payment outcome is unconfirmed without recording it", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: {
          finalizePendingProviderPayment: succeed(
            "provider_verification_failed"
          ),
        },
      }),
      {}
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Warn Reservation hold cancellation skipped: payment outcome unconfirmed {abandonmentCutoff,activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("fails when the skipped cleanup can't be recorded", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        finalization: { finalizePendingProviderPayment: succeed("not_found") },
        reservations: {
          recordHoldCleanupSkipped: fail(
            holdCleanupQueryFailure("reservations", "db down")
          ),
        },
      })
    );

    expect(outcome).toBe(
      "Skipped reservation hold cleanup marker could not be stored."
    );
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Warn Reservation hold cancellation skipped: payment outcome unconfirmed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.recordHoldCleanupSkipped(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, holdExpiredAt=<Instant>, failureCode=payment_outcome_unconfirmed_before_cleanup)",
      ]
    `);
  });

  test("cancels an unscheduled hold whose attempt is already terminal", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators(),
      {}
    );

    expect(outcome).toBe("cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, cancelledAt=<Instant>, holdExpiredAt=undefined)",
        "Info Reservation hold marked cancelled {abandonmentCutoff,activePaymentAttemptId,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call checkoutAnalytics.reservationAbandoned(reservation=<Object>, timestamp=<Instant>)",
      ]
    `);
  });

  test("claims an order without a pending payment directly", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: {
          findById: succeed({ ...heldOrder, paymentState: "failed" }),
        },
      })
    );

    expect(outcome).toBe("cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, cancelledAt=<Instant>, holdExpiredAt=<Instant>)",
        "Info Reservation hold marked cancelled {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call checkoutAnalytics.reservationAbandoned(reservation=<Object>, timestamp=<Instant>)",
      ]
    `);
  });

  test("fails when the cancellation can't be claimed", async () => {
    const dbDown = holdCleanupQueryFailure("reservations", "db down");
    const { failure, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: { claimCancellation: fail(dbDown) },
      })
    );

    expect(failure).toMatchObject({
      _tag: "ReservationHoldCleanupError",
      cause: dbDown,
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
      ]
    `);
  });

  test("takes over a stale cancellation an interrupted run left", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: {
          findById: succeed(cancellingOrder),
          claimCancellation: succeed(null),
        },
      })
    );

    expect(outcome).toBe("cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=false) {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in unpaidHoldRelease.release",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "call reservations.takeOverStaleCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, staleBefore=<Instant>, expectedHold=<Object>)",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, cancelledAt=<Instant>, holdExpiredAt=<Instant>)",
        "Info Reservation hold marked cancelled {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call checkoutAnalytics.reservationAbandoned(reservation=<Object>, timestamp=<Instant>)",
      ]
    `);
  });

  test("leaves a fresh cancellation to the run that claimed it", async () => {
    const claimedAt = Temporal.Now.instant();
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: {
          findById: succeed({ ...cancellingOrder, updatedAt: claimedAt }),
          claimCancellation: succeed(null),
        },
      })
    );

    assert(outcome instanceof HoldCancellationInProgress);
    expect(outcome.staleAt.toString()).toBe(
      claimedAt.add({ minutes: 10 }).toString()
    );
    expect(trace.some((entry) => entry.startsWith("call dotypos."))).toBe(
      false
    );
  });

  test("leaves an order whose hold was replaced since the cleanup was scheduled", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: {
          findById: succeed({
            ...heldOrder,
            reservationHoldExpiresAt: holdExpiresAt.add({ minutes: 20 }),
          }),
        },
      })
    );

    expect(outcome).toBe("not_due");
    expect(
      trace.filter((entry) => entry.startsWith("call ")).map((entry) => entry)
    ).toEqual([
      "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
    ]);
  });

  test("does nothing for a missing order", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: {
          findById: succeed(null),
          claimCancellation: succeed(null),
        },
      })
    );

    expect(outcome).toBe("not_due");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation skipped: hold not due {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("fails when an already claimed cancellation can't be reloaded", async () => {
    const dbDown = holdCleanupQueryFailure("reservations", "db down");
    const findById = mock<
      typeof WorkspaceReservationRepository.Service.findById
    >(fail(dbDown));
    findById.mockImplementationOnce(succeed(cancellingOrder));
    const { failure, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: { findById, claimCancellation: succeed(null) },
      })
    );

    expect(failure).toMatchObject({
      _tag: "ReservationHoldCleanupError",
      cause: dbDown,
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=false) {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in unpaidHoldRelease.release",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
      ]
    `);
  });

  test("skips a claim without a Dotypos reservation", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: {
          claimCancellation: succeed({
            ...cancellingOrder,
            dotyposReservationId: null,
          }),
        },
      })
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "Warn Reservation hold cancellation skipped: missing Dotypos reservation {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
      ]
    `);
  });

  test("skips a claim that was paid meanwhile", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: {
          claimCancellation: succeed({
            ...cancellingOrder,
            paymentState: "paid",
          }),
        },
      })
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "Warn Reservation hold cancellation skipped: reservation paid {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
      ]
    `);
  });

  test("marks the cancellation failed when Dotypos can't cancel the hold", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        dotypos: { cancelReservation: fail(dotyposUnavailable) },
      })
    );

    expect(outcome).toBe("Dotypos reservation hold could not be cancelled.");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, failureCode=dotypos_cancel_failed)",
        "Error Dotypos reservation hold cancellation failed (cause=<DotyposUnavailable>) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("marks a hold Dotypos already cancelled as cancelled without cancelling it again", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        dotypos: { getReservationStatus: succeed("CANCELLED") },
      })
    );

    expect(outcome).toBe("cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.markCancelled(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, cancelledAt=<Instant>, holdExpiredAt=<Instant>)",
        "Info Reservation hold marked cancelled {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call checkoutAnalytics.reservationAbandoned(reservation=<Object>, timestamp=<Instant>)",
      ]
    `);
  });

  test("skips a hold Dotypos confirmed, marking its cancellation failed without analytics", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        dotypos: { getReservationStatus: succeed("CONFIRMED") },
      })
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, failureCode=dotypos_cancel_failed)",
        "Error Reservation hold cancellation refused: Dotypos kept the hold (orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, dotyposStatus=CONFIRMED) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("fails when the hold's Dotypos status can't be read, after marking its cancellation failed", async () => {
    const statusUnavailable = new DotyposUnavailable({
      operation: "getReservationStatus",
      reason: "timeout",
    });
    const { failure, trace } = await cancelOrderHold(
      cancellingCollaborators({
        dotypos: { getReservationStatus: fail(statusUnavailable) },
      })
    );

    expect(failure).toMatchObject({
      _tag: "ReservationHoldCleanupError",
      cause: statusUnavailable,
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, failureCode=dotypos_cancel_failed)",
        "Error Dotypos reservation hold cancellation failed (cause=<DotyposUnavailable>) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("skips the cancelled marker when the reservation state changed", async () => {
    const { outcome, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: { markCancelled: fail(reservationStateError) },
      })
    );

    expect(outcome).toBe("skipped");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, cancelledAt=<Instant>, holdExpiredAt=<Instant>)",
        "Warn Reservation hold cancellation marker skipped: reservation state changed (orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
      ]
    `);
  });

  test("fails when the cancelled marker can't be stored", async () => {
    const dbDown = holdCleanupQueryFailure("reservations", "db down");
    const { failure, trace } = await cancelOrderHold(
      cancellingCollaborators({
        reservations: { markCancelled: fail(dbDown) },
      })
    );

    expect(failure).toMatchObject({
      _tag: "ReservationHoldCleanupError",
      cause: dbDown,
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation started {checkedAt,holdExpiresAt,orderId} in reservationHoldCleanup.cancelOrderHold",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Reservation hold cancellation active reservation loaded {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "Info Reservation hold cancellation provider finalization started {activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "call finalization.finalizePendingProviderPayment(orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, paymentAttemptId=payment-attempt-id, abandonmentCheckedAt=<Instant>)",
        "Info Reservation hold cancellation provider finalization completed {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in reservationHoldCleanup.cancelOrderHold",
        "span unpaidHoldRelease.release",
        "call reservations.claimCancellation(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, expectedHold=<Object>, cause=hold_expired)",
        "Debug Reservation hold cancellation claim completed (claimedFromNew=true) {abandonmentCutoff,activePaymentAttemptId,checkedAt,dotyposReservationId,fulfillmentState,holdExpiresAt,orderId,paymentState,providerFinalizationResult,reservationId,reservationState} in unpaidHoldRelease.release",
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancelled(id=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, claimedAt=<Instant>, cancelledAt=<Instant>, holdExpiredAt=<Instant>)",
      ]
    `);
  });
});
