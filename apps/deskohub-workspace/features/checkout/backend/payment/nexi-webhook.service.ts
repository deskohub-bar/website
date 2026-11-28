import {
  checkNexiWebhookSecurityToken,
  decodeNexiWebhookNotification,
  deriveNexiWebhookEventIdentity,
  isNexiRefundOperation,
} from "@deskohub/nexi";
import { Context, Data, Effect, Layer, type Schema } from "effect";
import { PaymentProvidersLive } from "./payment-providers";
import { paymentWebhookDependencies } from "./payment-webhook-dependencies";
import {
  makePaymentWebhookProcessor,
  type PaymentWebhookProtocol,
  type PaymentWebhookResult,
  type WebhookErrorCode,
} from "./payment-webhook-processor";

export class NexiWebhookProcessingError extends Data.TaggedError(
  "NexiWebhookProcessingError"
)<{
  readonly errorCode: WebhookErrorCode<"nexi">;
  readonly eventId?: string;
  readonly orderId?: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface INexiWebhookService {
  readonly processNotification: (
    payload: Schema.Json
  ) => Effect.Effect<PaymentWebhookResult, NexiWebhookProcessingError>;
}

export { paymentWebhookResultLogFields as nexiWebhookResultLogFields } from "./payment-webhook-processor";

const nexiWebhookProtocol: PaymentWebhookProtocol<NexiWebhookProcessingError> =
  {
    provider: "nexi",
    label: "Nexi",
    operation: "nexiWebhook.processNotification",
    decode: Effect.fnUntraced(function* (payload) {
      const envelope = yield* decodeNexiWebhookNotification(payload).pipe(
        Effect.mapError(
          (cause) =>
            new NexiWebhookProcessingError({
              errorCode: "nexi_webhook_parse_failed",
              message: "Nexi webhook notification payload was invalid.",
              cause,
            })
        )
      );
      const { eventId } = deriveNexiWebhookEventIdentity(envelope);
      const { orderId, operationId, operationType, operationResult } =
        envelope.operation;
      return {
        eventId,
        providerOrderId: orderId,
        token: envelope.securityToken,
        refund: isNexiRefundOperation(envelope.operation),
        diagnostics: { operationId, operationType, operationResult },
      };
    }),
    checkToken: (notificationSecurityToken, expectedSecurityToken) =>
      checkNexiWebhookSecurityToken({
        notificationSecurityToken,
        expectedSecurityToken,
      }).status,
    error: ({ errorCode, ...input }) =>
      new NexiWebhookProcessingError({
        ...input,
        errorCode: `nexi_webhook_${errorCode}`,
      }),
    isError: (cause): cause is NexiWebhookProcessingError =>
      cause instanceof NexiWebhookProcessingError,
  };

export class NexiWebhookService extends Context.Service<
  NexiWebhookService,
  INexiWebhookService
>()("NexiWebhookService") {
  static Default = Layer.effect(
    this,
    makePaymentWebhookProcessor(nexiWebhookProtocol)
  );

  static Live = this.Default.pipe(
    Layer.provide(paymentWebhookDependencies),
    Layer.provide(PaymentProvidersLive)
  );
}
