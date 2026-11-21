import type { Locale } from "@/features/i18n";
import { currencyCZK } from "@/shared/money/currencies";
import { moneyShareRoundedUp } from "@/shared/money/money";
import { entryPackOffers, type PassTier } from "./pass-offer";

export const getEntryPackPurchasePath = (locale: Locale, tier: PassTier) =>
  `/${locale}/passes/entry-pack?tier=${tier}`;

export const getEntryPackPricePerDay = ({
  price,
  product,
}: (typeof entryPackOffers)[number]) =>
  moneyShareRoundedUp(price, 1, product.size);

export const minimumEntryPackPricePerDay = currencyCZK(
  Math.min(
    ...entryPackOffers.map((offer) => getEntryPackPricePerDay(offer).value)
  )
);
