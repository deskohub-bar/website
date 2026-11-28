import {
  type CanonicalPromotionCode,
  type DiscountId,
  discountQuoteCodec,
} from "@deskohub/workspace-domain/features/discounts/contracts";

export {
  appliedDiscountCodec,
  type CanonicalPromotionCode,
  canonicalPromotionCodeSchema,
  type DiscountId,
  discountAdjustmentSchema,
  discountBasisPointsSchema,
  discountCodec,
  discountIdSchema,
  discountQuoteCodec,
} from "@deskohub/workspace-domain/features/discounts/contracts";

import { Schema } from "effect";
import type { WorkspaceProductIdentity } from "@/features/checkout/product-identity";
import type { WorkspaceProductTarget } from "@/features/discounts/product-target";
import type { Locale } from "@/features/i18n";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import type { Money } from "@/shared/money/money";

export type DiscountAdjustment =
  | {
      readonly kind: "percentage";
      readonly basisPoints: number;
    }
  | {
      readonly kind: "fixed";
      readonly amount: Money;
    };

export type Discount = {
  readonly id: DiscountId;
  /** The label in the checkout locale, shown to the customer. */
  readonly label: string;
  /**
   * The label in `staffLocale`, written to staff-facing records such as the
   * Dotypos reservation note. It stays out of the quote fingerprint, so it
   * never causes `pricing_changed`. Pay states and accounting snapshots
   * signed before it existed lack it; staff then read `label`.
   */
  readonly staffLabel?: string;
  readonly adjustment: DiscountAdjustment;
  readonly expiresAt?: string;
  readonly countdownStartsAt?: string;
};

export type ActiveSale = {
  readonly discount: Discount;
  readonly products: readonly WorkspaceProductTarget[];
};

export type ActiveSaleDiscoveryInput = {
  readonly locale: Locale;
};

export type AppliedDiscount = {
  readonly discount: Discount;
  readonly subtotalBefore: Money;
  readonly amount: Money;
  readonly subtotalAfter: Money;
};

export type DiscountQuote = {
  readonly product: WorkspaceProductIdentity;
  readonly discountableSubtotal: Money;
  readonly discounts: readonly AppliedDiscount[];
  readonly totalDiscount: Money;
  readonly discountedSubtotal: Money;
};

export const discountAdvertisementQuoteCodec = discountQuoteCodec
  .pipe(Schema.brand("DiscountAdvertisementQuote"))
  .annotate({
    identifier: "DiscountAdvertisementQuote",
    description:
      "A discount quote produced only by anonymous advertisement discovery or affirmation.",
  });

export type DiscountAdvertisementQuote =
  typeof discountAdvertisementQuoteCodec.Type;

export const affirmedDiscountAdvertisementQuoteCodec =
  discountAdvertisementQuoteCodec
    .pipe(Schema.brand("AffirmedDiscountAdvertisementQuote"))
    .annotate({
      identifier: "AffirmedDiscountAdvertisementQuote",
      description:
        "An anonymous advertisement quote freshly affirmed at reservation submission.",
    });

export type AffirmedDiscountAdvertisementQuote =
  typeof affirmedDiscountAdvertisementQuoteCodec.Type;

export type DiscountAdvertisementInput = {
  readonly product: WorkspaceProductIdentity;
  readonly discountableSubtotal: Money;
  /**
   * Last date the reservation uses the workspace. Calendar sales apply only
   * when it is on or before the sale's last day.
   */
  readonly lastServiceDate: string;
  /**
   * Prague date the reservation starts. Discount-code service-date windows
   * are judged on it; later days of the reservation never count.
   */
  readonly firstServiceDate: string;
  /** Moment the booking is made; calendar sales are evaluated at it. */
  readonly bookedAt: Temporal.Instant;
  readonly locale: Locale;
};

export type DiscountQuoteInput = {
  readonly product: WorkspaceProductIdentity;
  readonly discountableSubtotal: Money;
  /**
   * Last date the reservation uses the workspace. Calendar sales apply only
   * when it is on or before the sale's last day.
   */
  readonly lastServiceDate: string;
  /**
   * Prague date the reservation starts. Discount-code service-date windows
   * are judged on it; later days of the reservation never count.
   */
  readonly firstServiceDate: string;
  /** Moment the booking is made; calendar sales are evaluated at it. */
  readonly bookedAt: Temporal.Instant;
  readonly locale: Locale;
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly submittedCode?: CanonicalPromotionCode;
  /** Referral code the checkout carries for an unattributed customer. */
  readonly referralCode?: CanonicalPromotionCode;
};
