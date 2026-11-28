import { Schema } from "effect";
import {
  canonicalPromotionCodeSchema,
  discountIdSchema,
  discountQuoteCodec,
} from "../discounts/contracts";

export const passQuoteSelectionSchema = Schema.Struct({
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
