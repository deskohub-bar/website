import { Context, Effect, Layer } from "effect";
import { NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE } from "@/features/checkout/payment-fallback";
import type { WorkspaceReservation } from "@/features/reservation/backend/workspace-reservation.repository";
import { PaymentProviders } from "../payment/payment-provider";
import { PaymentProvidersLive } from "../payment/payment-providers";
import type { PaymentAttempt } from "../repositories/payment-attempt.repository";
import { PaymentRetryUnavailableError } from "./payment-retry-unavailable";

/**
 * What the provider says about the payment a retry would replace:
 * - `ended_unpaid`: no amount was authorized or captured, and every
 *   operation is a declined or abandoned authorization or capture (or there
 *   is none). Its page may still be open when it has no operation; a payment
 *   made there after the retry's own is refunded by late-payment recovery.
 * - `may_settle`: any other operation (a payment under way or done, a void,
 *   a refund, one of unknown type or result) or any amount: money may move,
 *   so no retry starts.
 * - `no_provider_order`: the attempt names no provider order, which a
 *   payment attempt that reached its terminal state never lacks.
 */
export type PaymentRetryProviderState =
  | "ended_unpaid"
  | "may_settle"
  | "no_provider_order";

interface IPaymentRetryProviderCheck {
  /**
   * Asks the provider, now, whether the attempt's payment ended without
   * moving money. A lookup that fails fails the check, so a retry never
   * starts on a payment nobody could read.
   */
  readonly check: (input: {
    readonly attempt: Pick<
      PaymentAttempt,
      "provider" | "providerOrderId" | "failureCode" | "amount"
    >;
    readonly reservation: Pick<WorkspaceReservation, "correlationId">;
  }) => Effect.Effect<PaymentRetryProviderState, PaymentRetryUnavailableError>;
}

/**
 * The provider gate in front of every payment retry. It is the one place
 * that decides, so cancelling the provider's page first can replace it.
 */
export class PaymentRetryProviderCheck extends Context.Service<
  PaymentRetryProviderCheck,
  IPaymentRetryProviderCheck
>()("@deskohub-workspace/checkout/PaymentRetryProviderCheck") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const providers = yield* PaymentProviders;
      return PaymentRetryProviderCheck.of({
        check: Effect.fn("PaymentRetryProviderCheck.check")(function* ({
          attempt,
          reservation,
        }) {
          if (!attempt.providerOrderId) return "no_provider_order" as const;
          if (
            attempt.provider === "internal" ||
            attempt.provider === "fio" ||
            !providers.activeProviders.includes(attempt.provider)
          ) {
            return yield* new PaymentRetryUnavailableError({
              message: "The original payment provider is inactive.",
            });
          }
          const markedForFallback =
            attempt.provider === "nexi" &&
            attempt.failureCode === NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE;
          const order = yield* providers
            .forAttempt(attempt.provider)
            .lookup({
              providerOrderId: attempt.providerOrderId,
              correlationId: reservation.correlationId,
              ...(markedForFallback && { expectedAmount: attempt.amount }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PaymentRetryUnavailableError({
                    message: "The payment provider could not be asked.",
                    cause,
                  })
              )
            );
          const canRetry = markedForFallback
            ? order.canFallback
            : order.canRetry;
          const state = canRetry ? "ended_unpaid" : "may_settle";
          // Operation types and results only; never ids or tokens.
          yield* Effect.logInfo("Payment retry provider state read", {
            state,
            ...order.diagnostics,
          });
          return state;
        }),
      });
    })
  );

  static Live = this.Default.pipe(Layer.provide(PaymentProvidersLive));
}
