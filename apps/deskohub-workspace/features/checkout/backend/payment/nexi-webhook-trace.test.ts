import { PaymentProvidersFromNexi } from "./payment-providers";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import { NetworkError, NexiService } from "@deskohub/nexi";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Exit, Layer, Predicate, type Schema } from "effect";
import type { PaymentAttemptState } from "@/db/schema";
import {
  QueueMessageSendError,
  QueuePublisher,
} from "@/shared/backend/queue/queue-publisher";
import {
  type EffectTrace,
  recordEffectTrace,
  startEffectTrace,
} from "@/shared/testing/effect-trace.test-utils";
import {
  type NexiVerification,
  nexiVerificationFixture,
} from "./nexi-verification.test-utils";
import {
  nexiWebhookAttemptFixture,
  nexiWebhookEventFixture,
  nexiWebhookRecoveryFixture,
  nexiWebhookReservationFixture,
} from "./nexi-webhook.test-utils";
import { withReservationPaymentHandlers } from "./order-payment-handlers.test-utils";

mock.module("server-only", () => ({}));

const { NexiWebhookService } = await import("./nexi-webhook.service");
const { WorkspaceReservationRepository } = await import(
  "@/features/reservation/backend/workspace-reservation.repository"
);
const { CheckoutAnalytics } = await import(
  "../analytics/checkout-analytics.service"
);
const { silentCheckoutAnalytics } = await import(
  "../analytics/checkout-analytics.service.mock"
);
const { ReservationFulfillment, WorkspacePaidFulfillmentError } = await import(
  "../fulfillment/reservation-fulfillment.service"
);
const { LatePaymentRecoveryRepository } = await import(
  "../repositories/late-payment-recovery.repository"
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
const { WebhookEventRepository } = await import(
  "../repositories/webhook-event.repository"
);
const { LatePaymentRecoveryQueueService } = await import(
  "./late-payment-recovery-queue.service"
);
const { PaymentRefundReconciliationError, PaymentRefundService } = await import(
  "./payment-refund.service"
);

interface Collaborators {
  readonly webhookEvents?: Partial<typeof WebhookEventRepository.Service>;
  readonly paymentAttempts?: Partial<typeof PaymentAttemptRepository.Service>;
  readonly paymentLifecycle?: Partial<
    typeof PaymentLifecycleRepository.Service
  >;
  readonly reservations?: Partial<
    typeof WorkspaceReservationRepository.Service
  >;
  readonly nexi?: Partial<typeof NexiService.Service>;
  readonly fulfillment?: Partial<typeof ReservationFulfillment.Service>;
  readonly latePaymentRecoveries?: Partial<
    typeof LatePaymentRecoveryRepository.Service
  >;
  readonly latePaymentRecoveryQueue?: Partial<
    typeof LatePaymentRecoveryQueueService.Service
  >;
  readonly paymentRefunds?: Partial<typeof PaymentRefundService.Service>;
}

const payload = {
  eventId: "event-id",
  securityToken: "security-token",
  operation: {
    orderId: "provider-order-id",
    operationId: "operation-id",
    operationType: "CAPTURE",
    operationResult: "EXECUTED",
    operationAmount: "35000",
    operationCurrency: "CZK",
  },
};

const refundPayload = {
  ...payload,
  operation: { ...payload.operation, operationType: "REFUND" },
};

const pendingAttempt = nexiWebhookAttemptFixture();
const expiredAttempt = { ...pendingAttempt, state: "expired" as const };
const reservation = nexiWebhookReservationFixture();

const transition = (changed: boolean, state: PaymentAttemptState) => ({
  attempt: { ...pendingAttempt, state },
  changed,
  timestamp: pendingAttempt.createdAt,
});

const succeed =
  <const A>(value: A) =>
  () =>
    Effect.succeed(value);
const fail =
  <E>(error: E) =>
  () =>
    Effect.fail(error);

const databaseFailure = new EffectDrizzleQueryError({
  query: "webhook test query",
  params: [],
  cause: Cause.die(new Error("db down")),
});

const failToEnqueueRecovery: typeof LatePaymentRecoveryQueueService.Service.enqueue =
  (input) =>
    Effect.flatMap(LatePaymentRecoveryQueueService, (queue) =>
      queue.enqueue(input)
    ).pipe(
      Effect.provide(
        LatePaymentRecoveryQueueService.Default.pipe(
          Layer.provide(
            Layer.mock(QueuePublisher, {
              publish: fail(
                new QueueMessageSendError({
                  topic: "workspace-late-payment-recovery",
                  cause: new Error("queue down"),
                })
              ),
            })
          )
        )
      )
    );

const paymentLifecycleStateError = new PaymentLifecycleStateError({
  operation: "markTerminal",
  paymentReference: { type: "paymentAttemptId", id: pendingAttempt.id },
  message: "The payment attempt is no longer pending.",
});

/** Collaborators of a webhook that verifies, marks paid and fulfills. */
const paidCollaborators = (overrides: Collaborators = {}): Collaborators => ({
  ...overrides,
  webhookEvents: {
    insertReceived: succeed({
      status: "inserted",
      event: nexiWebhookEventFixture("received"),
    }),
    claimRetry: succeed("claimed"),
    linkPaymentAttempt: succeed(undefined),
    markProcessed: succeed(undefined),
    markFailed: succeed(undefined),
    ...overrides.webhookEvents,
  },
  paymentAttempts: {
    findByProviderOrderId: succeed(pendingAttempt),
    ...overrides.paymentAttempts,
  },
  reservations: {
    findById: succeed(reservation),
    ...overrides.reservations,
  },
  nexi: {
    verifyPaymentOutcome: succeed(nexiVerificationFixture("success")),
    ...overrides.nexi,
  },
  paymentLifecycle: {
    markPaid: succeed(transition(true, "paid")),
    markTerminal: succeed(transition(true, "failed")),
    ...overrides.paymentLifecycle,
  },
  fulfillment: {
    run: succeed(undefined),
    ...overrides.fulfillment,
  },
  latePaymentRecoveries: {
    start: succeed(nexiWebhookRecoveryFixture()),
    ...overrides.latePaymentRecoveries,
  },
  latePaymentRecoveryQueue: {
    enqueue: succeed(undefined),
    ...overrides.latePaymentRecoveryQueue,
  },
  paymentRefunds: {
    reconcileAttempt: succeed("recorded"),
    ...overrides.paymentRefunds,
  },
});

/** Collaborators of a webhook whose Nexi verification reports `status`. */
const verifiedCollaborators = (
  result: NexiVerification,
  overrides: Collaborators = {}
) =>
  paidCollaborators({
    ...overrides,
    nexi: { verifyPaymentOutcome: succeed(result) },
  });

/** The success value, or the failure's error code and message. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.squash(exit.cause);
  return Predicate.hasProperty(failure, "errorCode") &&
    Predicate.hasProperty(failure, "message")
    ? { errorCode: failure.errorCode, message: failure.message }
    : failure;
};

/** The whole result or processing error, as one trace line. */
const describeExit = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return `succeed ${JSON.stringify(exit.value)}`;
  }
  const failure = Cause.squash(exit.cause);
  const cause = Predicate.hasProperty(failure, "cause")
    ? failure.cause
    : undefined;
  return `fail ${JSON.stringify({
    ...(Predicate.isObject(failure) ? failure : { failure }),
    message: Predicate.hasProperty(failure, "message")
      ? failure.message
      : undefined,
    cause: Predicate.isObject(cause) ? cause.constructor.name : cause,
  })}`;
};

