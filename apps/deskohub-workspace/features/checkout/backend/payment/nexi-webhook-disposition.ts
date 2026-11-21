import { WebhookRefusal } from "@/shared/backend/service-route";
import type { NexiWebhookProcessingError } from "./nexi-webhook.service";
import { paymentWebhookDisposition } from "./payment-webhook-disposition";
import type { WebhookFailure } from "./payment-webhook-processor";

const nexiWebhookPrefix = "nexi_webhook_";

export const nexiWebhookDisposition = (
  code: NexiWebhookProcessingError["errorCode"]
) =>
  paymentWebhookDisposition[
    code.slice(nexiWebhookPrefix.length) as WebhookFailure
  ];

export const nexiWebhookRefusal = (error: NexiWebhookProcessingError) =>
  new WebhookRefusal({
    disposition: nexiWebhookDisposition(error.errorCode),
    code: error.errorCode,
    details: { eventId: error.eventId, orderId: error.orderId },
    cause: error.cause,
  });
