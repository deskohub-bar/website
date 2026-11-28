import type { PublicOfferingAdvertisedPrice } from "@/features/checkout/public-offerings";
import { type Locale, m } from "@/features/i18n";
import { formatMoney, type Money } from "@/shared/money/money";
import { getOfferingSale } from "./offering-sale";

export type TeamTablePrice = {
  readonly seats: number;
  readonly base: Money;
  readonly hourly: Money;
  readonly advertisedPrice?: PublicOfferingAdvertisedPrice;
};

export const getTeamTablePriceCopy = (
  price: TeamTablePrice,
  locale: Locale
) => {
  const sale = getOfferingSale(price, locale);
  return {
    rates: m.pricingTeamTableRates(
      {
        seats: price.seats,
        base: formatMoney(price.base, locale),
        hourly: formatMoney(price.hourly, locale),
      },
      { locale }
    ),
    sale: sale && m.pricingTeamTableSale(sale, { locale }),
  };
};
