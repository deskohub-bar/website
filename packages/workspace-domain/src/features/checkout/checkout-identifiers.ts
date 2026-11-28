import { Schema } from "effect";

export const checkoutSessionKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand("CheckoutSessionKey")
).annotate({
  identifier: "CheckoutSessionKey",
  description:
    "One-way persisted lookup key derived from a checkout session identifier.",
});

export type CheckoutSessionKey = typeof checkoutSessionKeySchema.Type;

export const checkoutAttemptKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand("CheckoutAttemptKey")
).annotate({
  identifier: "CheckoutAttemptKey",
  description:
    "One-way persisted idempotency key derived from a checkout attempt.",
});

export type CheckoutAttemptKey = typeof checkoutAttemptKeySchema.Type;

export const paymentAttemptIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("PaymentAttemptId")
).annotate({
  identifier: "PaymentAttemptId",
  description: "Opaque identifier for a persisted payment attempt.",
});

export type PaymentAttemptId = typeof paymentAttemptIdSchema.Type;

export const storedWebhookEventIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("StoredWebhookEventId")
).annotate({
  identifier: "StoredWebhookEventId",
  description: "Opaque database identifier for a persisted webhook event.",
});

export type StoredWebhookEventId = typeof storedWebhookEventIdSchema.Type;
