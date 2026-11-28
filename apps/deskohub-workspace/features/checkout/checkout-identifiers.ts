export {
  type CheckoutAttemptKey,
  type CheckoutSessionKey,
  checkoutAttemptKeySchema,
  checkoutSessionKeySchema,
  type PaymentAttemptId,
  paymentAttemptIdSchema,
  type StoredWebhookEventId,
  storedWebhookEventIdSchema,
} from "@deskohub/workspace-domain/features/checkout/checkout-identifiers";

import { Schema } from "effect";

export const checkoutSessionIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CheckoutSessionId")
).annotate({
  identifier: "CheckoutSessionId",
  description: "Browser-generated identifier for one checkout session.",
});
export type CheckoutSessionId = typeof checkoutSessionIdSchema.Type;

export const checkoutAttemptIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CheckoutAttemptId")
).annotate({
  identifier: "CheckoutAttemptId",
  description: "Browser-generated identifier for one checkout submission.",
});
export type CheckoutAttemptId = typeof checkoutAttemptIdSchema.Type;

const createCheckoutIdentifier = () =>
  globalThis.crypto?.randomUUID?.() ??
  `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const decodeCheckoutSessionId = Schema.decodeUnknownSync(
  checkoutSessionIdSchema
);
const decodeCheckoutAttemptId = Schema.decodeUnknownSync(
  checkoutAttemptIdSchema
);

export const createCheckoutSessionId = (): CheckoutSessionId =>
  decodeCheckoutSessionId(createCheckoutIdentifier());

export const createCheckoutAttemptId = (): CheckoutAttemptId =>
  decodeCheckoutAttemptId(createCheckoutIdentifier());

export const promoteCheckoutAttemptToSessionId = (
  attemptId: CheckoutAttemptId
): CheckoutSessionId => checkoutSessionIdSchema.make(attemptId);
