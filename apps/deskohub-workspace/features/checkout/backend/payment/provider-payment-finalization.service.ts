import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Result,
  type Scope,
} from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { OrderId } from "@/features/order";
import { currentPreciseInstant } from "@/shared/utils/temporal";
import { getProviderOrderAbandonmentCutoff } from "../../provider-order-abandonment";
import { CheckoutAnalytics } from "../analytics/checkout-analytics.service";
import {
  isProviderPaymentAttempt,
  PaymentAttemptRepository,
  type ProviderPaymentAttempt,
  paymentAttemptLogFields,
} from "../repositories/payment-attempt.repository";
import type { PaymentLifecycleRepositoryError } from "../repositories/payment-lifecycle.repository";
import { lifecycleStateError } from "../repositories/payment-lifecycle-state";
import type {
  OrderPaymentHandler,
  PaymentOrder,
} from "./order-payment-handler";
import { OrderPaymentHandlers } from "./order-payment-handlers.service";
import { PaymentProviders, type PaymentVerification } from "./payment-provider";
import { PaymentProvidersLive } from "./payment-providers";
import { paymentVerificationLogFields } from "./payment-verification-log-fields";
import {
  isVerifiableProviderPaymentAttempt,
  type VerifiableProviderPaymentAttempt,
} from "./verifiable-provider-payment-attempt";

/**
 * An operation-free provider order, or an unattached session, still inside
 * its abandonment window. Nothing can resolve it before `abandonmentCutoff`.
 */
export class ProviderPaymentDeferral extends Data.TaggedClass(
  "ProviderPaymentDeferral"
)<{
  readonly abandonmentCutoff: Temporal.Instant;
}> {}

export type ProviderPaymentFinalizationResult =
  | "abandoned"
  | ProviderPaymentDeferral
  | "not_found"
  | "not_pending"
  | "not_verifiable"
  | "provider_verification_failed"
  | "verification_mismatch"
  | "awaiting_payment"
  | "pending"
  | "recovery_pending"
  | "paid"
  | "terminal";

/**
 * A finalization result for log annotations: its outcome, and the
 * abandonment cutoff of a deferral.
 */
export const providerPaymentFinalizationLogFields = (
  result: ProviderPaymentFinalizationResult
) =>
  result instanceof ProviderPaymentDeferral
    ? {
        providerFinalizationResult: "deferred",
        abandonmentCutoff: result.abandonmentCutoff.toString(),
      }
    : { providerFinalizationResult: result, abandonmentCutoff: undefined };

/**
 * A finalization request for log annotations: the ids it names, when it
 * checks for abandonment, and its verification deadline in milliseconds.
 */
const providerPaymentFinalizationInputLogFields = (
  input: Parameters<
    IProviderPaymentFinalizationService["finalizePendingProviderPayment"]
  >[0]
) => ({
  orderId: input.orderId,
  paymentAttemptId: input.paymentAttemptId,
  webhookEventId: input.webhookEventId,
  abandonmentCheckedAt: input.abandonmentCheckedAt?.toString(),
  verificationDeadlineMillis:
    input.verificationDeadline === undefined
      ? undefined
      : Duration.toMillis(input.verificationDeadline),
});

export interface IProviderPaymentFinalizationService {
  readonly finalizePendingProviderPayment: (input: {
    readonly orderId: OrderId;
    readonly paymentAttemptId?: PaymentAttemptId;
    readonly webhookEventId?: string;
    readonly abandonmentCheckedAt?: Temporal.Instant;
    readonly sharedWindowCutoff?: Temporal.Instant;
    /** Bounds payment verification, retries included. */
    readonly verificationDeadline?: Duration.Input;
  }) => Effect.Effect<
    ProviderPaymentFinalizationResult,
    PaymentLifecycleRepositoryError
  >;
}

export class ProviderPaymentFinalizationService extends Context.Service<
  ProviderPaymentFinalizationService,
  IProviderPaymentFinalizationService
>()("ProviderPaymentFinalizationService") {
  static Default = makeProviderPaymentFinalizationServiceLayer(this);

  static Live = this.Default.pipe(
    Layer.provide(PaymentAttemptRepository.Default),
    Layer.provide(OrderPaymentHandlers.Live),
    Layer.provide(CheckoutAnalytics.Live),
    Layer.provide(WorkspaceDatabase.Default),
    Layer.provide(PaymentProvidersLive)
  );
}

