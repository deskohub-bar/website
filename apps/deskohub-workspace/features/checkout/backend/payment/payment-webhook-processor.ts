import { Effect, type Schema } from "effect";
import type { PaymentAttemptState, WebhookEvent } from "@/db/schema";
import { currentPreciseInstant } from "@/shared/utils/temporal";
import {
  CheckoutAnalytics,
  type ICheckoutAnalytics,
} from "../analytics/checkout-analytics.service";
import {
  type PaymentAttempt,
  PaymentAttemptRepository,
  type PaymentAttemptWithOrderKind,
  paymentAttemptLogFields,
} from "../repositories/payment-attempt.repository";
import {
  type IWebhookEventRepository,
  type WebhookEventIdentity,
  WebhookEventRepository,
} from "../repositories/webhook-event.repository";
import type {
  OrderPaymentHandler,
  PaymentOrder,
} from "./order-payment-handler";
import { OrderPaymentHandlers } from "./order-payment-handlers.service";
import {
  type PaymentProvider,
  PaymentProviders,
  type PaymentVerification,
  type ProviderPaymentFailureCode,
} from "./payment-provider";
import { PaymentRefundService } from "./payment-refund.service";
import { paymentVerificationLogFields } from "./payment-verification-log-fields";
import {
  isVerifiableProviderPaymentAttempt,
  type VerifiableProviderPaymentAttempt,
} from "./verifiable-provider-payment-attempt";

export type WebhookFailure =
  | "inactive_provider"
  | "parse_failed"
  | "unknown_order"
  | "missing_security_token"
  | "invalid_currency"
  | "verification_failed"
  | "verification_mismatch"
  | "late_payment"
  | "late_payment_recovery_failed"
  | "refund_reconciliation_failed"
  | "transition_failed"
  | "fulfillment_failed";

export interface PaymentWebhookResult {
  readonly status: "accepted" | "duplicate";
  readonly orderId?: string;
  readonly eventId?: string;
}

/**
 * A webhook result for log annotations: its status and the ids it names.
 * Ids the result leaves out stay off the row.
 */
export const paymentWebhookResultLogFields = (
  result: PaymentWebhookResult
) => ({
  webhookResultStatus: result.status,
  ...(result.orderId && { orderId: result.orderId }),
  ...(result.eventId && { eventId: result.eventId }),
});

export interface WebhookNotification {
  readonly eventId: string;
  readonly providerOrderId: string;
  readonly token?: string | undefined;
  readonly refund: boolean;
  readonly diagnostics?: Readonly<Record<string, string | undefined>>;
}

type WebhookErrorInput = {
  readonly errorCode: WebhookFailure;
  readonly eventId?: string;
  readonly orderId?: string;
  readonly message: string;
  readonly cause?: unknown;
};

export type WebhookErrorCode<P extends PaymentProvider> =
  `${P}_webhook_${WebhookFailure}`;

export interface PaymentWebhookProtocol<
  E extends Error & { readonly errorCode: string },
> {
  readonly provider: PaymentProvider;
  readonly label: string;
  readonly operation: string;
  readonly decode: (
    payload: Schema.Json
  ) => Effect.Effect<WebhookNotification, E>;
  readonly checkToken: (
    notification: string | undefined,
    stored: string | null
  ) => "absent" | "match" | "mismatch";
  readonly error: (input: WebhookErrorInput) => E;
  readonly isError: (cause: Error) => cause is E;
}

/** The provider event and order every processing failure names. */
interface NotificationIdentity {
  readonly eventId: string;
  readonly providerOrderId: string;
}

/** A notification resolved to its authenticated attempt and owning order. */
interface PaymentNotification extends NotificationIdentity {
  readonly attempt: VerifiableProviderPaymentAttempt;
  readonly isSharedWindowCard: boolean;
  readonly order: PaymentOrder;
  readonly handler: OrderPaymentHandler;
}

/** A notification with a verified provider outcome. */
interface VerifiedPaymentNotification extends PaymentNotification {
  readonly verification: PaymentVerification;
}

interface ProcessingFailure {
  readonly errorCode: WebhookFailure;
  readonly message: string;
}

export const makePaymentWebhookProcessor = <
  E extends Error & { readonly errorCode: string },
