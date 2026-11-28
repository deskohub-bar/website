import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import { ExternalAPIError, NetworkError, NexiService } from "@deskohub/nexi";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Exit, Layer, Predicate } from "effect";
import type { PaymentAttemptState } from "@/db/schema";
import {
  type EffectTrace,
  recordEffectTrace,
  startEffectTrace,
} from "@/shared/testing/effect-trace.test-utils";
import { nexiVerificationFixture } from "./nexi-verification.test-utils";
import { withReservationPaymentHandlers } from "./order-payment-handlers.test-utils";
import {
  type PaymentProviderAdapter,
  PaymentProviders,
  type PaymentVerification,
} from "./payment-provider";
import { PaymentProvidersFromNexi } from "./payment-providers";
import type { IProviderPaymentFinalizationService } from "./provider-payment-finalization.service";
import {
  attemptCreatedAt,
  orderId,
  paidReservation,
  paymentAttemptId,
  pendingAttempt,
  pendingReservation,
  providerOrderId,
  reservationId,
  unattachedAttempt,
} from "./provider-payment-finalization.test-utils";

mock.module("server-only", () => ({}));

const { ProviderPaymentFinalizationService } = await import(
  "./provider-payment-finalization.service"
);
const { PaymentAttemptRepository } = await import(
  "../repositories/payment-attempt.repository"
);
const { PaymentLifecycleRepository } = await import(
  "../repositories/payment-lifecycle.repository"
);
const { PaymentLifecycleStateError } = await import(
  "../repositories/payment-lifecycle-state"
);
const { PaidFulfillmentQueueService, PaidFulfillmentQueueError } = await import(
  "../fulfillment/paid-fulfillment-queue.service"
);
const { ReservationFulfillment, WorkspacePaidFulfillmentError } = await import(
  "../fulfillment/reservation-fulfillment.service"
);
const { WorkspaceReservationRepository } = await import(
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
  readonly paymentAttempts?: Partial<typeof PaymentAttemptRepository.Service>;
  readonly paymentLifecycle?: Partial<
    typeof PaymentLifecycleRepository.Service
  >;
  readonly nexi?: Partial<typeof NexiService.Service>;
  readonly paidFulfillmentQueue?: Partial<
    typeof PaidFulfillmentQueueService.Service
  >;
  readonly fulfillment?: Partial<typeof ReservationFulfillment.Service>;
}

type FinalizationInput = Omit<
  Parameters<
    IProviderPaymentFinalizationService["finalizePendingProviderPayment"]
  >[0],
  "orderId"
>;

const insideWindow = attemptCreatedAt.add({ minutes: 29, seconds: 59 });
const afterCutoff = attemptCreatedAt.add({ minutes: 30 });

const succeed =
  <A>(value: A) =>
  () =>
    Effect.succeed(value);
const fail =
  <E>(error: E) =>
  () =>
    Effect.fail(error);

const emptyPendingProvider = {
  operationId: undefined,
  operationCount: 0,
  authorizedAmount: "0",
  capturedAmount: "0.00",
  orderStatus: "PENDING",
  captureExecuted: false,
};

const lifecycleTransition = (changed: boolean, state: PaymentAttemptState) => ({
  attempt: { ...pendingAttempt, state },
  changed,
  timestamp: afterCutoff,
});

const lifecycleStateError = new PaymentLifecycleStateError({
  operation: "markPaid",
  paymentReference: { type: "paymentAttemptId", id: paymentAttemptId },
  message: "The payment attempt is no longer pending.",
});

const queryFailure = new EffectDrizzleQueryError({
  query: "test query",
  params: [],
  cause: new Error("db down"),
});

/** Collaborators of a finalization that reaches Nexi verification. */
const verifyingCollaborators = (
  overrides: Collaborators = {}
): Collaborators => ({
  ...overrides,
  reservations: {
    findById: succeed(pendingReservation),
    ...overrides.reservations,
  },
  paymentAttempts: {
    findById: succeed(pendingAttempt),
    ...overrides.paymentAttempts,
  },
  paymentLifecycle: {
    markPaid: succeed(lifecycleTransition(true, "paid")),
    markTerminal: succeed(lifecycleTransition(true, "failed")),
    ...overrides.paymentLifecycle,
  },
  nexi: {
    verifyPaymentOutcome: succeed(nexiVerificationFixture("success")),
    ...overrides.nexi,
  },
  paidFulfillmentQueue: {
    enqueue: succeed(undefined),
    ...overrides.paidFulfillmentQueue,
  },
  fulfillment: { run: succeed(undefined), ...overrides.fulfillment },
});

