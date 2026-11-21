import { Schema } from "effect";
import {
  canonicalPromotionCodeSchema,
  discountIdSchema,
  discountQuoteCodec,
} from "@/features/discounts/contracts";
import { type Money, moneyWithValue } from "@/shared/money/money";
import { unlimitedPassCoffeePrice } from "./pass-offer";

const passQuoteSelectionSchema = Schema.Struct({
  submittedCode: Schema.optionalKey(canonicalPromotionCodeSchema),
  referralCode: Schema.optionalKey(canonicalPromotionCodeSchema),
});

/** The buyer's private pricing inputs and the applied code's discount ID. */
export const passPurchaseQuoteCodec = Schema.Struct({
  ...discountQuoteCodec.fields,
  selection: Schema.optionalKey(passQuoteSelectionSchema),
  submittedCodeDiscountId: Schema.optionalKey(discountIdSchema),
  unlimitedCoffee: Schema.optionalKey(Schema.Literal(true)),
});

export type PassPurchaseQuote = typeof passPurchaseQuoteCodec.Type;

/** Coffee is a separate add-on and does not contribute to the discountable base. */
export function withPassPurchaseAddons(
  base: Money,
  unlimitedCoffee?: boolean | null
): Money {
  return unlimitedCoffee
    ? moneyWithValue(base.value + unlimitedPassCoffeePrice.value, base)
    : base;
}
