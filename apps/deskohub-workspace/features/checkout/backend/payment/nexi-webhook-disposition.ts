import { Record } from "effect";
import { WebhookRefusal } from "@/shared/backend/service-route";
import type { NexiWebhookProcessingError } from "./nexi-webhook.service";
import { paymentWebhookDisposition } from "./payment-webhook-disposition";
import type { WebhookFailure } from "./payment-webhook-processor";

const toNexiWebhookCode = <Failure extends WebhookFailure>(failure: Failure) =>
  `nexi_webhook_${failure}` as const;

/** Each Nexi webhook error code's disposition, keyed by the full code. */
const nexiWebhookDispositions = Record.mapKeys(
  paymentWebhookDisposition,
  toNexiWebhookCode
);

export const nexiWebhookDisposition = (
  code: NexiWebhookProcessingError["errorCode"]
): (typeof paymentWebhookDisposition)[WebhookFailure] =>
  nexiWebhookDispositions[code];

export const nexiWebhookRefusal = (error: NexiWebhookProcessingError) =>
  new WebhookRefusal({
    disposition: nexiWebhookDisposition(error.errorCode),
    code: error.errorCode,
    details: { eventId: error.eventId, orderId: error.orderId },
    cause: error.cause,
  });