/** Collaborators of a finalization whose attempt never attached a session. */
const unattachedCollaborators = (overrides: Collaborators = {}) =>
  verifyingCollaborators({
    ...overrides,
    paymentAttempts: { findById: succeed(unattachedAttempt) },
    nexi: {
      getOrder: succeed({ orderId: providerOrderId, operations: [] }),
      ...overrides.nexi,
    },
  });

const finalize = async (
  collaborators: Collaborators,
  input: FinalizationInput = { paymentAttemptId },
  providers?: Layer.Layer<PaymentProviders>
) => {
  const trace: EffectTrace = startEffectTrace();
  const record = <Methods extends object>(
    service: string,
    methods: Methods | undefined
  ) => trace.recordCalls(service, methods ?? {});
  const exit = await Effect.gen(function* () {
    const finalization = yield* ProviderPaymentFinalizationService;
    return yield* recordEffectTrace(
      trace,
      finalization.finalizePendingProviderPayment({ orderId, ...input })
    );
  }).pipe(
    Effect.provide(
      ProviderPaymentFinalizationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(
              WorkspaceReservationRepository,
              record("reservations", collaborators.reservations)
            ),
            Layer.mock(
              PaymentAttemptRepository,
              record("paymentAttempts", collaborators.paymentAttempts)
            ),
            Layer.mock(
              PaymentLifecycleRepository,
              record("paymentLifecycle", collaborators.paymentLifecycle)
            ),
            providers ??
              PaymentProvidersFromNexi.pipe(
                Layer.provide(
                  Layer.mock(NexiService, record("nexi", collaborators.nexi))
                )
              ),
            Layer.mock(
              PaidFulfillmentQueueService,
              record("paidFulfillmentQueue", collaborators.paidFulfillmentQueue)
            ),
            Layer.mock(
              ReservationFulfillment,
              record("fulfillment", collaborators.fulfillment)
            ),
            Layer.mock(
              CheckoutAnalytics,
              trace.recordCalls("checkoutAnalytics", silentCheckoutAnalytics)
            )
          ).pipe(withReservationPaymentHandlers)
        )
      )
    ),
    Effect.runPromise
  );
  return { outcome: outcomeOf(exit), trace: trace.entries };
};

