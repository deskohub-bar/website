import {
  consumePaidFulfillmentMessage,
  paidFulfillmentRedelivery,
  paidFulfillmentTopic,
} from "@/features/checkout/backend/fulfillment";
import { defineQueueRoute } from "@/shared/backend/queue/queue-route";

export const maxDuration = 300;

export const POST = defineQueueRoute(
  "paidFulfillmentQueue",
  paidFulfillmentTopic.topic,
  paidFulfillmentTopic.consume(
    consumePaidFulfillmentMessage,
    paidFulfillmentRedelivery
  )
);
