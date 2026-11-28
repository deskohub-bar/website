import { Effect } from "effect";
import { NextResponse } from "next/server";
import {
  NexiWebhookProcessingError,
  NexiWebhookService,
  nexiWebhookRefusal,
  nexiWebhookResultLogFields,
} from "@/features/checkout/backend/payment";
import { configuredPaymentProvider } from "@/features/checkout/backend/payment/payment-provider-selection";
import { defineWebhookRoute } from "@/shared/backend/service-route";
import { isParsedJson } from "@/shared/utils/parsed-json";

const processWebhookRequest = Effect.fn("processNexiWebhookRequest")(function* (
  request: Request
) {
  const parseFailed = (cause: unknown) =>
    new NexiWebhookProcessingError({
      errorCode: "nexi_webhook_parse_failed",
      message: "Nexi webhook request body was not valid JSON.",
      cause,
    });
  const payload = yield* Effect.tryPromise({
    try: () => request.json(),
    catch: parseFailed,
  }).pipe(
    // The body stays out of the error, as it stays out of the logs.
    Effect.filterOrFail(isParsedJson, () =>
      parseFailed(new Error("The parsed body isn't a JSON value."))
    )
  );
  yield* Effect.logInfo("Nexi webhook request body parsed");

  const webhooks = yield* NexiWebhookService;
  const result = yield* webhooks.processNotification(payload);
  yield* Effect.annotateLogsScoped(nexiWebhookResultLogFields(result));
  yield* Effect.logInfo("Nexi webhook request processed");

  return result;
}, Effect.scoped);

/**
 * POST /api/webhooks/nexi
 *
 * Receives Nexi payment notifications and verifies payment state server-side.
 */
export const POST = defineWebhookRoute(
  {
    operation: "nexiWebhook",
    failureMessage: "Nexi webhook processing failed",
  },
  (request) =>
    processWebhookRequest(request).pipe(
      Effect.tap((result) =>
        Effect.logInfo("Nexi webhook response ready", { result })
      ),
      Effect.mapError(nexiWebhookRefusal),
      Effect.provide(NexiWebhookService.Live)
    )
);

/**
 * GET /api/webhooks/nexi
 *
 * Health check endpoint.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    endpoint: "/api/webhooks/nexi",
    paymentProvider: configuredPaymentProvider(),
  });
}
