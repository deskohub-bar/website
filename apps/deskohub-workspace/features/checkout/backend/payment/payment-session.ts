import { Effect } from "effect";
import {
  type PaymentReturnTarget,
  passPaymentReturnTargetParam,
} from "@/features/checkout/payment-return-target";
import type { Locale } from "@/features/i18n";
import type { OrderId, OrderKind } from "@/features/order";
import {
  getWorkspaceRuntimeCallbackOrigin,
  type WorkspaceUrlConfigError,
} from "@/shared/backend/config/workspace-url.config";
import { CheckoutAnalytics } from "../analytics/checkout-analytics.service";
import { CheckoutError } from "../checkout/checkout-error";
import { appendVercelPreviewProtectionBypass } from "../checkout/vercel-preview-protection-bypass";
import {
  isProviderPaymentAttempt,
  type PaymentAttempt,
  paymentAttemptLogFields,
} from "../repositories/payment-attempt.repository";
import type { PaymentLifecycleRepositoryError } from "../repositories/payment-lifecycle.repository";
import { lifecycleStateError } from "../repositories/payment-lifecycle-state";
import type { PaymentAdmission } from "./order-payment-handler";
import {
  OrderPaymentHandlers,
  type PaymentAdmissionDetailsFor,
} from "./order-payment-handlers.service";

import {
  type PaymentCustomer,
  type PaymentProvider,
  PaymentProviders,
  type RetriedPaymentAttempt,
} from "./payment-provider";

const toCheckoutUrlError = (cause: WorkspaceUrlConfigError) =>
  Effect.fail(
    new CheckoutError({
      code: "checkout_failed",
      message: cause.message,
      cause,
    })
  );

const getCheckoutPayReturnUrl: (
  locale: Locale,
  orderId: OrderId,
  provider: PaymentProvider,
  outcome?: "cancelled",
  passReturnTarget?: PaymentReturnTarget
) => Effect.Effect<string, CheckoutError> = Effect.fn(
  "getCheckoutPayReturnUrl"
)(
  function* (locale, orderId, provider, outcome, passReturnTarget) {
    const origin = yield* getWorkspaceRuntimeCallbackOrigin;

    return yield* Effect.try({
      try: () => {
        const url = new URL(
          `/${locale}/checkout/pay/return/${orderId}`,
          origin
        );
        if (outcome) url.searchParams.set("outcome", outcome);
        if (passReturnTarget) {
          url.searchParams.set(passPaymentReturnTargetParam, passReturnTarget);
        }
        if (provider === "nexi") appendVercelPreviewProtectionBypass(url);
        return url.toString();
      },
      catch: (cause) =>
        new CheckoutError({
          code: "checkout_failed",
          message: "Payment checkout return URL could not be created.",
          cause,
        }),
    });
  },
  (effect) =>
    effect.pipe(Effect.catchTag("WorkspaceUrlConfigError", toCheckoutUrlError))
);

const getNotificationUrl = Effect.fn("getPaymentNotificationUrl")(
  function* (provider: PaymentProvider) {
    const origin = yield* getWorkspaceRuntimeCallbackOrigin;

    return yield* Effect.try({
      try: () => {
        const url = new URL(
          provider === "nexi"
            ? "/api/webhooks/nexi"
            : "/api/webhooks/mock-payment",
          origin
        );
        if (provider === "nexi") appendVercelPreviewProtectionBypass(url);
        return url.toString();
      },
      catch: (cause) =>
        new CheckoutError({
          code: "checkout_failed",
          message: "Payment checkout notification URL could not be created.",
          cause,
        }),
    });
  },
  (effect) =>
    effect.pipe(Effect.catchTag("WorkspaceUrlConfigError", toCheckoutUrlError))
);

type AdmitHostedAttempt = (input: {
  readonly provider: PaymentProvider;
  readonly providerOrderId: string;
}) => Effect.Effect<PaymentAttempt, PaymentLifecycleRepositoryError>;

