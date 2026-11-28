import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause } from "effect";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import { toPaymentAttempt } from "../repositories/payment-attempt.repository";
import {
  type PaymentLifecycleTransition,
  paymentAbandonedAfterProviderCutoffFailureCode,
} from "../repositories/payment-lifecycle-state";

export const pendingNexiAttemptFixture = (
  workspaceReservationId: WorkspaceReservationId,
  id: PaymentAttemptId,
  timestamp: Temporal.Instant
) =>
  toPaymentAttempt({
    id,
    workspaceReservationId,
    orderId: standaloneReservationOrderId(workspaceReservationId),
    provider: "nexi",
    providerOrderId: "provider-order-id",
    securityToken: null,
    state: "pending",
    refundState: "not_required",
    refundTargetValue: null,
    refundedAmountValue: null,
    refundedAt: null,
    refundCheckedAt: null,
    amountValue: 29_000,
    amountExponent: 2,
    currency: "CZK",
    providerRedirectUrl: null,
    lastWebhookEventId: null,
    lastProviderOperationId: null,
    lastProviderStatus: null,
    failureCode: null,
    providerOrderCreatedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

export const expiredPaymentTransitionFixture = (
  workspaceReservationId: WorkspaceReservationId,
  id: PaymentAttemptId,
  timestamp: Temporal.Instant
): PaymentLifecycleTransition => ({
  changed: true,
  timestamp,
  attempt: {
    ...pendingNexiAttemptFixture(
      workspaceReservationId,
      id,
      timestamp.subtract({ minutes: 10 })
    ),
    state: "expired",
    failureCode: paymentAbandonedAfterProviderCutoffFailureCode,
    updatedAt: timestamp,
  },
});

export const holdCleanupQueryFailure = (query: string, message: string) =>
  new EffectDrizzleQueryError({
    query,
    params: [],
    cause: Cause.die(new Error(message)),
  });
