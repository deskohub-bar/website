import "@/shared/polyfills/temporal";

import { Context, Duration, Effect, Layer } from "effect";
import type { WorkspaceReservation } from "@/features/reservation/backend/workspace-reservation.repository";
import { PaymentProviders } from "../payment/payment-provider";
import {
  PaymentProvidersLive,
  paymentVerificationRequestTimeout,
} from "../payment/payment-providers";
import type { PaymentAttempt } from "../repositories/payment-attempt.repository";

/**
 * What the provider's order says about an attempt's stored payment page.
 * Nexi has no "payable" field and offers no way to cancel an unpaid page, so
 * this is an observation, not a guarantee:
 *
 * - `no_activity`: the order has no operation and no authorized or captured
 *   amount. Nothing has paid, refused or cancelled it yet, so its page may
 *   still take a payment.
 * - `activity`: Nexi recorded an operation: a payment under way or done, a
 *   refusal, or the cancellation Nexi records when it ends an abandoned
 *   page. The page no longer takes a new payment.
 * - `unknown`: the provider could not be asked in time, or the attempt has
 *   no provider order.
 */
export type PaymentPageProviderObservation =
  | "no_activity"
  | "activity"
  | "unknown"
  | "inactive";

/**
 * How long a page render waits for the provider: one Nexi request and a
 * little margin. The lookup's own retries never hold up the page; a slow
 * provider reads as `unknown`.
 */
const observationTimeout = Duration.sum(
  paymentVerificationRequestTimeout,
  Duration.seconds(1)
);

interface IPaymentPageProviderStatus {
  /**
   * Reads the provider order of the reservation's attempt once, within
   * `observationTimeout`.
   */
  readonly observe: (input: {
    readonly attempt: Pick<PaymentAttempt, "provider" | "providerOrderId">;
    readonly reservation: Pick<WorkspaceReservation, "correlationId">;
  }) => Effect.Effect<PaymentPageProviderObservation>;
}

export class PaymentPageProviderStatus extends Context.Service<
  PaymentPageProviderStatus,
  IPaymentPageProviderStatus
>()("@deskohub-workspace/checkout/PaymentPageProviderStatus") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const providers = yield* PaymentProviders;
      return {
        observe: Effect.fn("PaymentPageProviderStatus.observe")(
          function* ({ attempt, reservation }) {
            if (
              attempt.provider === "internal" ||
              attempt.provider === "fio" ||
              !providers.activeProviders.includes(attempt.provider)
            )
              return "inactive" as const;
            if (!attempt.providerOrderId) return "unknown" as const;
            return yield* providers
              .forAttempt(attempt.provider)
              .lookup({
                providerOrderId: attempt.providerOrderId,
                correlationId: reservation.correlationId,
              })
              .pipe(
                Effect.map((order) =>
                  order.hasActivity
                    ? ("activity" as const)
                    : ("no_activity" as const)
                ),
                Effect.timeout(observationTimeout),
                Effect.catch((cause) =>
                  Effect.logWarning(
                    "Payment page provider status unavailable",
                    { cause }
                  ).pipe(Effect.as("unknown" as const))
                )
              );
          },
          (effect) =>
            effect.pipe(
              Effect.tap((observation) =>
                Effect.annotateCurrentSpan({ observation })
              )
            )
        ),
      };
    })
  );

  static Live = this.Default.pipe(Layer.provide(PaymentProvidersLive));
}