/** Starts a hosted payment for a prepared order using the lifecycle operations of its kind. */
export const startPaymentSession = Effect.fn("startPaymentSession")(function* <
  Kind extends OrderKind,
  PrepareError,
  PrepareServices,
>(
  input: Omit<PaymentAdmission<PaymentAdmissionDetailsFor<Kind>>, "details"> &
    (
      | {
          readonly details: PaymentAdmissionDetailsFor<Kind>;
          readonly admitProvider?: never;
        }
      | { readonly details?: never; readonly admitProvider: AdmitHostedAttempt }
    ) & {
      readonly kind: Kind;
      readonly passReturnTarget?: PaymentReturnTarget;
      readonly correlationId: string;
      readonly customer: PaymentCustomer;
      readonly retriedAttempt?: RetriedPaymentAttempt | undefined;
      readonly beforeAttempt: Effect.Effect<
        void,
        PrepareError,
        PrepareServices
      >;
    }
) {
  const { byKind } = yield* OrderPaymentHandlers;
  const providers = yield* PaymentProviders;
  const provider = yield* providers.selectForCustomer(
    input.customer,
    input.retriedAttempt
  );
  const adapter = providers.forAttempt(provider);
  const analytics = yield* CheckoutAnalytics;
  const handler = byKind[input.kind];
  if (!handler) {
    return yield* new CheckoutError({
      code: "checkout_failed",
      message: "The order kind does not support payment.",
    });
  }
  const notificationUrl = yield* getNotificationUrl(provider);
  const passReturnTarget =
    input.kind === "pass-purchase" ? input.passReturnTarget : undefined;
  const resultUrl = yield* getCheckoutPayReturnUrl(
    input.locale,
    input.orderId,
    provider,
    undefined,
    passReturnTarget
  );
  const cancelUrl = yield* getCheckoutPayReturnUrl(
    input.locale,
    input.orderId,
    provider,
    "cancelled",
    passReturnTarget
  );
  const prepared = yield* adapter.prepareSession({
    amount: input.amount,
    customer: input.customer,
    locale: input.locale,
    correlationId: input.correlationId,
    notificationUrl,
    resultUrl,
    cancelUrl,
  });
  yield* Effect.annotateLogsScoped(prepared.logFields ?? {});
  yield* Effect.logDebug("Checkout provider session inputs prepared");

  yield* input.beforeAttempt;

  // Once the attempt exists, finish creating and attaching its hosted
  // page even when the action deadline passes. Nexi has no idempotency
  // key, so cutting the request off would leave an ambiguous `created`
  // attempt; the Nexi request timeout still bounds this section.
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const attempt = yield* input.admitProvider !== undefined
        ? input.admitProvider({
            provider,
            providerOrderId: prepared.providerOrderId,
          })
        : handler.admitProvider({
            orderId: input.orderId,
            amount: input.amount,
            locale: input.locale,
            details: input.details,
            provider,
            providerOrderId: prepared.providerOrderId,
            retriedAttempt: input.retriedAttempt,
          });
      if (
        input.admitProvider &&
        isProviderPaymentAttempt(attempt) &&
        attempt.provider === provider &&
        attempt.providerOrderId !== prepared.providerOrderId
      ) {
        if (
          attempt.state === "pending" &&
          attempt.providerRedirectUrl &&
          attempt.securityToken
        ) {
          return {
            attachedAttempt: attempt,
            reused: true as const,
            hostedPaymentPage: {
              providerOrderId: attempt.providerOrderId,
              hostedPage: attempt.providerRedirectUrl,
              securityToken: attempt.securityToken,
            },
          };
        }
        return yield* lifecycleStateError(
          "startPaymentSession",
          { type: "paymentAttemptId", id: attempt.id },
          "The existing hosted payment page is not available yet."
        );
      }
      if (
        !isProviderPaymentAttempt(attempt) ||
        attempt.provider !== provider ||
        attempt.providerOrderId !== prepared.providerOrderId
      ) {
        return yield* new CheckoutError({
          code: "checkout_failed",
          message: "Hosted payment attempt configuration is invalid.",
        });
      }
      yield* Effect.annotateLogsScoped(paymentAttemptLogFields(attempt));
      yield* Effect.logInfo("Checkout payment attempt created");

      yield* Effect.logInfo(
        provider === "nexi"
          ? "Nexi hosted payment page creation started"
          : "Mock hosted payment page creation started"
      );
      const hostedPaymentPage = yield* prepared.create.pipe(
        Effect.tapError(
          Effect.fnUntraced(function* (cause) {
            if (!cause.creationRejection) {
              yield* Effect.logError(
                "Ambiguous hosted payment page creation failure retained the active attempt",
                {
                  orderId: input.orderId,
                  paymentAttemptId: attempt.id,
                  errorTag: cause.transportErrorTag ?? cause._tag,
                }
              );
              return;
            }
            const transition = yield* handler.markTerminal({
              id: attempt.id,
              orderId: input.orderId,
              state: "failed",
              ...cause.creationRejection,
            });
            if (transition.changed) {
              yield* analytics.paymentFailed({
                attempt: transition.attempt,
                failureReason: cause.creationRejection.failureCode,
                timestamp: transition.timestamp,
              });
            }
          })
        )
      );
      // Not the page itself: its URL and security token are secrets.
      yield* Effect.annotateLogsScoped({
        providerOrderId: hostedPaymentPage.providerOrderId,
      });
      if (hostedPaymentPage.providerOrderId !== attempt.providerOrderId) {
        return yield* new CheckoutError({
          code: "checkout_failed",
          message: "The payment provider returned an unexpected order ID.",
        });
      }
      yield* Effect.logInfo(
        provider === "nexi"
          ? "Nexi hosted payment page creation completed"
          : "Mock hosted payment page creation completed"
      );

      yield* Effect.logInfo("Checkout hosted payment page attach started");
      const attachedAttempt = yield* handler
        .attachProviderSession({
          id: attempt.id,
          securityToken: hostedPaymentPage.securityToken,
          providerRedirectUrl: hostedPaymentPage.hostedPage,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logError("Checkout hosted payment page attach failed", {
              ...paymentAttemptLogFields(attempt),
              cause,
            })
          )
        );
      return { attachedAttempt, hostedPaymentPage };
    })
  );
});
