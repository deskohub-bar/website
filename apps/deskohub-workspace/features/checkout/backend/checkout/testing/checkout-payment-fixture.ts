import {
  type DotyposReservationId,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import type { LatePaymentRecovery } from "@/db/schema";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { pendingNexiAttemptFixture } from "../../holds/reservation-hold-cleanup.test-utils";
import type { PaymentAttempt } from "../../repositories/payment-attempt.repository";

export const paymentAttemptWithPageFixture = ({
  id,
  reservationId,
  createdAt,
  ...overrides
}: Partial<Omit<PaymentAttempt, "orderId" | "workspaceReservationId">> & {
  readonly id: PaymentAttemptId;
  readonly reservationId: WorkspaceReservationId;
  readonly createdAt: Temporal.Instant;
}): PaymentAttempt => ({
  ...pendingNexiAttemptFixture(reservationId, id, createdAt),
  securityToken: "security-token",
  amount: { value: 35_000, exponent: 2, currency: "CZK" },
  providerRedirectUrl: "https://provider.example/pay",
  providerOrderCreatedAt: createdAt,
  ...overrides,
});

export const latePaymentRecoveryFixture = ({
  paymentAttemptId,
  workspaceReservationId,
  originalDotyposReservationId,
  verifiedPaidAt,
  state,
  recoveredDotyposReservationId,
}: Pick<
  LatePaymentRecovery,
  | "paymentAttemptId"
  | "workspaceReservationId"
  | "originalDotyposReservationId"
  | "verifiedPaidAt"
> &
  (
    | {
        readonly state: Exclude<LatePaymentRecovery["state"], "recovered">;
        readonly recoveredDotyposReservationId?: never;
      }
    | {
        readonly state: "recovered";
        readonly recoveredDotyposReservationId: DotyposReservationId;
      }
  )): LatePaymentRecovery => ({
  paymentAttemptId,
  workspaceReservationId,
  webhookEventId: null,
  providerOperationId: null,
  providerStatus: null,
  state,
  originalDotyposReservationId,
  recoveredDotyposReservationId: recoveredDotyposReservationId ?? null,
  failureCode:
    state === "refund_required" || state === "review_required"
      ? "late_payment_reservation_unavailable"
      : null,
  verifiedPaidAt,
  claimedAt: state === "pending" ? null : verifiedPaidAt,
  completedAt:
    state === "pending" || state === "processing" ? null : verifiedPaidAt,
  createdAt: verifiedPaidAt,
  updatedAt: verifiedPaidAt,
});

export const checkoutDotyposReservationId = DotyposReservationIdSchema.make(
  "dotypos-reservation-id"
);
