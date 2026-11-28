import { type Locale, m } from "@/features/i18n";
import { getReservationStartPath } from "@/features/reservation/routes";
import { GuardedLink as Link } from "@/shared/components/guarded-link";
import { Button } from "@/shared/components/ui/button";
import {
  getTeamTablePriceCopy,
  type TeamTablePrice,
} from "../team-table-price";
import { TeamTableOffersStructuredData } from "./team-table-offers-structured-data";

export function TeamTablePrices({
  locale,
  prices,
}: {
  readonly locale: Locale;
  readonly prices: ReadonlyArray<TeamTablePrice>;
}) {
  if (prices.length === 0) return null;

  return (
    <section aria-labelledby="pricing-team-table-title" className="mt-14">
      <h2 id="pricing-team-table-title" className="text-2xl sm:text-3xl">
        {m.reservationTableProductTitle({}, { locale })}
      </h2>
      <ul className="mt-5 divide-y divide-white/14 border-y border-white/14">
        {prices.map((price) => {
          const { rates, sale } = getTeamTablePriceCopy(price, locale);
          return (
            <li key={price.seats} className="py-6">
              <p className="text-xl font-semibold text-sunset-yellow">
                {rates}
              </p>
              {sale && (
                <p className="mt-2 text-sm leading-6 text-white/86">{sale}</p>
              )}
            </li>
          );
        })}
      </ul>
      <Button asChild size="md" caps className="mt-5">
        <Link href={getReservationStartPath(locale, "table")}>
          {m.landingOfferingTeamTableBookingLink({}, { locale })}
        </Link>
      </Button>
      <TeamTableOffersStructuredData locale={locale} prices={prices} />
    </section>
  );
}
