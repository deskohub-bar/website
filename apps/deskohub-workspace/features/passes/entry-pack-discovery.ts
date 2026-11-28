import type { Locale } from "@/features/i18n";
import { moneyShareRoundedUp } from "@/shared/money/money";
import type { entryPackOffers, PassTier } from "./pass-offer";

export const getEntryPackPurchasePath = (locale: Locale, tier: PassTier) =>
  `/${locale}/passes/entry-pack?tier=${tier}`;

export const getEntryPackPricePerDay = ({
  price,
  product,
}: (typeof entryPackOffers)[number]) =>
  moneyShareRoundedUp(price, 1, product.size);
