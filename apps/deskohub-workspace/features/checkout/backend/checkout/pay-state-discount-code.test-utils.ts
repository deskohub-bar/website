import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { Effect } from "effect";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { buildCoworkReservationQuote } from "@/features/checkout/checkout-quote.test-utils";
import { getWorkspaceProductByTier } from "@/features/checkout/product-catalog";
import { calculateDiscounts } from "@/features/discounts/calculator";
import type { DiscountId } from "@/features/discounts/contracts";
import { payableReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import type { NormalizedCoworkReservationOrder } from "@/features/reservation/cowork-reservation";
import { withCoworkProductFields } from "@/features/reservation/cowork-reservation-product";
import { getStoredWorkspaceReservationDetails } from "@/features/reservation/persistence-contracts";
import type { PayableReservation } from "./payable-checkout.service";
import { syntheticPayStateOrderId } from "./signed-pay-state.test-utils";

/** A cowork quote with a 20% promotion code on its discountable price. */
export const buildPayStateCodeQuote = (
  reservation: NormalizedCoworkReservationOrder,
  discountId: DiscountId
) => {
  const { quote: discountQuote } = Effect.runSync(
    calculateDiscounts({
      product: { kind: "cowork", tier: reservation.entryTier },
      discountableSubtotal: getWorkspaceProductByTier(reservation.entryTier)
        .price,
      candidates: [
        {
          discount: {
            id: discountId,
            label: "Member code",
            adjustment: { kind: "percentage", basisPoints: 2000 },
          },
          provenance: {
            providerNamespace: "test-promotion",
            providerReference: discountId,
          },
        },
      ],
    })
  );
  return buildCoworkReservationQuote(reservation, { discountQuote });
};

export const payStateDiscountOrderFixture = (input: {
  readonly reservation: NormalizedCoworkReservationOrder;
  readonly bookedAt: Temporal.Instant;
  readonly holdExpiresAt: Temporal.Instant;
  readonly activePaymentAttemptId: PaymentAttemptId | null;
  readonly activeAttemptPaymentState?: "pending" | "failed";
}): PayableReservation =>
  withCoworkProductFields(
    payableReservationFixture({
      id: syntheticPayStateOrderId,
      dotyposCustomerId: DotyposCustomerIdSchema.make("customer-id"),
      locale: "en-US",
      reservationDetails: getStoredWorkspaceReservationDetails(
        input.reservation
      ),
      reservationCreatedAt: input.bookedAt,
      createdAt: input.bookedAt,
      updatedAt: input.bookedAt,
      reservationHoldExpiresAt: input.holdExpiresAt,
      activePaymentAttemptId: input.activePaymentAttemptId,
      // An ended attempt can remain active with its failed payment state.
      paymentState:
        input.activePaymentAttemptId === null
          ? "not_started"
          : (input.activeAttemptPaymentState ?? "pending"),
    })
  );
