import { Effect } from "effect";
import type { CanonicalPromotionCode } from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import type { Locale } from "@/features/i18n";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import {
  type EntryPackProduct,
  getEntryPackPrice,
  getEntryPackValidity,
} from "../pass-offer";

export const quoteEntryPack = Effect.fn("quoteEntryPack")(function* (input: {
  readonly product: EntryPackProduct;
  readonly buyer: DotyposCustomerId;
  readonly purchasedAt: Temporal.Instant;
  readonly locale: Locale;
  readonly submittedCode?: CanonicalPromotionCode;
  readonly referralCode?: CanonicalPromotionCode;
}) {
  const { validFrom, validUntil } = getEntryPackValidity(
    input.purchasedAt,
    input.product.size
  );
  const discounts = yield* DiscountService;
  const quote = yield* discounts.quote({
    product: input.product,
    discountableSubtotal: getEntryPackPrice(input.product),
    firstServiceDate: validFrom,
    lastServiceDate: validFrom,
    bookedAt: input.purchasedAt,
    locale: input.locale,
    dotyposCustomerId: input.buyer,
    ...(input.submittedCode !== undefined && {
      submittedCode: input.submittedCode,
    }),
    ...(input.referralCode !== undefined && {
      referralCode: input.referralCode,
    }),
  });
  return { quote, validFrom, validUntil };
});
