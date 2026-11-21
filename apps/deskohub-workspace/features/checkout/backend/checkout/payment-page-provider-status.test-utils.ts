import { mock } from "bun:test";
import { type Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { QrPaymentRepository } from "../repositories/qr-payment.repository";
import {
  type PaymentPageProviderObservation,
  PaymentPageProviderStatus,
} from "./payment-page-provider-status";

export const testReservationPaymentWindow = (expiresAt?: Temporal.Instant) =>
  Layer.mock(QrPaymentRepository, {
    findPaymentWindow: (orderId) =>
      Effect.succeed(
        expiresAt
          ? {
              orderId,
              accountKey: "synthetic-account",
              expiresAt,
              cardAttemptId: null,
              qrAttemptId: null,
            }
          : null
      ),
  });

/**
 * The provider status of every payment page reads as `observation`;
 * `observe` records each lookup. `unknown` stands for a provider that can't
 * be asked, which leaves the provisional reopening window in charge.
 * `answersAfter` advances the test clock by that much before the answer, as
 * a slow provider would.
 */
export const observePaymentPagesAs = (
  observation: PaymentPageProviderObservation,
  options: { readonly answersAfter?: Duration.Input } = {}
) => {
  const { answersAfter } = options;
  const observe = mock(
    (_input: Parameters<PaymentPageProviderStatus["Service"]["observe"]>[0]) =>
      answersAfter === undefined
        ? Effect.succeed(observation)
        : TestClock.adjust(answersAfter).pipe(Effect.as(observation))
  );
  return {
    observe,
    layer: Layer.succeed(PaymentPageProviderStatus, { observe }),
  };
};
