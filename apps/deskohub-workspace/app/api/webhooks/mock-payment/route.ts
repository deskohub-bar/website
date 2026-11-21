import { Effect, type Schema } from "effect";
import {
  MockPaymentWebhookError,
  MockPaymentWebhookService,
} from "@/features/checkout/backend/payment/mock-payment-webhook.service";
import { isMockPaymentEnabled } from "@/features/checkout/backend/payment/payment-provider-selection";
import { paymentWebhookDisposition } from "@/features/checkout/backend/payment/payment-webhook-disposition";
import {
  defineWebhookRoute,
  WebhookRefusal,
} from "@/shared/backend/service-route";

const processMockWebhookRequest = Effect.fn("processMockPaymentWebhookRequest")(
  function* (request: Request) {
    const webhooks = yield* MockPaymentWebhookService;
    const payload = yield* Effect.tryPromise({
      try: () => request.json() as Promise<Schema.Json>,
      catch: () =>
        new MockPaymentWebhookError({
          errorCode: "mock_webhook_parse_failed",
          failure: "parse_failed",
          message: "Mock payment webhook request body was not valid JSON.",
        }),
    });
    return yield* webhooks.processNotification(payload);
  }
);

const handleMockPaymentWebhook = defineWebhookRoute(
  {
    operation: "mockPaymentWebhook",
    failureMessage: "Mock payment webhook processing failed",
  },
  (request) =>
    processMockWebhookRequest(request).pipe(
      Effect.mapError(
        (error) =>
          new WebhookRefusal({
            disposition: paymentWebhookDisposition[error.failure],
            code: error.errorCode,
            details: { eventId: error.eventId, orderId: error.orderId },
            cause: error.cause,
          })
      ),
      Effect.provide(MockPaymentWebhookService.Live)
    )
);

export const POST = (request: Request) =>
  isMockPaymentEnabled()
    ? handleMockPaymentWebhook(request)
    : Promise.resolve(new Response(null, { status: 404 }));