>(
  protocol: PaymentWebhookProtocol<E>
) =>
  Effect.gen(function* () {
    const { provider, label } = protocol;
    const markEventFailed = (
      webhookEvents: IWebhookEventRepository,
      identity: WebhookEventIdentity,
      errorCode: string
    ) =>
      webhookEvents.markFailed({ ...identity, errorCode }).pipe(
        Effect.tapError((cause) =>
          Effect.logError(`${label} webhook failed-state marker failed`, {
            identity,
            errorCode,
            cause,
          })
        ),
        Effect.ignore
      );

    const failAfterMarkingEvent = (
      webhookEvents: IWebhookEventRepository,
      identity: WebhookEventIdentity,
      error: E
    ) =>
      markEventFailed(webhookEvents, identity, error.errorCode).pipe(
        Effect.andThen(Effect.fail(error))
      );

    const failOnVerificationMismatch = Effect.fn(
      function* (input: {
        readonly eventId: string;
        readonly orderId: string;
        readonly verification: PaymentVerification;
        readonly webhookEvents: IWebhookEventRepository;
      }) {
        if (input.verification.mismatches.length === 0) return;
        yield* Effect.logWarning(
          `${label} webhook verification mismatch detected`,
          {
            verification: input.verification,
          }
        );

        return yield* failAfterMarkingEvent(
          input.webhookEvents,
          { type: "eventId", provider, eventId: input.eventId },
          protocol.error({
            errorCode: "verification_mismatch",
            eventId: input.eventId,
            orderId: input.orderId,
            message: `${label} payment verification returned local fact mismatches.`,
          })
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.annotateLogs({
            eventId: input.eventId,
            providerOrderId: input.orderId,
            ...paymentVerificationLogFields(input.verification),
          })
        )
    );

    /** Maps a step's failure to the notification's processing error. */
    const processingFailure =
      (notification: NotificationIdentity, failure: ProcessingFailure) =>
      <E>(cause: E) =>
        protocol.error({
          errorCode: failure.errorCode,
          eventId: notification.eventId,
          orderId: notification.providerOrderId,
          message: failure.message,
          cause,
        });

    /** Fails a step with `failure`, marking the event failed first. */
    const failMarkingEvent =
      (
        webhookEvents: IWebhookEventRepository,
        notification: NotificationIdentity,
        failure: ProcessingFailure
      ) =>
      <A, E, R>(step: Effect.Effect<A, E, R>) =>
        step.pipe(
          Effect.mapError(processingFailure(notification, failure)),
          Effect.catch((error) =>
            failAfterMarkingEvent(
              webhookEvents,
              { type: "eventId", provider, eventId: notification.eventId },
              error
            )
          )
        );

    /** Rejects the notification with `failure` after marking the event failed. */
    const rejectMarkingEvent = (
      webhookEvents: IWebhookEventRepository,
      notification: NotificationIdentity,
      failure: ProcessingFailure
    ) =>
      failAfterMarkingEvent(
        webhookEvents,
        { type: "eventId", provider, eventId: notification.eventId },
        protocol.error({
          errorCode: failure.errorCode,
          eventId: notification.eventId,
          orderId: notification.providerOrderId,
          message: failure.message,
        })
      );

    const duplicateResult = (notification: NotificationIdentity) => ({
      status: "duplicate" as const,
      eventId: notification.eventId,
      orderId: notification.providerOrderId,
    });

    /** The analytics event for a payment that ended unpaid. */
    const capturePaymentEnded = (
      checkoutAnalytics: ICheckoutAnalytics,
      input: {
        readonly transition: Parameters<
          ICheckoutAnalytics["paymentAbandoned"]
        >[0];
        readonly terminalState: "failed" | "cancelled" | "expired";
        readonly failureCode: ProviderPaymentFailureCode;
      }
    ) =>
      input.terminalState === "failed"
        ? checkoutAnalytics.paymentFailed({
            attempt: input.transition.attempt,
            failureReason: input.failureCode,
            timestamp: input.transition.timestamp,
          })
        : checkoutAnalytics.paymentAbandoned({
            attempt: input.transition.attempt,
            timestamp: input.transition.timestamp,
          });

    const webhookEvents = yield* WebhookEventRepository;
    const handlers = yield* OrderPaymentHandlers;
    const paymentAttempts = yield* PaymentAttemptRepository;
    const providers = yield* PaymentProviders;
    const adapter = providers.forAttempt(provider);

    const checkoutAnalytics = yield* CheckoutAnalytics;
    const paymentRefunds = yield* PaymentRefundService;

    const acceptEvent = Effect.fn(function* (input: {
      readonly eventId: string;
      readonly providerOrderId: string;
    }) {
      yield* webhookEvents
        .markProcessed({
          type: "eventId",
          provider,
          eventId: input.eventId,
          processedAt: Temporal.Now.instant(),
        })
        .pipe(
          Effect.mapError((cause) =>
            protocol.error({
              errorCode: "transition_failed",
              eventId: input.eventId,
              orderId: input.providerOrderId,
              message: `${label} webhook event could not be marked processed.`,
              cause,
            })
          )
        );
      yield* Effect.logInfo(`${label} webhook event marked processed`);

      const result: PaymentWebhookResult = {
        status: "accepted",
        eventId: input.eventId,
        orderId: input.providerOrderId,
      };
      yield* Effect.annotateLogsScoped(paymentWebhookResultLogFields(result));
      yield* Effect.logInfo(`${label} webhook processing accepted`);

      return result;
    });

    const decodeNotification = Effect.fnUntraced(function* (
      payload: Schema.Json
    ) {
      const envelope = yield* protocol.decode(payload);
      const { eventId, providerOrderId, diagnostics } = envelope;
      yield* Effect.annotateLogsScoped({
        eventId,
        providerOrderId,
        ...diagnostics,
      });
      yield* Effect.logInfo(`${label} webhook notification decoded`);
      const notification: NotificationIdentity = { eventId, providerOrderId };
      return { envelope, notification };
    });

    const recordEvent = Effect.fnUntraced(function* (
      notification: NotificationIdentity
    ) {
      const received = yield* webhookEvents
        .insertReceived({
          provider,
          eventId: notification.eventId,
          providerOrderId: notification.providerOrderId,
          receivedAt: Temporal.Now.instant(),
        })
        .pipe(
          Effect.mapError(
            processingFailure(notification, {
              errorCode: "transition_failed",
              message: `${label} webhook event could not be recorded.`,
            })
          )
        );
      yield* Effect.annotateLogsScoped({
        webhookEventId: received.event.id,
        webhookEventInsertStatus: received.status,
        webhookEventState: received.event.state,
      });
      yield* Effect.logInfo(`${label} webhook event recorded`);
      return received;
    });

    /**
     * The duplicate result when the event was already processed, here or
     * by a concurrent delivery; otherwise claims the event for a retry.
     */
    const claimDuplicateRetry = Effect.fnUntraced(function* (
      event: Pick<WebhookEvent, "state" | "providerOrderId">,
      notification: NotificationIdentity
    ) {
      const { eventId, providerOrderId } = notification;
      if (provider !== "nexi" && event.providerOrderId !== providerOrderId) {
        return yield* Effect.fail(
          protocol.error({
            errorCode: "verification_mismatch",
            eventId,
            orderId: providerOrderId,
            message: `${label} webhook event belongs to another payment.`,
          })
        );
      }
      if (event.state === "processed") {
        yield* Effect.logInfo(`Processed duplicate ${label} webhook ignored`, {
          eventId,
          providerOrderId,
        });
        return duplicateResult(notification);
      }

      const retryClaim = yield* webhookEvents.claimRetry({
        type: "eventId",
        provider,
        eventId,
      });
      yield* Effect.annotateLogsScoped({ retryClaim });
      if (retryClaim === "processed") {
        yield* Effect.logInfo(
          `Concurrent duplicate ${label} webhook already processed`,
          {
            eventId,
            providerOrderId,
          }
        );
        return duplicateResult(notification);
      }

      yield* Effect.logWarning(
        `Retrying unprocessed duplicate ${label} webhook`,
        {
          eventId,
          providerOrderId,
          previousState: event.state,
        }
      );
      return undefined;
    });

    /** The notification's payment attempt, linked to the event. */
    const resolvePaymentAttempt = Effect.fnUntraced(function* (
      notification: NotificationIdentity
    ) {
      const { eventId, providerOrderId } = notification;
      const attempt = yield* paymentAttempts
        .findByProviderOrderId(provider, providerOrderId)
        .pipe(
          Effect.mapError(
            processingFailure(notification, {
              errorCode: "unknown_order",
              message: `Payment attempt could not be loaded for ${label} webhook.`,
            })
          )
        );
      yield* Effect.annotateLogsScoped({
        ...paymentAttemptLogFields(attempt),
        providerOrderId,
      });
      yield* Effect.logDebug(
        `${label} webhook payment attempt lookup completed`
      );

      if (!attempt) {
        yield* Effect.logWarning(
          `${label} webhook referenced unknown payment attempt`
        );

        return yield* rejectMarkingEvent(webhookEvents, notification, {
          errorCode: "unknown_order",
          message: `${label} webhook referenced an unknown payment attempt.`,
        });
      }
      yield* Effect.logInfo(`${label} webhook payment attempt resolved`);

      yield* webhookEvents
        .linkPaymentAttempt({
          type: "eventId",
          provider,
          eventId,
          paymentAttemptId: attempt.id,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(`${label} webhook payment attempt link failed`, {
              eventId,
              paymentAttemptId: attempt.id,
              providerOrderId,
              cause,
            })
          ),
          Effect.ignore
        );
      yield* Effect.logDebug(`${label} webhook payment attempt link completed`);
      return attempt;
    });

    const resolveSettlement = Effect.fnUntraced(function* (
      attempt: PaymentAttemptWithOrderKind,
      notification: NotificationIdentity
    ) {
      const handler = handlers.byKind[attempt.orderKind];
      if (!handler) {
        return yield* rejectMarkingEvent(webhookEvents, notification, {
          errorCode: "unknown_order",
          message: `${label} webhook referenced an unsupported order kind.`,
        });
      }

      const order = yield* handler.load(attempt.orderId).pipe(
        Effect.mapError(
          processingFailure(notification, {
            errorCode: "unknown_order",
            message: `Payment order could not be loaded for ${label} webhook.`,
          })
        )
      );
      if (order) {
        yield* Effect.annotateLogsScoped(order.logFields);
      }
      yield* Effect.logDebug(`${label} webhook payment order lookup completed`);

      if (!order) {
        yield* Effect.logWarning(
          `${label} webhook referenced an unknown payment order`
        );
        return yield* rejectMarkingEvent(webhookEvents, notification, {
          errorCode: "unknown_order",
          message: `${label} webhook referenced an unknown payment order.`,
        });
      }
      yield* Effect.logInfo(`${label} webhook payment order resolved`);
      return { order, handler };
    });

    /**
     * The attempt once the notification's security token, when present,
     * matches it and it stores the token its provider requires.
     */
    const authenticateAttempt = Effect.fnUntraced(function* (
      envelope: WebhookNotification,
      attempt: PaymentAttempt,
      notification: NotificationIdentity
    ) {
      const tokenCheck = {
        status: protocol.checkToken(envelope.token, attempt.securityToken),
      };
      yield* Effect.annotateLogsScoped({
        tokenCheckStatus: tokenCheck.status,
      });
      yield* Effect.logDebug(`${label} webhook security token checked`);
      // The adapter decides whether an absent notification token is valid.
      if (tokenCheck.status === "mismatch") {
        yield* Effect.logWarning(
          `${label} webhook security token mismatch detected`
        );

        return yield* rejectMarkingEvent(webhookEvents, notification, {
          errorCode: "verification_mismatch",
          message: `${label} webhook security token did not match.`,
        });
      }

      if (
        !isVerifiableProviderPaymentAttempt(attempt) ||
        attempt.provider !== provider
      ) {
        yield* Effect.logWarning(
          `${label} webhook payment attempt is missing security token`
        );

        return yield* rejectMarkingEvent(webhookEvents, notification, {
          errorCode: "missing_security_token",
          message: `Payment attempt has no stored ${label} security token.`,
        });
      }
      return attempt;
    });

    // A refund notification reports money going back on an already
    // paid order. It must never re-run the paid transition or
    // fulfillment, so it only records the provider's current refund state.
    const reconcileRefund = Effect.fnUntraced(function* (
      payment: PaymentNotification
    ) {
      yield* Effect.logInfo(`${label} webhook refund reconciliation started`);
      const refundResult = yield* paymentRefunds
        .reconcileAttempt({
          attempt: payment.attempt,
          correlationId: payment.order.correlationId,
        })
        .pipe(
          failMarkingEvent(webhookEvents, payment, {
            errorCode: "refund_reconciliation_failed",
            message: `${label} refund could not be reconciled.`,
          })
        );
      yield* Effect.annotateLogsScoped({ refundResult });
      yield* Effect.logInfo(`${label} webhook refund reconciliation completed`);

      return yield* acceptEvent({
        eventId: payment.eventId,
        providerOrderId: payment.providerOrderId,
      });
    });

    const verifyPayment = Effect.fnUntraced(function* (
      payment: PaymentNotification
    ) {
      const { attempt, eventId, providerOrderId, order } = payment;
      const verificationInput = {
        providerOrderId: attempt.providerOrderId,
        correlationId: order.correlationId,
        amount: attempt.amount,
        securityToken: attempt.securityToken,
      };
      yield* Effect.annotateLogsScoped({
        currency: attempt.amount.currency,
        correlationId: verificationInput.correlationId,
        amount: String(verificationInput.amount.value),
      });
      yield* Effect.logDebug(`${label} webhook currency decoded`);
      yield* Effect.logInfo(`${label} webhook payment verification started`);

      const verification = yield* adapter.verify(verificationInput).pipe(
        Effect.catch((cause) =>
          Effect.fail(cause).pipe(
            failMarkingEvent(
              webhookEvents,
              payment,
              cause.invalidInput
                ? {
                    errorCode: "invalid_currency",
                    message: `Payment attempt has an invalid ${label} currency.`,
                  }
                : {
                    errorCode: "verification_failed",
                    message: `${label} provider verification failed.`,
                  }
            )
          )
        )
      );
      yield* Effect.annotateLogsScoped(
        paymentVerificationLogFields(verification)
      );
      yield* Effect.logInfo(`${label} webhook payment verification completed`);

      yield* failOnVerificationMismatch({
        eventId,
        orderId: providerOrderId,
        verification,
        webhookEvents,
      });

      yield* Effect.annotateLogsScoped({
        providerOperationId: verification.providerOperationId,
        providerStatus: verification.providerStatus,
      });
      yield* Effect.logDebug(`${label} webhook provider metadata resolved`);

      const verified: VerifiedPaymentNotification = {
        ...payment,
        verification,
      };
      return verified;
    });

    const startLatePaymentRecovery = Effect.fnUntraced(function* (
      payment: VerifiedPaymentNotification
    ) {
      const { attempt, eventId, providerOrderId, order, handler } = payment;
      const { providerOperationId, providerStatus } = payment.verification;
      yield* Effect.logWarning(
        `${label} payment settled after the local payment attempt became terminal`,
        {
          eventId,
          paymentAttemptId: attempt.id,
          paymentAttemptState: attempt.state,
          providerOrderId,
          orderId: order.id,
        }
      );
      yield* handler
        .startRecovery({
          orderId: order.id,
          paymentAttemptId: attempt.id,
          webhookEventId: eventId,
          providerOperationId,
          providerStatus,
          verifiedPaidAt: Temporal.Now.instant(),
        })
        .pipe(
          failMarkingEvent(webhookEvents, payment, {
            errorCode: "late_payment_recovery_failed",
            message: `${label} late-payment recovery could not be started.`,
          })
        );
    });

    const markPaidAndFulfill = Effect.fnUntraced(function* (
      payment: VerifiedPaymentNotification
    ) {
      const { attempt, eventId, order, handler } = payment;
      const { providerOperationId, providerStatus } = payment.verification;
      yield* Effect.logInfo(`${label} webhook paid transition started`);

      const transition = yield* handler.markPaid({
        id: attempt.id,
        orderId: order.id,
        webhookEventId: eventId,
        providerOperationId,
        providerStatus,
        paidAt: yield* currentPreciseInstant,
      });
      if (transition.settlement === "refund_required") return;
      if (transition.settlement === "recovery_pending") {
        yield* startLatePaymentRecovery(payment);
        return;
      }
      if (transition.changed) {
        yield* checkoutAnalytics.paymentCompleted({
          attempt: transition.attempt,
          timestamp: transition.timestamp,
        });
      }
      yield* Effect.logInfo(`${label} webhook payment attempt marked paid`);

      yield* handler.fulfill(order.id).pipe(
        failMarkingEvent(webhookEvents, payment, {
          errorCode: "fulfillment_failed",
          message: "Paid order fulfillment failed.",
        })
      );
      yield* Effect.logInfo(`${label} webhook paid order fulfilled`);
    });

    const markPaymentTerminal = Effect.fnUntraced(function* (
      payment: VerifiedPaymentNotification
    ) {
      const { attempt, eventId, order, handler } = payment;
      const { providerOperationId, providerStatus } = payment.verification;
      if (payment.verification.status !== "failure") return;
      const { terminalState, failureCode } = payment.verification;
      yield* Effect.annotateLogsScoped({
        failureKind: terminalState,
        terminalState,
      });
      yield* Effect.logInfo(`${label} webhook terminal transition started`);

      // An unsuccessful result moves no money. When the attempt is no
      // longer the active pending attempt (abandonment expiry, or a
      // newer attempt after status reconciliation), the transition
      // can never apply, so accept the event instead of provoking
      // endless provider retries.
      const transition = yield* handler
        .markTerminal({
          id: attempt.id,
          orderId: order.id,
          state: terminalState,
          failureCode,
          webhookEventId: eventId,
          providerOperationId,
          providerStatus,
        })
        .pipe(
          Effect.catchTag(
            "PaymentLifecycleStateError",
            Effect.fn(function* (cause) {
              yield* Effect.logWarning(
                `${label} webhook terminal transition no longer applies`,
                { cause }
              );
              return undefined;
            })
          )
        );
      if (transition?.changed) {
        yield* capturePaymentEnded(checkoutAnalytics, {
          transition,
          terminalState,
          failureCode,
        });
      }
      yield* Effect.logInfo(`${label} webhook payment attempt marked terminal`);
    });

    const applyVerifiedOutcome = Effect.fnUntraced(function* (
      payment: VerifiedPaymentNotification
    ) {
      if (payment.verification.status === "success") {
        const attemptEnded = isTerminalPaymentAttemptState(
          payment.attempt.state
        );
        if (attemptEnded && !payment.isSharedWindowCard) {
          yield* startLatePaymentRecovery(payment);
        } else {
          yield* markPaidAndFulfill(payment);
        }
      } else if (payment.verification.status === "failure") {
        yield* markPaymentTerminal(payment);
      } else {
        yield* Effect.logInfo(
          `${label} webhook verification did not require payment transition`
        );
      }
    });

    return {
      processNotification: Effect.fn(protocol.operation)(
        function* (payload: Schema.Json) {
          // The raw payload stays out of the logs: the decoded identifiers
          // annotate every row once they are known.
          yield* Effect.logInfo(`${label} webhook processing started`);

          if (!providers.activeProviders.includes(provider)) {
            return yield* Effect.fail(
              protocol.error({
                errorCode: "inactive_provider",
                message: `${label} payments are inactive on this deployment.`,
              })
            );
          }

          const { envelope, notification } = yield* decodeNotification(payload);

          const received = yield* recordEvent(notification);
          if (received.status === "duplicate") {
            const duplicate = yield* claimDuplicateRetry(
              received.event,
              notification
            );
            if (duplicate) return duplicate;
          }

          const attempt = yield* resolvePaymentAttempt(notification);
          const settlement = yield* resolveSettlement(attempt, notification);
          const payment: PaymentNotification = {
            ...notification,
            isSharedWindowCard: attempt.isSharedWindowCard,
            attempt: yield* authenticateAttempt(
              envelope,
              attempt,
              notification
            ),
            ...settlement,
          };

          if (envelope.refund) {
            return yield* reconcileRefund(payment);
          }

          const verified = yield* verifyPayment(payment);
          yield* applyVerifiedOutcome(verified);

          return yield* acceptEvent(notification);
        },
        (effect) =>
          effect.pipe(
            Effect.scoped,
            Effect.mapError((cause) =>
              protocol.isError(cause)
                ? cause
                : protocol.error({
                    errorCode: "transition_failed",
                    message: `${label} webhook processing failed.`,
                    cause,
                  })
            ),
            Effect.annotateLogs({ provider })
          )
      ),
    };
  });
const isTerminalPaymentAttemptState = (state: PaymentAttemptState) =>
  state === "failed" || state === "cancelled" || state === "expired";
