import { getWorkspacePageUrl, type Locale, m } from "@/features/i18n";
import { tableReservationPath } from "@/features/reservation/routes";
import { StructuredData } from "@/shared/components/structured-data";
import { type Money, moneyMajorAmount } from "@/shared/money/money";
import {
  getStructuredDataDocument,
  workspaceBusinessId,
} from "@/shared/utils/structured-data";
import {
  getTeamTablePriceCopy,
  type TeamTablePrice,
} from "../team-table-price";

const money = (amount: Money) => ({
  price: moneyMajorAmount(amount),
  priceCurrency: amount.currency,
});

export function TeamTableOffersStructuredData({
  locale,
  prices,
}: {
  readonly locale: Locale;
  readonly prices: ReadonlyArray<TeamTablePrice>;
}) {
  if (prices.length === 0) return null;

  return (
    <StructuredData
      data={getStructuredDataDocument({
        "@type": "Service",
        name: m.reservationTableProductTitle({}, { locale }),
        description: m.landingOfferingTeamTableText({}, { locale }),
        provider: { "@id": workspaceBusinessId },
        offers: prices.map((price) => {
          const sale = price.advertisedPrice?.discount.value
            ? price.advertisedPrice
            : undefined;
          return {
            "@type": "Offer",
            url: getWorkspacePageUrl(tableReservationPath),
            description: getTeamTablePriceCopy(price, locale).rates,
            price: sale && moneyMajorAmount(sale.price),
            priceCurrency: sale?.price.currency,
            priceValidUntil: sale?.saleLastDay,
            priceSpecification: [
              { "@type": "UnitPriceSpecification", ...money(price.base) },
              {
                "@type": "UnitPriceSpecification",
                ...money(price.hourly),
                unitCode: "HUR",
              },
            ],
          };
        }),
      })}
    />
  );
}