/** The success value, or the failure's tag. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.squash(exit.cause);
  return Predicate.hasProperty(failure, "_tag") ? failure._tag : failure;
};

const queueDown = new PaidFulfillmentQueueError({ message: "queue down" });

describe("ProviderPaymentFinalizationService.finalizePendingProviderPayment trace", () => {
  test("verifies the stored mock attempt without selecting a provider again", async () => {
    const verify = mock(() =>
      Effect.succeed<PaymentVerification>({
        status: "failure",
        hasActivity: true,
        mismatches: [],
        failureCode: "mock_payment_failed",
        providerStatus: "declined",
        terminalState: "failed",
      })
    );
    const forAttempt = mock(
      (): PaymentProviderAdapter => ({
        unconfirmedSessionFailureCode: "mock_payment_session_unconfirmed",
        prepareSession: () => Effect.die("not used"),
        lookup: () => Effect.die("not used"),
        verify,
      })
    );
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentAttempts: {
          findById: succeed({ ...pendingAttempt, provider: "mock" }),
        },
      }),
      undefined,
      Layer.mock(PaymentProviders, {
        selectForCustomer: () => Effect.die("unexpected provider selection"),
        activeProviders: ["nexi", "mock"],
        forAttempt,
      })
    );

    expect(forAttempt).toHaveBeenCalledWith("mock");
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ amount: pendingAttempt.amount })
    );
    expect(outcome).toBe("terminal");
    expect(trace).toContainEqual(
      expect.stringContaining("failureCode=mock_payment_failed")
    );
  });

  test("returns not_found when the reservation can't be loaded", async () => {
    const { outcome, trace } = await finalize({
      reservations: { findById: fail(queryFailure) },
    });

    expect(outcome).toBe("not_found");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Error Payment finalization order lookup failed (orderId=00000000-0000-4000-8000-000000000001, cause=<EffectDrizzleQueryError>) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned not_found {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_found) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_found for a missing reservation", async () => {
    const { outcome, trace } = await finalize({
      reservations: { findById: succeed(null) },
    });

    expect(outcome).toBe("not_found");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned not_found {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_found) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_found without an input or active payment attempt", async () => {
    const { outcome, trace } = await finalize(
      {
        reservations: {
          findById: succeed({
            ...pendingReservation,
            activePaymentAttemptId: null,
          }),
        },
      },
      {}
    );

    expect(outcome).toBe("not_found");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned not_found {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_found) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("uses the reservation's active attempt without an input attempt", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: fail(
            new NetworkError({ message: "nexi down" })
          ),
        },
      }),
      {}
    );

    expect(outcome).toBe("provider_verification_failed");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Error Provider payment outcome verification failed (orderId=00000000-0000-4000-8000-000000000001, paymentAttemptId=attempt-id, providerOrderId=provider-order-id, cause=<PaymentProviderError>) {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned provider_verification_failed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=provider_verification_failed) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("enqueues fulfillment for an already-paid not_started reservation", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: { findById: succeed(paidReservation("not_started")) },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization enqueueing fulfillment for already-paid order {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Info Payment finalization fulfillment enqueued {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("enqueues fulfillment for an already-paid processing reservation", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: { findById: succeed(paidReservation("processing")) },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization enqueueing fulfillment for already-paid order {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Info Payment finalization fulfillment enqueued {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("fulfills inline when the queue is unavailable", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: { findById: succeed(paidReservation("not_started")) },
        paidFulfillmentQueue: { enqueue: fail(queueDown) },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization enqueueing fulfillment for already-paid order {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Error Paid order fulfillment could not be enqueued; fulfilling inline (orderId=00000000-0000-4000-8000-000000000001, cause=<PaidFulfillmentQueueError>) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "call fulfillment.run(00000000-0000-4000-8000-000000000001)",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("ignores an inline fulfillment failure after the queue is unavailable", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: { findById: succeed(paidReservation("not_started")) },
        paidFulfillmentQueue: { enqueue: fail(queueDown) },
        fulfillment: {
          run: fail(
            new WorkspacePaidFulfillmentError({
              orderId: reservationId,
              failureCode: "dotypos_reservation_failed",
              message: "dotypos down",
            })
          ),
        },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization enqueueing fulfillment for already-paid order {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Error Paid order fulfillment could not be enqueued; fulfilling inline (orderId=00000000-0000-4000-8000-000000000001, cause=<PaidFulfillmentQueueError>) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "call fulfillment.run(00000000-0000-4000-8000-000000000001)",
        "Fatal Paid order fulfillment failed during finalization (orderId=00000000-0000-4000-8000-000000000001, cause=<WorkspacePaidFulfillmentError>) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns paid for an already-paid awaiting_delivery reservation", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: {
          findById: succeed(paidReservation("awaiting_delivery")),
        },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned paid for fulfilled order {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns paid for an already-paid fulfilled reservation", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: { findById: succeed(paidReservation("fulfilled")) },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned paid for fulfilled order {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_pending for a paid reservation whose fulfillment failed", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: { findById: succeed(paidReservation("failed")) },
      })
    );

    expect(outcome).toBe("not_pending");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned not_pending {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_pending) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_pending for a reservation whose payment ended", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        reservations: {
          findById: succeed({ ...pendingReservation, paymentState: "failed" }),
        },
      })
    );

    expect(outcome).toBe("not_pending");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned not_pending {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_pending) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_verifiable when the attempt can't be loaded", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentAttempts: { findById: fail(queryFailure) },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Error Payment finalization attempt lookup failed (orderId=00000000-0000-4000-8000-000000000001, paymentAttemptId=attempt-id, cause=<EffectDrizzleQueryError>) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned not_verifiable {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_verifiable) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_verifiable for a missing attempt", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({ paymentAttempts: { findById: succeed(null) } })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned not_verifiable {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_verifiable) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_verifiable for an attempt without a provider order", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentAttempts: {
          findById: succeed({ ...pendingAttempt, providerOrderId: null }),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned not_verifiable {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_verifiable) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_verifiable for a pending attempt without a security token", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentAttempts: {
          findById: succeed({ ...pendingAttempt, securityToken: null }),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned not_verifiable {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_verifiable) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_verifiable when the attempt currency doesn't decode", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentAttempts: {
          findById: succeed({
            ...pendingAttempt,
            amount: { ...pendingAttempt.amount, currency: "XXX" },
          }),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "Error Provider payment outcome verification failed (orderId=00000000-0000-4000-8000-000000000001, paymentAttemptId=attempt-id, providerOrderId=provider-order-id, cause=<PaymentProviderError>) {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned not_verifiable {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_verifiable) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns provider_verification_failed when Nexi verification fails", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: fail(
            new NetworkError({ message: "Failed to connect to Nexi" })
          ),
        },
      }),
      {
        paymentAttemptId,
        verificationDeadline: "15 seconds",
      }
    );

    expect(outcome).toBe("provider_verification_failed");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=15 seconds)",
        "Error Provider payment outcome verification failed (orderId=00000000-0000-4000-8000-000000000001, paymentAttemptId=attempt-id, providerOrderId=provider-order-id, cause=<PaymentProviderError>) {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned provider_verification_failed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=provider_verification_failed) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns verification_mismatch when the provider facts disagree", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(
            nexiVerificationFixture("success", {}, ["amount", "securityToken"])
          ),
        },
      })
    );

    expect(outcome).toBe("verification_mismatch");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Warn Payment finalization returned verification_mismatch {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=verification_mismatch) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("marks a verified created attempt with a security token paid", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentAttempts: {
          findById: succeed({ ...pendingAttempt, state: "created" }),
        },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark paid started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Debug Payment finalization mark paid completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Info Payment finalization fulfillment enqueued {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("marks a successful payment paid, captures it and enqueues fulfillment", async () => {
    const { outcome, trace } = await finalize(verifyingCollaborators(), {
      paymentAttemptId,
      webhookEventId: "webhook-event-id",
      verificationDeadline: "15 seconds",
    });

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=15 seconds)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark paid started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, webhookEventId=webhook-event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Debug Payment finalization mark paid completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Info Payment finalization fulfillment enqueued {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("derives the provider status of a successful payment without an order status", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(
            nexiVerificationFixture("success", { orderStatus: undefined })
          ),
        },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark paid started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=capture_executed, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Debug Payment finalization mark paid completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Info Payment finalization fulfillment enqueued {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("skips the completed capture when the attempt was already paid", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentLifecycle: {
          markPaid: succeed(lifecycleTransition(false, "paid")),
        },
      })
    );

    expect(outcome).toBe("paid");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark paid started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "Debug Payment finalization mark paid completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.enqueueFulfillment",
        "call paidFulfillmentQueue.enqueue(orderId=00000000-0000-4000-8000-000000000001)",
        "Info Payment finalization fulfillment enqueued {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.enqueueFulfillment",
        "Info Provider payment finalization completed (result=paid) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_pending when the attempt changed before it could be marked paid", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentLifecycle: { markPaid: fail(lifecycleStateError) },
      })
    );

    expect(outcome).toBe("not_pending");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark paid started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "Warn Payment finalization mark paid returned not_pending (cause=<PaymentLifecycleStateError>) {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_pending) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("fails when marking paid fails to persist", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        paymentLifecycle: { markPaid: fail(queryFailure) },
      })
    );

    expect(outcome).toBe(queryFailure._tag);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark paid started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
      ]
    `);
  });

  test("marks a declined payment failed and captures the failure", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(nexiVerificationFixture("failure")),
        },
      }),
      { paymentAttemptId, webhookEventId: "webhook-event-id" }
    );

    expect(outcome).toBe("terminal");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark terminal started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=failed, failureCode=nexi_payment_failed, webhookEventId=webhook-event-id, providerOperationId=operation-id, providerStatus=DECLINED)",
        "call checkoutAnalytics.paymentFailed(attempt=<Object>, failureReason=nexi_payment_failed, timestamp=<Instant>)",
        "Debug Payment finalization mark terminal completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=terminal) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("marks a cancelled payment cancelled and captures the abandonment", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(
            nexiVerificationFixture("failure", { orderStatus: "CANCELED" })
          ),
        },
        paymentLifecycle: {
          markTerminal: succeed(lifecycleTransition(true, "cancelled")),
        },
      })
    );

    expect(outcome).toBe("terminal");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark terminal started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=cancelled, failureCode=nexi_payment_failed, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=CANCELED)",
        "call checkoutAnalytics.paymentAbandoned(attempt=<Object>, timestamp=<Instant>)",
        "Debug Payment finalization mark terminal completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=terminal) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("marks an expired payment expired and captures the abandonment", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(
            nexiVerificationFixture("failure", { orderStatus: "EXPIRED" })
          ),
        },
        paymentLifecycle: {
          markTerminal: succeed(lifecycleTransition(true, "expired")),
        },
      })
    );

    expect(outcome).toBe("terminal");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark terminal started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=expired, failureCode=nexi_payment_failed, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=EXPIRED)",
        "call checkoutAnalytics.paymentAbandoned(attempt=<Object>, timestamp=<Instant>)",
        "Debug Payment finalization mark terminal completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=terminal) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("skips the terminal capture when the attempt was already terminal", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(nexiVerificationFixture("failure")),
        },
        paymentLifecycle: {
          markTerminal: succeed(lifecycleTransition(false, "failed")),
        },
      })
    );

    expect(outcome).toBe("terminal");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark terminal started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=failed, failureCode=nexi_payment_failed, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=DECLINED)",
        "Debug Payment finalization mark terminal completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=terminal) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns not_pending when the attempt changed before it could be marked terminal", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(nexiVerificationFixture("failure")),
        },
        paymentLifecycle: { markTerminal: fail(lifecycleStateError) },
      })
    );

    expect(outcome).toBe("not_pending");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark terminal started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=failed, failureCode=nexi_payment_failed, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=DECLINED)",
        "Warn Payment finalization mark terminal returned not_pending (cause=<PaymentLifecycleStateError>) {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=not_pending) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("fails when marking terminal fails to persist", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(nexiVerificationFixture("failure")),
        },
        paymentLifecycle: { markTerminal: fail(queryFailure) },
      })
    );

    expect(outcome).toBe(queryFailure._tag);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization mark terminal started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,failureKind,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=failed, failureCode=nexi_payment_failed, webhookEventId=undefined, providerOperationId=operation-id, providerStatus=DECLINED)",
      ]
    `);
  });

  test("returns pending for a pending provider order with payment activity", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(nexiVerificationFixture("pending")),
        },
      }),
      { paymentAttemptId, abandonmentCheckedAt: afterCutoff }
    );

    expect(outcome).toBe("pending");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned pending {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=pending) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("waits for the payment of an empty provider order outside hold cleanup", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(
            nexiVerificationFixture("pending", emptyPendingProvider)
          ),
        },
      })
    );

    expect(outcome).toBe("awaiting_payment");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization returned awaiting_payment {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=awaiting_payment) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("defers an empty provider order inside the abandonment window", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(
            nexiVerificationFixture("pending", emptyPendingProvider)
          ),
        },
      }),
      { paymentAttemptId, abandonmentCheckedAt: insideWindow }
    );

    expect(outcome).toEqual({
      _tag: "ProviderPaymentDeferral",
      abandonmentCutoff: afterCutoff,
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization resolved empty provider order (result=deferred) {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=<ProviderPaymentDeferral>) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("returns abandoned for an empty provider order past the abandonment window", async () => {
    const { outcome, trace } = await finalize(
      verifyingCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(
            nexiVerificationFixture("pending", emptyPendingProvider)
          ),
        },
      }),
      { paymentAttemptId, abandonmentCheckedAt: afterCutoff }
    );

    expect(outcome).toBe("abandoned");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization provider verification started {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Payment finalization provider verification completed {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,providerOrderStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Debug Payment finalization provider metadata resolved {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Payment finalization resolved empty provider order (result=abandoned) {abandonmentCheckedAt,activePaymentAttemptId,currency,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,verificationDeadlineMillis,verificationMismatches,verificationStatus,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization completed (result=abandoned) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });
});

describe("ProviderPaymentFinalizationService unattached provider session trace", () => {
  test("leaves an unattached session for hold cleanup outside it", async () => {
    const { outcome, trace } = await finalize(unattachedCollaborators());

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.resolveUnattachedProviderSession",
        "Warn Payment finalization left an unattached provider session for hold cleanup {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Provider payment finalization completed (result=not_verifiable) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("defers an unattached session inside the abandonment window", async () => {
    const { outcome, trace } = await finalize(unattachedCollaborators(), {
      paymentAttemptId,
      abandonmentCheckedAt: insideWindow,
    });

    expect(outcome).toEqual({
      _tag: "ProviderPaymentDeferral",
      abandonmentCutoff: afterCutoff,
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Payment finalization deferred an unattached provider session {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Provider payment finalization completed (result=<ProviderPaymentDeferral>) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("fails an unattached session whose provider order was never created", async () => {
    const { outcome, trace } = await finalize(
      unattachedCollaborators({
        nexi: {
          getOrder: fail(
            new ExternalAPIError({
              service: "Nexi",
              operation: "Get order",
              statusCode: 404,
            })
          ),
        },
      }),
      { paymentAttemptId, abandonmentCheckedAt: afterCutoff }
    );

    expect(outcome).toBe("terminal");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.resolveUnattachedProviderSession",
        "span NexiPaymentProvider.lookup",
        "call nexi.getOrder(orderId=provider-order-id, correlationId=correlation-id)",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=failed, failureCode=nexi_hpp_create_unconfirmed, providerStatus=hpp_create_unconfirmed, fromAttemptStates=<Array>)",
        "call checkoutAnalytics.paymentFailed(attempt=<Object>, failureReason=nexi_hpp_create_unconfirmed, timestamp=<Instant>)",
        "Info Payment finalization failed an unattached provider session (providerOrderFound=false) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Provider payment finalization completed (result=terminal) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("fails an unattached session whose empty provider order already failed", async () => {
    const { outcome, trace } = await finalize(
      unattachedCollaborators({
        paymentLifecycle: {
          markTerminal: succeed(lifecycleTransition(false, "failed")),
        },
      }),
      { paymentAttemptId, abandonmentCheckedAt: afterCutoff }
    );

    expect(outcome).toBe("terminal");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.resolveUnattachedProviderSession",
        "span NexiPaymentProvider.lookup",
        "call nexi.getOrder(orderId=provider-order-id, correlationId=correlation-id)",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=failed, failureCode=nexi_hpp_create_unconfirmed, providerStatus=hpp_create_unconfirmed, fromAttemptStates=<Array>)",
        "Info Payment finalization failed an unattached provider session (providerOrderFound=true) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Provider payment finalization completed (result=terminal) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("keeps an unattached session whose provider order has payment activity", async () => {
    const { outcome, trace } = await finalize(
      unattachedCollaborators({
        nexi: {
          getOrder: succeed({
            orderId: providerOrderId,
            operations: [{ operationType: "AUTHORIZATION" }],
          }),
        },
      }),
      { paymentAttemptId, abandonmentCheckedAt: afterCutoff }
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.resolveUnattachedProviderSession",
        "span NexiPaymentProvider.lookup",
        "call nexi.getOrder(orderId=provider-order-id, correlationId=correlation-id)",
        "Error Unattached provider session has payment activity and needs operator review {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Provider payment finalization completed (result=not_verifiable) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("keeps an unattached session when the provider order lookup fails", async () => {
    const { outcome, trace } = await finalize(
      unattachedCollaborators({
        nexi: {
          getOrder: fail(
            new ExternalAPIError({
              service: "Nexi",
              operation: "Get order",
              statusCode: 500,
            })
          ),
        },
      }),
      { paymentAttemptId, abandonmentCheckedAt: afterCutoff }
    );

    expect(outcome).toBe("provider_verification_failed");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.resolveUnattachedProviderSession",
        "span NexiPaymentProvider.lookup",
        "call nexi.getOrder(orderId=provider-order-id, correlationId=correlation-id)",
        "Error Unattached provider session order lookup failed (cause=<PaymentProviderError>) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Provider payment finalization completed (result=provider_verification_failed) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });

  test("yields to a provider session attached concurrently", async () => {
    const { outcome, trace } = await finalize(
      unattachedCollaborators({
        paymentLifecycle: { markTerminal: fail(lifecycleStateError) },
      }),
      { paymentAttemptId, abandonmentCheckedAt: afterCutoff }
    );

    expect(outcome).toBe("not_pending");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span providerPaymentFinalization.finalizePendingProviderPayment",
        "Info Provider payment finalization started {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call reservations.findById(00000000-0000-4000-8000-000000000001)",
        "Debug Payment finalization order lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentState,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "call paymentAttempts.findById(attempt-id)",
        "Debug Payment finalization attempt lookup completed {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
        "span providerPaymentFinalization.resolveUnattachedProviderSession",
        "span NexiPaymentProvider.lookup",
        "call nexi.getOrder(orderId=provider-order-id, correlationId=correlation-id)",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=00000000-0000-4000-8000-000000000001, state=failed, failureCode=nexi_hpp_create_unconfirmed, providerStatus=hpp_create_unconfirmed, fromAttemptStates=<Array>)",
        "Warn Unattached provider session changed before it could fail (cause=<PaymentLifecycleStateError>) {abandonmentCheckedAt,activePaymentAttemptId,dotyposReservationId,fulfillmentState,orderId,paymentAttemptId,paymentAttemptState,paymentState,providerOrderId,reservationId,reservationState,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.resolveUnattachedProviderSession",
        "Info Provider payment finalization completed (result=not_pending) {abandonmentCheckedAt,orderId,paymentAttemptId,verificationDeadlineMillis,webhookEventId} in providerPaymentFinalization.finalizePendingProviderPayment",
      ]
    `);
  });
});
