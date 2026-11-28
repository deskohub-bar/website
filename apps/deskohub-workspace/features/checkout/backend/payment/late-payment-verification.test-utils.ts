import { DotyposReservationIdSchema } from "@deskohub/dotypos";
import {
  NexiOperationIdSchema,
  NexiOrderIdSchema,
  type NexiService,
} from "@deskohub/nexi";
import { type Effect, Schema } from "effect";
import type { LatePaymentRecovery } from "@/db/schema";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { orderIdSchema } from "@/features/order";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { reservationIdForOrder } from "@/features/reservation/persistence-contracts";
import type { PaymentAttempt } from "../repositories/payment-attempt.repository";

export const orderId = Schema.decodeSync(orderIdSchema)(
  "018f0b50-0000-7000-8000-000000000001"
);
const reservationId = reservationIdForOrder(orderId);
const paymentAttemptId = Schema.decodeSync(paymentAttemptIdSchema)(
  "attempt-id"
);
const providerOrderId =
  Schema.decodeSync(NexiOrderIdSchema)("provider-order-id");
const providerOperationId = Schema.decodeSync(NexiOperationIdSchema)(
  "operation-id"
);
const originalDotyposReservationId = Schema.decodeSync(
  DotyposReservationIdSchema
)("dotypos-reservation-1");

export const expiredReservation = workspaceReservationFixture({
  id: reservationId,
  dotyposReservationId: originalDotyposReservationId,
  reservationState: "hold_expired",
  paymentState: "expired",
  fulfillmentState: "not_started",
  activePaymentAttemptId: paymentAttemptId,
  reservationConfirmedAt: null,
  paidAt: null,
  fulfilledAt: null,
});

export const expiredAttempt: PaymentAttempt = {
  id: paymentAttemptId,
  orderId,
  workspaceReservationId: reservationId,
  provider: "nexi",
  providerOrderId,
  securityToken: "security-token",
  state: "expired",
  refundState: "not_required",
  refundTargetValue: null,
  refundedAmountValue: null,
  refundedAt: null,
  refundCheckedAt: null,
  amount: { value: 29_000, exponent: 2, currency: "CZK" },
  providerRedirectUrl: null,
  lastWebhookEventId: null,
  lastProviderOperationId: null,
  lastProviderStatus: null,
  failureCode: null,
  providerOrderCreatedAt: null,
  createdAt: expiredReservation.createdAt,
  updatedAt: expiredReservation.updatedAt,
};

export const recoveryFixture = (
  overrides: Partial<LatePaymentRecovery> = {}
): LatePaymentRecovery => {
  const createdAt = overrides.createdAt ?? Temporal.Now.instant();
  return {
    paymentAttemptId,
    workspaceReservationId: reservationId,
    webhookEventId: null,
    providerOperationId,
    providerStatus: "EXECUTED",
    state: "pending",
    originalDotyposReservationId,
    recoveredDotyposReservationId: null,
    failureCode: null,
    verifiedPaidAt: createdAt,
    claimedAt: null,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
};

type NexiVerification = Effect.Success<
  ReturnType<NexiService["Service"]["verifyPaymentOutcome"]>
>;

export const verification = (
  status: NexiVerification["status"],
  mismatches: NexiVerification["mismatches"] = []
): NexiVerification => ({
  status,
  provider: {
    orderId: providerOrderId,
    operationId: providerOperationId,
    operationCount: 1,
    amount: "29000",
    currency: "CZK",
    authorizedAmount: undefined,
    capturedAmount: undefined,
    orderStatus: status === "success" ? "EXECUTED" : "DECLINED",
    captureExecuted: status === "success",
  },
  mismatches,
});
