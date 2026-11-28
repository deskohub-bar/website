import "@/shared/polyfills/temporal";

import { DotyposReservationIdSchema } from "@deskohub/dotypos";
import { EmailDeliveryIdSchema } from "@deskohub/email";
import { NexiOrderIdSchema } from "@deskohub/nexi";
import type { FulfillmentState } from "@/db/schema";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { orderIdSchema } from "@/features/order";
import type { WorkspaceReservation } from "@/features/reservation/backend/workspace-reservation.repository";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { reservationIdForOrder } from "@/features/reservation/persistence-contracts";
import type { PaymentAttempt } from "../repositories/payment-attempt.repository";

export const orderId = orderIdSchema.make(
  "00000000-0000-4000-8000-000000000001"
);
export const reservationId = reservationIdForOrder(orderId);
export const paymentAttemptId = paymentAttemptIdSchema.make("attempt-id");
export const providerOrderId = NexiOrderIdSchema.make("provider-order-id");
export const attemptCreatedAt = Temporal.Instant.from("2026-06-01T10:00:00Z");

export const pendingReservation = workspaceReservationFixture({
  id: reservationId,
  reservationState: "held",
  paymentState: "pending",
  fulfillmentState: "not_started",
  activePaymentAttemptId: paymentAttemptId,
  dotyposReservationId: DotyposReservationIdSchema.make(
    "dotypos-reservation-id"
  ),
  reservationCreatedAt: attemptCreatedAt,
  reservationConfirmedAt: null,
  reservationHoldExpiresAt: attemptCreatedAt.add({ minutes: 30 }),
  paidAt: null,
  fulfilledAt: null,
  createdAt: attemptCreatedAt,
  updatedAt: attemptCreatedAt,
});

const paidAt = attemptCreatedAt.add({ minutes: 1 });
const confirmedAt = paidAt.add({ minutes: 2 });
const fulfillmentUpdatedAt = confirmedAt.add({ minutes: 1 });
const customerEmailDeliveryId = EmailDeliveryIdSchema.make("delivery-id");

export const paidReservation = (
  fulfillmentState: FulfillmentState
): WorkspaceReservation => {
  const confirmed =
    fulfillmentState === "awaiting_delivery" ||
    fulfillmentState === "fulfilled";
  const failed = fulfillmentState === "failed";

  return {
    ...pendingReservation,
    reservationState: confirmed ? "confirmed" : "held",
    paymentState: "paid",
    fulfillmentState,
    reservationConfirmedAt: confirmed ? confirmedAt : null,
    paidAt,
    fulfilledAt: fulfillmentState === "fulfilled" ? fulfillmentUpdatedAt : null,
    fulfillmentFailedAt: failed ? fulfillmentUpdatedAt : null,
    fulfillmentFailureCode: failed ? "dotypos_reservation_failed" : null,
    activeCustomerEmailDeliveryId: confirmed ? customerEmailDeliveryId : null,
    updatedAt:
      fulfillmentState === "not_started" ? paidAt : fulfillmentUpdatedAt,
  };
};

export const pendingAttempt = {
  id: paymentAttemptId,
  orderId,
  workspaceReservationId: reservationId,
  provider: "nexi",
  providerOrderId,
  state: "pending",
  refundState: "not_required",
  refundTargetValue: null,
  refundedAmountValue: null,
  refundedAt: null,
  refundCheckedAt: null,
  amount: { value: 35_000, exponent: 2, currency: "CZK" },
  securityToken: "security-token",
  providerRedirectUrl: "https://provider.example/pay",
  providerOrderCreatedAt: attemptCreatedAt,
  lastWebhookEventId: null,
  lastProviderOperationId: null,
  lastProviderStatus: null,
  failureCode: null,
  createdAt: attemptCreatedAt,
  updatedAt: attemptCreatedAt,
} satisfies PaymentAttempt;

export const unattachedAttempt = {
  ...pendingAttempt,
  state: "created",
  securityToken: null,
  providerRedirectUrl: null,
  providerOrderCreatedAt: null,
} satisfies PaymentAttempt;
