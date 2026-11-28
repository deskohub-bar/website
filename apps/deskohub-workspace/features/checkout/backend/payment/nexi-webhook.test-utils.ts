import "@/shared/polyfills/temporal";

import { DotyposReservationIdSchema } from "@deskohub/dotypos";
import type { LatePaymentRecovery, WebhookEvent } from "@/db/schema";
import {
  paymentAttemptIdSchema,
  storedWebhookEventIdSchema,
} from "@/features/checkout/checkout-identifiers";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import type { PaymentAttemptWithOrderKind } from "../repositories/payment-attempt.repository";

const createdAt = Temporal.Instant.from("2026-06-01T10:00:00Z");
const reservationId = workspaceReservationIdSchema.make(
  "0198c1a2-61c4-7e64-83f3-b3b69dc0dac5"
);
const attemptId = paymentAttemptIdSchema.make("attempt-id");
const storedEventId = storedWebhookEventIdSchema.make("webhook-row-id");
const dotyposReservationId = DotyposReservationIdSchema.make("dotypos-id");

export const nexiWebhookAttemptFixture = (): PaymentAttemptWithOrderKind => ({
  orderId: standaloneReservationOrderId(reservationId),
  orderKind: "reservation",
  isSharedWindowCard: false,
  id: attemptId,
  workspaceReservationId: reservationId,
  provider: "nexi",
  providerOrderId: "provider-order-id",
  state: "pending",
  amount: { value: 35_000, exponent: 2, currency: "CZK" },
  securityToken: "security-token",
  providerRedirectUrl: "https://provider.example/pay",
  providerOrderCreatedAt: createdAt,
  lastWebhookEventId: null,
  lastProviderOperationId: null,
  lastProviderStatus: null,
  failureCode: null,
  refundState: "not_required",
  refundTargetValue: null,
  refundedAmountValue: null,
  refundedAt: null,
  refundCheckedAt: null,
  createdAt,
  updatedAt: createdAt,
});

export const nexiWebhookReservationFixture = () =>
  workspaceReservationFixture({
    id: reservationId,
    reservationState: "held",
    paymentState: "pending",
    fulfillmentState: "not_started",
    activePaymentAttemptId: attemptId,
    dotyposReservationId,
    reservationCreatedAt: createdAt,
    reservationHoldExpiresAt: createdAt.add({ minutes: 30 }),
    reservationConfirmedAt: null,
    paidAt: null,
    fulfilledAt: null,
    createdAt,
    updatedAt: createdAt,
  });

export const nexiWebhookEventFixture = (
  state: WebhookEvent["state"] = "received",
  eventId = "event-id"
): WebhookEvent => ({
  id: storedEventId,
  provider: "nexi",
  eventId,
  legacyEventId: eventId,
  paymentAttemptId: null,
  providerOrderId: "provider-order-id",
  receivedAt: createdAt,
  processedAt: state === "processed" ? createdAt : null,
  state,
  errorCode: state === "failed" ? "nexi_webhook_transition_failed" : null,
  createdAt,
  updatedAt: createdAt,
});

export const nexiWebhookRecoveryFixture = (): LatePaymentRecovery => ({
  paymentAttemptId: attemptId,
  workspaceReservationId: reservationId,
  webhookEventId: "event-id",
  providerOperationId: "operation-id",
  providerStatus: "EXECUTED",
  state: "pending",
  originalDotyposReservationId: dotyposReservationId,
  recoveredDotyposReservationId: null,
  failureCode: null,
  verifiedPaidAt: createdAt,
  claimedAt: null,
  completedAt: null,
  createdAt,
  updatedAt: createdAt,
});
