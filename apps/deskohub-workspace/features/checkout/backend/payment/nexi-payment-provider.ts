import { randomUUID } from "node:crypto";
import {
  classifyNexiFailureStatus,
  getNexiPaymentMetadata,
  isDeclinedNexiPaymentOperation,
  NexiCorrelationIdSchema,
  NexiCurrencySchema,
  NexiCustomerReferenceSchema,
  NexiOrderIdSchema,
  NexiService,
  summarizeNexiRefunds,
} from "@deskohub/nexi";
import { Effect, Schema } from "effect";
import { hasProviderPaymentActivity } from "@/features/checkout/provider-order-abandonment";
import { CheckoutError } from "../checkout/checkout-error";
import { NexiAmountFromWorkspaceMoney } from "./nexi-amount.codec";
import { getNexiCurrencyOverride } from "./nexi-currency";
import {
  type PaymentProviderAdapter,
  PaymentProviderError,
} from "./payment-provider";

const encodeAmount = Schema.encodeEffect(NexiAmountFromWorkspaceMoney);
const decodeCurrency = Schema.decodeUnknownEffect(NexiCurrencySchema);

export const makeNexiPaymentProvider = Effect.gen(function* () {
  const nexi = yield* NexiService;

  return {
    unconfirmedSessionFailureCode: "nexi_hpp_create_unconfirmed",
    prepareSession: Effect.fn("NexiPaymentProvider.prepareSession")(
      function* (input) {
        const providerOrderId = NexiOrderIdSchema.make(
          `D${BigInt(`0x${randomUUID().replaceAll("-", "")}`)
            .toString(36)
            .toUpperCase()}`
        );
        const currencyOverride = getNexiCurrencyOverride();
        const { amount, currency } = yield* encodeAmount(
          currencyOverride
            ? { ...input.amount, currency: currencyOverride }
            : input.amount
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckoutError({
                code: "checkout_failed",
                message: "Unsupported payment amount.",
                cause,
              })
          )
        );
        const create = Effect.suspend(() =>
          nexi
            .createHostedPaymentPage({
              orderId: providerOrderId,
              correlationId: NexiCorrelationIdSchema.make(input.correlationId),
              amount,
              currency,
              locale: input.locale,
              notificationUrl: input.notificationUrl,
              resultUrl: input.resultUrl,
              cancelUrl: input.cancelUrl,
              customer: {
                ...input.customer,
                id:
                  input.customer.id === undefined
                    ? undefined
                    : NexiCustomerReferenceSchema.make(input.customer.id),
              },
            })
            .pipe(
              Effect.map(({ orderId, securityToken, hostedPage }) => ({
                providerOrderId: orderId,
                securityToken,
                hostedPage,
              })),
              Effect.mapError((cause) => {
                const status =
                  cause._tag === "ExternalAPIError"
                    ? cause.statusCode
                    : undefined;
                const rejected =
                  status !== undefined &&
                  status >= 400 &&
                  status < 500 &&
                  ![408, 409, 425, 429].includes(status);
                return new PaymentProviderError({
                  message: "Nexi hosted payment page creation failed.",
                  cause,
                  transportErrorTag: cause._tag,
                  ...(rejected && {
                    creationRejection: {
                      failureCode: "nexi_hpp_create_failed",
                      providerStatus: "hpp_create_failed",
                    },
                  }),
                });
              })
            )
        );

        return {
          providerOrderId,
          create,
          logFields: { nexiAmount: amount, nexiCurrency: currency },
        };
      }
    ),
    lookup: Effect.fn("NexiPaymentProvider.lookup")(function* (input) {
      const order = yield* nexi
        .getOrder({
          orderId: NexiOrderIdSchema.make(input.providerOrderId),
          correlationId: NexiCorrelationIdSchema.make(input.correlationId),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PaymentProviderError({
                message: "Nexi order lookup failed.",
                cause,
                notFound:
                  cause._tag === "ExternalAPIError" && cause.statusCode === 404,
              })
          )
        );
      const amounts = {
        authorizedAmount: order.authorizedAmount,
        capturedAmount: order.capturedAmount,
      };
      const refund = summarizeNexiRefunds(order.operations);
      const hasActivity = hasProviderPaymentActivity({
        ...amounts,
        operationCount: order.operations.length,
      });
      return {
        hasActivity,
        canRetry:
          order.operations.every(isDeclinedNexiPaymentOperation) &&
          !hasProviderPaymentActivity({ ...amounts, operationCount: 0 }),
        canFallback:
          input.expectedAmount !== undefined &&
          order.reportedStatus?.orderId === input.providerOrderId &&
          order.amount === String(input.expectedAmount.value) &&
          order.currency ===
            (getNexiCurrencyOverride() ?? input.expectedAmount.currency) &&
          !hasProviderPaymentActivity({
            authorizedAmount: order.reportedStatus.authorizedAmount,
            capturedAmount: order.reportedStatus.capturedAmount,
            operationCount: order.operations.length,
          }) &&
          order.reportedStatus.lastOperationType === undefined &&
          order.reportedStatus.lastOperationTime === undefined,
        diagnostics: {
          lastOperationType: order.lastOperationType,
          operations: order.operations.map(
            ({ operationType, operationResult }) =>
              `${operationType ?? "?"}:${operationResult ?? "?"}`
          ),
        },
        ...(refund && { refund }),
      };
    }),
    verify: Effect.fn("NexiPaymentProvider.verify")(function* (input) {
      const currency = yield* decodeCurrency(input.amount.currency).pipe(
        Effect.mapError(
          (cause) =>
            new PaymentProviderError({
              message: "Payment attempt has an invalid Nexi currency.",
              cause,
              invalidInput: true,
            })
        )
      );
      const verification = yield* nexi
        .verifyPaymentOutcome({
          orderId: NexiOrderIdSchema.make(input.providerOrderId),
          correlationId: NexiCorrelationIdSchema.make(input.correlationId),
          amount: String(input.amount.value),
          currency: getNexiCurrencyOverride() ?? currency,
          securityToken: input.securityToken,
          deadline: input.deadline,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PaymentProviderError({
                message: "Nexi payment outcome verification failed.",
                cause,
              })
          )
        );
      const metadata = getNexiPaymentMetadata(verification);
      const observation = {
        ...metadata,
        mismatches: verification.mismatches,
        providerOrderStatus: verification.provider.orderStatus,
        hasActivity: hasProviderPaymentActivity(verification.provider),
      };
      if (verification.status === "failure") {
        return {
          ...observation,
          status: verification.status,
          terminalState: classifyNexiFailureStatus(metadata.providerStatus),
          failureCode: "nexi_payment_failed",
        };
      }
      return { ...observation, status: verification.status };
    }),
  } satisfies PaymentProviderAdapter;
});
