import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceNexiLayer } from "@/shared/backend/config/nexi.config";
import { CheckoutError } from "../checkout/checkout-error";
import { makeNexiPaymentProvider } from "./nexi-payment-provider";
import {
  type PaymentProviderAdapter,
  PaymentProviderError,
  PaymentProviders,
} from "./payment-provider";
import {
  configuredPaymentProvider,
  isMockPaymentEnabled,
  selectCheckoutPaymentProvider,
} from "./payment-provider-selection";

export {
  nexiRequestTimeout as paymentVerificationRequestTimeout,
  nexiRequestWorstCaseDuration as paymentLookupWorstCaseDuration,
} from "@/shared/backend/config/nexi.config";

const unavailableMockProvider: PaymentProviderAdapter = {
  unconfirmedSessionFailureCode: "mock_payment_session_unconfirmed",
  prepareSession: () =>
    Effect.fail(
      new CheckoutError({
        code: "checkout_failed",
        message: "Test payment sessions are unavailable.",
      })
    ),
  lookup: () =>
    Effect.fail(
      new PaymentProviderError({ message: "Test payments are unavailable." })
    ),
  verify: () =>
    Effect.fail(
      new PaymentProviderError({ message: "Test payments are unavailable." })
    ),
};

export const PaymentProvidersFromNexi = Layer.effect(
  PaymentProviders,
  Effect.map(makeNexiPaymentProvider, (nexi) =>
    PaymentProviders.of({
      activeProviders: ["nexi"],
      selectForCustomer: () => Effect.succeed("nexi"),
      forAttempt: (provider) =>
        provider === "nexi" ? nexi : unavailableMockProvider,
    })
  )
);

const NexiPaymentProviders = PaymentProvidersFromNexi.pipe(
  Layer.provide(WorkspaceNexiLayer)
);

const PreviewPaymentProviders = Layer.unwrap(
  Effect.promise(async () => {
    const { makeMockPaymentProvider } = await import("./mock-payment-provider");

    return Layer.effect(
      PaymentProviders,
      Effect.gen(function* () {
        const nexi = yield* makeNexiPaymentProvider;
        const mock = yield* makeMockPaymentProvider;
        const mode = configuredPaymentProvider();
        const adapters = { nexi, mock };

        return PaymentProviders.of({
          activeProviders: ["nexi", "mock"],
          forAttempt: (provider) => adapters[provider],
          selectForCustomer: (customer, retriedAttempt) =>
            Effect.succeed(
              selectCheckoutPaymentProvider(mode, customer, retriedAttempt)
            ),
        });
      })
    ).pipe(
      Layer.provide(
        Layer.mergeAll(WorkspaceNexiLayer, WorkspaceDatabase.Default)
      )
    );
  })
);

export const PaymentProvidersLive = Layer.suspend(() =>
  isMockPaymentEnabled() ? PreviewPaymentProviders : NexiPaymentProviders
);
