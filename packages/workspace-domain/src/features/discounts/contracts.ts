import { Schema } from "effect";
import {
  nonNegativeMoneyCodec,
  positiveMoneyCodec,
} from "../../shared/money/money";
import { instantStringSchema } from "../../shared/utils/temporal";
import { workspaceProductIdentitySchema } from "../checkout/product-identity";

export const discountIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("DiscountId")
).annotate({
  identifier: "DiscountId",
  description: "Deterministic opaque public discount identifier.",
});

export type DiscountId = Schema.Schema.Type<typeof discountIdSchema>;

export const canonicalPromotionCodeSchema = Schema.String.check(
  Schema.isPattern(/^[A-Z0-9][A-Z0-9_-]{2,63}$/)
)
  .pipe(Schema.brand("CanonicalPromotionCode"))
  .annotate({
    identifier: "CanonicalPromotionCode",
    description:
      "Canonical ASCII-uppercase promotion code accepted by Workspace checkout.",
  });

export type CanonicalPromotionCode = Schema.Schema.Type<
  typeof canonicalPromotionCodeSchema
>;

export const discountBasisPointsSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10_000 })
).annotate({
  identifier: "DiscountBasisPoints",
  description: "An exact percentage discount measured in basis points.",
});

export const discountAdjustmentSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("percentage"),
    basisPoints: discountBasisPointsSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("fixed"),
    amount: positiveMoneyCodec,
  }),
]).annotate({
  identifier: "DiscountAdjustment",
  description: "A valid percentage or fixed-money discount adjustment.",
});

export const discountCodec = Schema.Struct({
  id: discountIdSchema,
  label: Schema.NonEmptyString,
  staffLabel: Schema.optionalKey(Schema.NonEmptyString),
  adjustment: discountAdjustmentSchema,
  expiresAt: Schema.optionalKey(Schema.toEncoded(instantStringSchema)),
  countdownStartsAt: Schema.optionalKey(Schema.toEncoded(instantStringSchema)),
}).annotate({
  identifier: "Discount",
  description: "A source-neutral discount exposed to checkout consumers.",
});

export const appliedDiscountCodec = Schema.Struct({
  discount: discountCodec,
  subtotalBefore: nonNegativeMoneyCodec,
  amount: positiveMoneyCodec,
  subtotalAfter: nonNegativeMoneyCodec,
}).annotate({
  identifier: "AppliedDiscount",
  description:
    "An immutable discount application and its before, applied, and after amounts.",
});

export const discountQuoteCodec = Schema.Struct({
  product: workspaceProductIdentitySchema,
  discountableSubtotal: nonNegativeMoneyCodec,
  discounts: Schema.Array(appliedDiscountCodec),
  totalDiscount: nonNegativeMoneyCodec,
  discountedSubtotal: nonNegativeMoneyCodec,
}).annotate({
  identifier: "DiscountQuote",
  description: "A source-neutral discount calculation for one product.",
});