const processNotification = async (
  collaborators: Collaborators,
  notification: Schema.Json = payload
) => {
  const trace: EffectTrace = startEffectTrace();
  const record = <Methods extends object>(
    service: string,
    methods: Methods | undefined
  ) => trace.recordCalls(service, methods ?? {});
  const exit = await Effect.gen(function* () {
    const service = yield* NexiWebhookService;
    return yield* recordEffectTrace(
      trace,
      service.processNotification(notification)
    );
  }).pipe(
    Effect.provide(
      NexiWebhookService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(
              WebhookEventRepository,
              record("webhookEvents", collaborators.webhookEvents)
            ),
            Layer.mock(
              PaymentAttemptRepository,
              record("paymentAttempts", collaborators.paymentAttempts)
            ),
            Layer.mock(
              PaymentLifecycleRepository,
              record("paymentLifecycle", collaborators.paymentLifecycle)
            ),
            Layer.mock(
              WorkspaceReservationRepository,
              record("reservations", collaborators.reservations)
            ),
            PaymentProvidersFromNexi.pipe(
              Layer.provide(
                Layer.mock(NexiService, record("nexi", collaborators.nexi))
              )
            ),
            Layer.mock(
              ReservationFulfillment,
              record("fulfillment", collaborators.fulfillment)
            ),
            Layer.mock(
              LatePaymentRecoveryRepository,
              record(
                "latePaymentRecoveries",
                collaborators.latePaymentRecoveries
              )
            ),
            Layer.mock(
              LatePaymentRecoveryQueueService,
              record(
                "latePaymentRecoveryQueue",
                collaborators.latePaymentRecoveryQueue
              )
            ),
            Layer.mock(
              PaymentRefundService,
              record("paymentRefunds", collaborators.paymentRefunds)
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
  return {
    outcome: outcomeOf(exit),
    trace: [...trace.entries, describeExit(exit)],
  };
};

describe("NexiWebhookService.processNotification trace", () => {
  test("fails on an invalid payload", async () => {
    const { outcome, trace } = await processNotification(paidCollaborators(), {
      operation: {},
    });

    expect(outcome).toMatchObject({ errorCode: "nexi_webhook_parse_failed" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "fail {"errorCode":"nexi_webhook_parse_failed","_tag":"NexiWebhookProcessingError","message":"Nexi webhook notification payload was invalid.","cause":"SchemaError"}",
      ]
    `);
  });

  test("fails when the event can't be recorded", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        webhookEvents: { insertReceived: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_transition_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_transition_failed","_tag":"NexiWebhookProcessingError","message":"Nexi webhook event could not be recorded.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("ignores a processed duplicate", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        webhookEvents: {
          insertReceived: succeed({
            status: "duplicate",
            event: nexiWebhookEventFixture("processed"),
          }),
        },
      })
    );

    expect(outcome).toMatchObject({ status: "duplicate" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Processed duplicate Nexi webhook ignored (eventId=event-id, providerOrderId=provider-order-id) {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "succeed {"status":"duplicate","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("ignores a duplicate a concurrent delivery already processed", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        webhookEvents: {
          insertReceived: succeed({
            status: "duplicate",
            event: nexiWebhookEventFixture("failed"),
          }),
          claimRetry: succeed("processed"),
        },
      })
    );

    expect(outcome).toMatchObject({ status: "duplicate" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.claimRetry(type=eventId, provider=nexi, eventId=event-id)",
        "Info Concurrent duplicate Nexi webhook already processed (eventId=event-id, providerOrderId=provider-order-id) {eventId,operationId,operationResult,operationType,provider,providerOrderId,retryClaim,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "succeed {"status":"duplicate","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("retries a claimed unprocessed duplicate", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        webhookEvents: {
          insertReceived: succeed({
            status: "duplicate",
            event: nexiWebhookEventFixture("failed"),
          }),
          claimRetry: succeed("claimed"),
        },
      })
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.claimRetry(type=eventId, provider=nexi, eventId=event-id)",
        "Warn Retrying unprocessed duplicate Nexi webhook (eventId=event-id, providerOrderId=provider-order-id, previousState=failed) {eventId,operationId,operationResult,operationType,provider,providerOrderId,retryClaim,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,retryClaim,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,retryClaim,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,retryClaim,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,retryClaim,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,retryClaim,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,retryClaim,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,retryClaim,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,retryClaim,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,retryClaim,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,retryClaim,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,retryClaim,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked paid {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,retryClaim,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call fulfillment.run(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Info Nexi webhook paid order fulfilled {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,retryClaim,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,retryClaim,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,retryClaim,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("fails when a duplicate's retry can't be claimed", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        webhookEvents: {
          insertReceived: succeed({
            status: "duplicate",
            event: nexiWebhookEventFixture("received"),
          }),
          claimRetry: fail(databaseFailure),
        },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_transition_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.claimRetry(type=eventId, provider=nexi, eventId=event-id)",
        "fail {"errorCode":"nexi_webhook_transition_failed","_tag":"NexiWebhookProcessingError","message":"Nexi webhook processing failed.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("fails when the payment attempt can't be loaded", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: { findByProviderOrderId: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({ errorCode: "nexi_webhook_unknown_order" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_unknown_order","_tag":"NexiWebhookProcessingError","message":"Payment attempt could not be loaded for Nexi webhook.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("marks the event failed for an unknown payment attempt", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: { findByProviderOrderId: succeed(null) },
      })
    );

    expect(outcome).toMatchObject({ errorCode: "nexi_webhook_unknown_order" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi webhook referenced unknown payment attempt {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_unknown_order)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_unknown_order","_tag":"NexiWebhookProcessingError","message":"Nexi webhook referenced an unknown payment attempt."}",
      ]
    `);
  });

  test("rejects an order kind without a settlement handler before looking up a reservation", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: {
          findByProviderOrderId: succeed({
            ...pendingAttempt,
            workspaceReservationId: null,
            orderKind: "pass-purchase",
          }),
        },
      })
    );

    expect(outcome).toMatchObject({ errorCode: "nexi_webhook_unknown_order" });
    expect(trace).toContain(
      "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_unknown_order)"
    );
    expect(trace.some((row) => row.startsWith("call reservations."))).toBe(
      false
    );
  });

  test("still fails when the failed-state marker fails", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: { findByProviderOrderId: succeed(null) },
        webhookEvents: { markFailed: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({ errorCode: "nexi_webhook_unknown_order" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi webhook referenced unknown payment attempt {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_unknown_order)",
        "Error Nexi webhook failed-state marker failed (identity=<Object>, errorCode=nexi_webhook_unknown_order, cause=<EffectDrizzleQueryError>) {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_unknown_order","_tag":"NexiWebhookProcessingError","message":"Nexi webhook referenced an unknown payment attempt."}",
      ]
    `);
  });

  test("continues when the payment attempt link fails", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        webhookEvents: { linkPaymentAttempt: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Warn Nexi webhook payment attempt link failed (eventId=event-id, paymentAttemptId=attempt-id, providerOrderId=provider-order-id, cause=<EffectDrizzleQueryError>) {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked paid {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call fulfillment.run(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Info Nexi webhook paid order fulfilled {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("fails when the reservation can't be loaded", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        reservations: { findById: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({ errorCode: "nexi_webhook_unknown_order" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_unknown_order","_tag":"NexiWebhookProcessingError","message":"Payment order could not be loaded for Nexi webhook.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("marks the event failed for an unknown reservation", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({ reservations: { findById: succeed(null) } })
    );

    expect(outcome).toMatchObject({ errorCode: "nexi_webhook_unknown_order" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi webhook referenced an unknown payment order {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_unknown_order)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_unknown_order","_tag":"NexiWebhookProcessingError","message":"Nexi webhook referenced an unknown payment order."}",
      ]
    `);
  });

  test("marks the event failed on a security token mismatch", async () => {
    const { outcome, trace } = await processNotification(paidCollaborators(), {
      ...payload,
      securityToken: "other-token",
    });

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_verification_mismatch",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi webhook security token mismatch detected {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_verification_mismatch)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_verification_mismatch","_tag":"NexiWebhookProcessingError","message":"Nexi webhook security token did not match."}",
      ]
    `);
  });

  test("verifies a notification without a security token", async () => {
    const { securityToken: _omitted, ...withoutToken } = payload;
    const { outcome, trace } = await processNotification(
      paidCollaborators(),
      withoutToken
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked paid {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call fulfillment.run(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Info Nexi webhook paid order fulfilled {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("marks the event failed for an attempt without a stored token", async () => {
    const { securityToken: _omitted, ...withoutToken } = payload;
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: {
          findByProviderOrderId: succeed({
            ...pendingAttempt,
            securityToken: null,
          }),
        },
      }),
      withoutToken
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_missing_security_token",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi webhook payment attempt is missing security token {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_missing_security_token)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_missing_security_token","_tag":"NexiWebhookProcessingError","message":"Payment attempt has no stored Nexi security token."}",
      ]
    `);
  });

  test("marks the event failed for a non-Nexi payment attempt", async () => {
    const { securityToken: _omitted, ...withoutToken } = payload;
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: {
          findByProviderOrderId: succeed({
            ...pendingAttempt,
            providerOrderId: null,
          }),
        },
      }),
      withoutToken
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_missing_security_token",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi webhook payment attempt is missing security token {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_missing_security_token)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_missing_security_token","_tag":"NexiWebhookProcessingError","message":"Payment attempt has no stored Nexi security token."}",
      ]
    `);
  });

  test("reconciles a refund notification without a payment transition", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators(),
      refundPayload
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook refund reconciliation started {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentRefunds.reconcileAttempt(attempt=<Object>, correlationId=correlation-id)",
        "Info Nexi webhook refund reconciliation completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,refundResult,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,refundResult,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,refundResult,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("marks the event failed when refund reconciliation fails", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentRefunds: {
          reconcileAttempt: fail(
            new PaymentRefundReconciliationError({
              message: "Nexi refund reconciliation failed.",
              cause: new Error("nexi down"),
            })
          ),
        },
      }),
      refundPayload
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_refund_reconciliation_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook refund reconciliation started {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentRefunds.reconcileAttempt(attempt=<Object>, correlationId=correlation-id)",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_refund_reconciliation_failed)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_refund_reconciliation_failed","_tag":"NexiWebhookProcessingError","message":"Nexi refund could not be reconciled.","cause":"PaymentRefundReconciliationError"}",
      ]
    `);
  });

  test("marks the event failed for an invalid attempt currency", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: {
          findByProviderOrderId: succeed({
            ...pendingAttempt,
            amount: { ...pendingAttempt.amount, currency: "XXX" },
          }),
        },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_invalid_currency",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_invalid_currency)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_invalid_currency","_tag":"NexiWebhookProcessingError","message":"Payment attempt has an invalid Nexi currency.","cause":"PaymentProviderError"}",
      ]
    `);
  });

  test("marks the event failed when provider verification fails", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        nexi: {
          verifyPaymentOutcome: fail(
            new NetworkError({ message: "nexi down" })
          ),
        },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_verification_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_verification_failed)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_verification_failed","_tag":"NexiWebhookProcessingError","message":"Nexi provider verification failed.","cause":"PaymentProviderError"}",
      ]
    `);
  });

  test("marks the event failed on a verification mismatch", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(nexiVerificationFixture("success", {}, ["amount"]))
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_verification_mismatch",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi webhook verification mismatch detected (verification=<Object>) {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_verification_mismatch)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_verification_mismatch","_tag":"NexiWebhookProcessingError","message":"Nexi payment verification returned local fact mismatches."}",
      ]
    `);
  });

  test("marks paid, captures completion, fulfills and accepts", async () => {
    const { outcome, trace } = await processNotification(paidCollaborators());

    expect(outcome).toEqual({
      status: "accepted",
      eventId: "event-id",
      orderId: "provider-order-id",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked paid {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call fulfillment.run(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Info Nexi webhook paid order fulfilled {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("skips the completion event for an unchanged paid transition", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentLifecycle: { markPaid: succeed(transition(false, "paid")) },
      })
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "Info Nexi webhook payment attempt marked paid {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call fulfillment.run(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Info Nexi webhook paid order fulfilled {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("fails when the paid transition fails", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentLifecycle: { markPaid: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_transition_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "fail {"errorCode":"nexi_webhook_transition_failed","_tag":"NexiWebhookProcessingError","message":"Nexi webhook processing failed.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("marks the event failed when fulfillment fails", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        fulfillment: {
          run: fail(
            new WorkspacePaidFulfillmentError({
              orderId: reservation.id,
              failureCode: "dotypos_reservation_failed",
              message: "dotypos down",
            })
          ),
        },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_fulfillment_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked paid {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call fulfillment.run(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_fulfillment_failed)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_fulfillment_failed","_tag":"NexiWebhookProcessingError","message":"Paid order fulfillment failed.","cause":"WorkspacePaidFulfillmentError"}",
      ]
    `);
  });

  test("fails when the processed marker fails", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        webhookEvents: { markProcessed: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_transition_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook paid transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markPaid(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, paidAt=<Instant>)",
        "call checkoutAnalytics.paymentCompleted(attempt=<Object>, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked paid {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call fulfillment.run(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Info Nexi webhook paid order fulfilled {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_transition_failed","_tag":"NexiWebhookProcessingError","message":"Nexi webhook event could not be marked processed.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("starts and enqueues late-payment recovery for a terminal attempt", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: { findByProviderOrderId: succeed(expiredAttempt) },
      })
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi payment settled after the local payment attempt became terminal (eventId=event-id, paymentAttemptId=attempt-id, paymentAttemptState=expired, providerOrderId=provider-order-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5) {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call latePaymentRecoveries.start(paymentAttemptId=attempt-id, workspaceReservationId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, verifiedPaidAt=<Instant>)",
        "call latePaymentRecoveryQueue.enqueue(paymentAttemptId=attempt-id)",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("marks the event failed when late-payment recovery can't start", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: { findByProviderOrderId: succeed(expiredAttempt) },
        latePaymentRecoveries: { start: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_late_payment_recovery_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi payment settled after the local payment attempt became terminal (eventId=event-id, paymentAttemptId=attempt-id, paymentAttemptState=expired, providerOrderId=provider-order-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5) {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call latePaymentRecoveries.start(paymentAttemptId=attempt-id, workspaceReservationId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, verifiedPaidAt=<Instant>)",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_late_payment_recovery_failed)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_late_payment_recovery_failed","_tag":"NexiWebhookProcessingError","message":"Nexi late-payment recovery could not be started.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("marks the event failed when late-payment recovery can't be enqueued", async () => {
    const { outcome, trace } = await processNotification(
      paidCollaborators({
        paymentAttempts: { findByProviderOrderId: succeed(expiredAttempt) },
        latePaymentRecoveryQueue: { enqueue: failToEnqueueRecovery },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_late_payment_recovery_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Warn Nexi payment settled after the local payment attempt became terminal (eventId=event-id, paymentAttemptId=attempt-id, paymentAttemptState=expired, providerOrderId=provider-order-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5) {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call latePaymentRecoveries.start(paymentAttemptId=attempt-id, workspaceReservationId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXECUTED, verifiedPaidAt=<Instant>)",
        "call latePaymentRecoveryQueue.enqueue(paymentAttemptId=attempt-id)",
        "span latePaymentRecoveryQueue.enqueue",
        "call webhookEvents.markFailed(type=eventId, provider=nexi, eventId=event-id, errorCode=nexi_webhook_late_payment_recovery_failed)",
        "fail {"eventId":"event-id","orderId":"provider-order-id","errorCode":"nexi_webhook_late_payment_recovery_failed","_tag":"NexiWebhookProcessingError","message":"Nexi late-payment recovery could not be started.","cause":"LatePaymentRecoveryQueueError"}",
      ]
    `);
  });

  test("marks a declined payment failed and captures the failure", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(nexiVerificationFixture("failure"))
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook terminal transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=failed, failureCode=nexi_payment_failed, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=DECLINED)",
        "call checkoutAnalytics.paymentFailed(attempt=<Object>, failureReason=nexi_payment_failed, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked terminal {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("marks a cancelled payment cancelled and captures abandonment", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(
        nexiVerificationFixture("failure", { orderStatus: "CANCELED" }),
        {
          paymentLifecycle: {
            markTerminal: succeed(transition(true, "cancelled")),
          },
        }
      )
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook terminal transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=cancelled, failureCode=nexi_payment_failed, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=CANCELED)",
        "call checkoutAnalytics.paymentAbandoned(attempt=<Object>, timestamp=<Instant>)",
        "Info Nexi webhook payment attempt marked terminal {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("skips the lifecycle event for an unchanged terminal transition", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(
        nexiVerificationFixture("failure", { orderStatus: "EXPIRED" }),
        {
          paymentLifecycle: {
            markTerminal: succeed(transition(false, "expired")),
          },
        }
      )
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook terminal transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=expired, failureCode=nexi_payment_failed, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=EXPIRED)",
        "Info Nexi webhook payment attempt marked terminal {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("accepts a terminal transition that no longer applies", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(nexiVerificationFixture("failure"), {
        paymentLifecycle: { markTerminal: fail(paymentLifecycleStateError) },
      })
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook terminal transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=failed, failureCode=nexi_payment_failed, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=DECLINED)",
        "Warn Nexi webhook terminal transition no longer applies (cause=<PaymentLifecycleStateError>) {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt marked terminal {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("fails when the terminal transition fails otherwise", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(nexiVerificationFixture("failure"), {
        paymentLifecycle: { markTerminal: fail(databaseFailure) },
      })
    );

    expect(outcome).toMatchObject({
      errorCode: "nexi_webhook_transition_failed",
    });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook terminal transition started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,failureKind,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,terminalState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentLifecycle.markTerminal(id=attempt-id, orderId=0198c1a2-61c4-7e64-83f3-b3b69dc0dac5, state=failed, failureCode=nexi_payment_failed, webhookEventId=event-id, providerOperationId=operation-id, providerStatus=DECLINED)",
        "fail {"errorCode":"nexi_webhook_transition_failed","_tag":"NexiWebhookProcessingError","message":"Nexi webhook processing failed.","cause":"EffectDrizzleQueryError"}",
      ]
    `);
  });

  test("accepts a pending verification without a payment transition", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(nexiVerificationFixture("pending"))
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook verification did not require payment transition {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });

  test("accepts a pending verification of a terminal attempt without recovery", async () => {
    const { outcome, trace } = await processNotification(
      verifiedCollaborators(nexiVerificationFixture("pending"), {
        paymentAttempts: { findByProviderOrderId: succeed(expiredAttempt) },
      })
    );

    expect(outcome).toMatchObject({ status: "accepted" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span nexiWebhook.processNotification",
        "Info Nexi webhook processing started {provider} in nexiWebhook.processNotification",
        "Info Nexi webhook notification decoded {eventId,operationId,operationResult,operationType,provider,providerOrderId} in nexiWebhook.processNotification",
        "call webhookEvents.insertReceived(provider=nexi, eventId=event-id, providerOrderId=provider-order-id, receivedAt=<Instant>)",
        "Info Nexi webhook event recorded {eventId,operationId,operationResult,operationType,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call paymentAttempts.findByProviderOrderId(nexi; provider-order-id)",
        "Debug Nexi webhook payment attempt lookup completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment attempt resolved {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.linkPaymentAttempt(type=eventId, provider=nexi, eventId=event-id, paymentAttemptId=attempt-id)",
        "Debug Nexi webhook payment attempt link completed {eventId,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,provider,providerOrderId,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call reservations.findById(0198c1a2-61c4-7e64-83f3-b3b69dc0dac5)",
        "Debug Nexi webhook payment order lookup completed {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment order resolved {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook security token checked {activePaymentAttemptId,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook currency decoded {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook payment verification started {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,reservationId,reservationState,tokenCheckStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=35000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Info Nexi webhook payment verification completed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOrderId,providerOrderStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Debug Nexi webhook provider metadata resolved {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook verification did not require payment transition {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "call webhookEvents.markProcessed(type=eventId, provider=nexi, eventId=event-id, processedAt=<Instant>)",
        "Info Nexi webhook event marked processed {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState} in nexiWebhook.processNotification",
        "Info Nexi webhook processing accepted {activePaymentAttemptId,amount,correlationId,currency,dotyposReservationId,eventId,fulfillmentState,operationId,operationResult,operationType,orderId,paymentAttemptId,paymentAttemptState,paymentState,provider,providerOperationId,providerOrderId,providerOrderStatus,providerStatus,reservationId,reservationState,tokenCheckStatus,verificationMismatches,verificationStatus,webhookEventId,webhookEventInsertStatus,webhookEventState,webhookResultStatus} in nexiWebhook.processNotification",
        "succeed {"status":"accepted","eventId":"event-id","orderId":"provider-order-id"}",
      ]
    `);
  });
});