function makeProviderPaymentFinalizationServiceLayer(
  service: typeof ProviderPaymentFinalizationService
) {
  return Layer.effect(
    service,
    Effect.gen(function* () {
      const handlers = yield* OrderPaymentHandlers;
      const paymentAttempts = yield* PaymentAttemptRepository;
      const providers = yield* PaymentProviders;
      const checkoutAnalytics = yield* CheckoutAnalytics;

      /**
       * Ends an attempt whose hosted payment page creation failed ambiguously
       * and never attached a provider session. Only an attached session's
       * hosted page reaches the customer. Hold cleanup fails the attempt
       * after the abandonment window unless the provider order unexpectedly
       * shows payment activity.
       */
      const resolveUnattachedProviderSession = Effect.fn(
        "providerPaymentFinalization.resolveUnattachedProviderSession"
      )(function* (input: {
        readonly order: PaymentOrder;
        readonly handler: OrderPaymentHandler;
        readonly attempt: ProviderPaymentAttempt;
        readonly checkedAt: Temporal.Instant | undefined;
        readonly sharedWindowCutoff: Temporal.Instant | undefined;
      }): Effect.fn.Return<
        ProviderPaymentFinalizationResult,
        PaymentLifecycleRepositoryError
      > {
        if (!input.checkedAt) {
          yield* Effect.logWarning(
            "Payment finalization left an unattached provider session for hold cleanup"
          );
          return "not_verifiable";
        }
        const abandonmentCutoff =
          input.sharedWindowCutoff ??
          getProviderOrderAbandonmentCutoff(input.attempt.createdAt);
        if (Temporal.Instant.compare(input.checkedAt, abandonmentCutoff) < 0) {
          yield* Effect.logInfo(
            "Payment finalization deferred an unattached provider session"
          );
          return new ProviderPaymentDeferral({ abandonmentCutoff });
        }

        const provider = providers.forAttempt(input.attempt.provider);
        const providerOrder = yield* provider
          .lookup({
            providerOrderId: input.attempt.providerOrderId,
            correlationId: input.order.correlationId,
          })
          .pipe(
            Effect.catchIf(
              (error) => error.notFound === true,
              () => Effect.succeed(null)
            ),
            Effect.tapError((cause) =>
              Effect.logError(
                "Unattached provider session order lookup failed",
                { cause }
              )
            ),
            Effect.result
          );
        if (Result.isFailure(providerOrder)) {
          return "provider_verification_failed";
        }
        if (providerOrder.success?.hasActivity) {
          yield* Effect.logError(
            "Unattached provider session has payment activity and needs operator review"
          );
          return "not_verifiable";
        }

        const terminal = yield* input.handler
          .markTerminal({
            id: input.attempt.id,
            orderId: input.order.id,
            state: "failed",
            failureCode: provider.unconfirmedSessionFailureCode,
            providerStatus: "hpp_create_unconfirmed",
            fromAttemptStates: ["created"],
          })
          .pipe(
            Effect.catchTag(
              "PaymentLifecycleStateError",
              Effect.fn(function* (cause) {
                yield* Effect.logWarning(
                  "Unattached provider session changed before it could fail",
                  { cause }
                );
                return undefined;
              })
            )
          );
        if (!terminal) return "not_pending";

        if (terminal.changed) {
          yield* checkoutAnalytics.paymentFailed({
            attempt: terminal.attempt,
            failureReason: provider.unconfirmedSessionFailureCode,
            timestamp: terminal.timestamp,
          });
        }
        yield* Effect.logInfo(
          "Payment finalization failed an unattached provider session",
          { providerOrderFound: providerOrder.success !== null }
        );
        return "terminal";
      });

      const loadOrder = Effect.fnUntraced(
        function* (orderId: OrderId) {
          const handler = yield* handlers.forOrder(orderId);
          if (!handler) return null;
          const order = yield* handler.load(orderId);
          return order ? { order, handler } : null;
        },
        (effect, orderId) =>
          effect.pipe(
            Effect.tapError((cause) =>
              Effect.logError("Payment finalization order lookup failed", {
                orderId,
                cause,
              })
            ),
            Effect.orElseSucceed(() => null)
          )
      );

      /** An order whose payment already left `pending`. */
      const resolveSettledOrder = Effect.fnUntraced(function* (
        order: PaymentOrder,
        handler: OrderPaymentHandler
      ) {
        const progress = settledOrderProgress(order);
        if (progress === "fulfillment_stalled") {
          // Safety net for a paid order whose webhook fulfillment
          // stalled. The queue dedupes per order, so repeated status
          // refreshes enqueue at most one message.
          yield* Effect.logWarning(
            "Payment finalization enqueueing fulfillment for already-paid order"
          );
          yield* handler.scheduleFulfillment({ orderId: order.id });
          return "paid" as const;
        }
        if (progress === "fulfilled") {
          yield* Effect.logInfo(
            "Payment finalization returned paid for fulfilled order"
          );
          return "paid" as const;
        }

        yield* Effect.logInfo("Payment finalization returned not_pending");
        return "not_pending" as const;
      });

      const loadPaymentAttempt = Effect.fnUntraced(function* (
        orderId: OrderId,
        paymentAttemptId: PaymentAttemptId
      ) {
        const attempt = yield* paymentAttempts.findById(paymentAttemptId).pipe(
          Effect.tapError((cause) =>
            Effect.logError("Payment finalization attempt lookup failed", {
              orderId,
              paymentAttemptId,
              cause,
            })
          ),
          Effect.orElseSucceed(() => null)
        );
        yield* Effect.annotateLogsScoped({
          ...paymentAttemptLogFields(attempt),
          paymentAttemptId,
        });
        yield* Effect.logDebug("Payment finalization attempt lookup completed");
        return attempt;
      });

      const verifyProviderPayment = Effect.fnUntraced(function* ({
        input,
        order,
        attempt,
      }: VerifiableAttemptFinalization) {
        yield* Effect.annotateLogsScoped({ currency: attempt.amount.currency });
        yield* Effect.logInfo(
          "Payment finalization provider verification started"
        );
        const verification = yield* providers
          .forAttempt(attempt.provider)
          .verify({
            providerOrderId: attempt.providerOrderId,
            correlationId: order.correlationId,
            amount: attempt.amount,
            securityToken: attempt.securityToken,
            deadline: input.verificationDeadline,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logError("Provider payment outcome verification failed", {
                orderId: order.id,
                paymentAttemptId: attempt.id,
                providerOrderId: attempt.providerOrderId,
                cause,
              })
            ),
            Effect.result
          );

        yield* Effect.annotateLogsScoped(
          paymentVerificationLogFields(Result.getOrUndefined(verification))
        );
        yield* Effect.logInfo(
          "Payment finalization provider verification completed"
        );
        return verification;
      });

      const markVerifiedPaymentPaid = Effect.fnUntraced(function* (
        { input, order, handler, attempt }: VerifiableAttemptFinalization,
        { providerOperationId, providerStatus }: PaymentVerification
      ) {
        yield* Effect.logInfo("Payment finalization mark paid started");
        const paidSuccess = yield* handler
          .markPaid({
            id: attempt.id,
            orderId: order.id,
            webhookEventId: input.webhookEventId,
            providerOperationId,
            providerStatus,
            paidAt: yield* currentPreciseInstant,
          })
          .pipe(
            Effect.catchTag(
              "PaymentLifecycleStateError",
              Effect.fn(function* (cause) {
                yield* Effect.logWarning(
                  "Payment finalization mark paid returned not_pending",
                  { cause }
                );
                return undefined;
              })
            )
          );

        if (!paidSuccess) {
          return "not_pending" as const;
        }
        if (paidSuccess.settlement === "refund_required")
          return "not_pending" as const;
        if (paidSuccess.settlement === "recovery_pending") {
          yield* handler
            .startRecovery({
              orderId: order.id,
              paymentAttemptId: attempt.id,
              webhookEventId: input.webhookEventId,
              providerOperationId,
              providerStatus,
              verifiedPaidAt: paidSuccess.timestamp,
            })
            .pipe(
              Effect.mapError(() =>
                lifecycleStateError(
                  "startRecovery",
                  { type: "paymentAttemptId", id: attempt.id },
                  "Verified card payment recovery could not be scheduled."
                )
              )
            );
          return "recovery_pending" as const;
        }
        if (paidSuccess.changed) {
          yield* checkoutAnalytics.paymentCompleted({
            attempt: paidSuccess.attempt,
            timestamp: paidSuccess.timestamp,
          });
        }
        yield* Effect.logDebug("Payment finalization mark paid completed");

        yield* handler.scheduleFulfillment({
          orderId: order.id,
          paymentAttemptId: attempt.id,
        });
        return "paid" as const;
      });

      const markVerifiedPaymentTerminal = Effect.fnUntraced(function* (
        { input, order, handler, attempt }: VerifiableAttemptFinalization,
        {
          providerOperationId,
          providerStatus,
          terminalState,
          failureCode,
        }: Extract<PaymentVerification, { status: "failure" }>
      ) {
        yield* Effect.annotateLogsScoped({
          failureKind: terminalState,
          terminalState,
        });

        yield* Effect.logInfo("Payment finalization mark terminal started");
        const terminalSuccess = yield* handler
          .markTerminal({
            id: attempt.id,
            orderId: order.id,
            state: terminalState,
            failureCode,
            webhookEventId: input.webhookEventId,
            providerOperationId,
            providerStatus,
          })
          .pipe(
            Effect.catchTag(
              "PaymentLifecycleStateError",
              Effect.fn(function* (cause) {
                yield* Effect.logWarning(
                  "Payment finalization mark terminal returned not_pending",
                  { cause }
                );
                return undefined;
              })
            )
          );

        if (!terminalSuccess) {
          return "not_pending" as const;
        }
        if (terminalSuccess.changed) {
          if (terminalState === "failed") {
            yield* checkoutAnalytics.paymentFailed({
              attempt: terminalSuccess.attempt,
              failureReason: failureCode,
              timestamp: terminalSuccess.timestamp,
            });
          } else {
            yield* checkoutAnalytics.paymentAbandoned({
              attempt: terminalSuccess.attempt,
              timestamp: terminalSuccess.timestamp,
            });
          }
        }
        yield* Effect.logDebug("Payment finalization mark terminal completed");

        return "terminal" as const;
      });

      /** A verified provider order that is neither paid nor failed. */
      const resolvePendingProviderOrder = Effect.fnUntraced(function* (
        { input, attempt }: VerifiableAttemptFinalization,
        { hasActivity }: PaymentVerification
      ) {
        const checkedAt = input.abandonmentCheckedAt;
        const orderCreatedAt = attempt.providerOrderCreatedAt;
        const cutoff =
          input.sharedWindowCutoff ??
          (orderCreatedAt
            ? getProviderOrderAbandonmentCutoff(orderCreatedAt)
            : undefined);
        if (!hasActivity && !checkedAt) {
          yield* Effect.logInfo(
            "Payment finalization returned awaiting_payment"
          );
          return "awaiting_payment" as const;
        }
        if (!hasActivity && checkedAt && cutoff) {
          const abandoned = Temporal.Instant.compare(checkedAt, cutoff) >= 0;
          yield* Effect.logInfo(
            "Payment finalization resolved empty provider order",
            { result: abandoned ? "abandoned" : "deferred" }
          );
          return abandoned
            ? ("abandoned" as const)
            : new ProviderPaymentDeferral({ abandonmentCutoff: cutoff });
        }
        yield* Effect.logInfo("Payment finalization returned pending");
        return "pending" as const;
      });

      const finalizeVerifiableAttempt = Effect.fnUntraced(function* (
        verifiable: VerifiableAttemptFinalization
      ): Effect.fn.Return<
        ProviderPaymentFinalizationResult,
        PaymentLifecycleRepositoryError,
        Scope.Scope
      > {
        const result = yield* verifyProviderPayment(verifiable);
        if (Result.isFailure(result)) {
          const outcome = result.failure.invalidInput
            ? "not_verifiable"
            : "provider_verification_failed";
          yield* Effect.logWarning(`Payment finalization returned ${outcome}`);
          return outcome;
        }
        const verification = result.success;
        if (verification.mismatches.length > 0) {
          yield* Effect.logWarning(
            "Payment finalization returned verification_mismatch"
          );
          return "verification_mismatch";
        }

        yield* Effect.annotateLogsScoped({
          providerOperationId: verification.providerOperationId,
          providerStatus: verification.providerStatus,
        });
        yield* Effect.logDebug(
          "Payment finalization provider metadata resolved"
        );

        if (verification.status === "success") {
          return yield* markVerifiedPaymentPaid(verifiable, verification);
        }
        if (verification.status === "failure") {
          return yield* markVerifiedPaymentTerminal(verifiable, verification);
        }
        return yield* resolvePendingProviderOrder(verifiable, verification);
      });

      return ProviderPaymentFinalizationService.of({
        finalizePendingProviderPayment: Effect.fn(
          "providerPaymentFinalization.finalizePendingProviderPayment"
        )(
          function* (input) {
            yield* Effect.logInfo("Provider payment finalization started");

            const resolved = yield* loadOrder(input.orderId);
            const paymentAttemptId =
              input.paymentAttemptId ?? resolved?.order.activePaymentAttemptId;
            yield* Effect.annotateLogsScoped({
              ...resolved?.order.logFields,
              paymentAttemptId,
            });
            yield* Effect.logDebug(
              "Payment finalization order lookup completed"
            );

            if (!resolved || !paymentAttemptId) {
              yield* Effect.logInfo("Payment finalization returned not_found");
              return "not_found";
            }
            const { order, handler } = resolved;
            if (order.paymentState !== "pending") {
              if (
                input.sharedWindowCutoff &&
                order.paymentState === "expired" &&
                order.activePaymentAttemptId === paymentAttemptId
              ) {
                const recovery = yield* handler
                  .resumeRecovery({
                    orderId: order.id,
                    paymentAttemptId,
                    requeue: true,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      lifecycleStateError(
                        "resumeRecovery",
                        { type: "paymentAttemptId", id: paymentAttemptId },
                        "Verified card payment recovery could not be rescheduled."
                      )
                    )
                  );
                if (recovery) return "recovery_pending";
              }
              return yield* resolveSettledOrder(order, handler);
            }

            const loadedAttempt = yield* loadPaymentAttempt(
              order.id,
              paymentAttemptId
            );
            const attempt =
              loadedAttempt?.orderId === order.id ? loadedAttempt : null;
            if (
              attempt &&
              isProviderPaymentAttempt(attempt) &&
              attempt.state === "created" &&
              !attempt.securityToken
            ) {
              return yield* resolveUnattachedProviderSession({
                order,
                handler,
                attempt,
                checkedAt: input.abandonmentCheckedAt,
                sharedWindowCutoff: input.sharedWindowCutoff,
              });
            }
            if (!isVerifiableProviderPaymentAttempt(attempt)) {
              yield* Effect.logWarning(
                "Payment finalization returned not_verifiable"
              );
              return "not_verifiable";
            }

            return yield* finalizeVerifiableAttempt({
              input,
              order,
              handler,
              attempt,
            });
          },
          (effect, input) =>
            effect.pipe(
              Effect.scoped,
              Effect.tap((result) =>
                Effect.logInfo("Provider payment finalization completed", {
                  result,
                })
              ),
              Effect.annotateLogs(
                providerPaymentFinalizationInputLogFields(input)
              )
            )
        ),
      });
    })
  );
}
type ProviderPaymentFinalizationInput = Parameters<
  IProviderPaymentFinalizationService["finalizePendingProviderPayment"]
>[0];

interface VerifiableAttemptFinalization {
  readonly input: ProviderPaymentFinalizationInput;
  readonly order: PaymentOrder;
  readonly handler: OrderPaymentHandler;
  readonly attempt: VerifiableProviderPaymentAttempt;
}

/**
 * Where an order whose payment left `pending` stands: a paid order
 * whose fulfillment stalled, a paid order already delivered or delivering,
 * or neither.
 */
const settledOrderProgress = (
  order: Pick<PaymentOrder, "paymentState" | "fulfillmentState">
) => {
  if (order.paymentState !== "paid") return "not_pending";
  if (
    order.fulfillmentState === "not_started" ||
    order.fulfillmentState === "processing"
  ) {
    return "fulfillment_stalled";
  }
  if (
    order.fulfillmentState === "awaiting_delivery" ||
    order.fulfillmentState === "fulfilled"
  ) {
    return "fulfilled";
  }
  return "not_pending";
};
