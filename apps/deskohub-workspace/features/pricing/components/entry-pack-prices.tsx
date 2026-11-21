import { type Locale, m } from "@/features/i18n";
import {
  getEntryPackPricePerDay,
  getEntryPackPurchasePath,
} from "@/features/passes/entry-pack-discovery";
import { entryPackOffers, passTiers } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { GuardedLink as Link } from "@/shared/components/guarded-link";
import { Button } from "@/shared/components/ui/button";
import { formatMoney } from "@/shared/money/money";

const tierDescriptions = {
  "open-space": m.entryPackDiscoveryOpenSpaceDescription,
  "reserved-desk": m.entryPackDiscoveryReservedDeskDescription,
  "reserved-desk-workstation": m.entryPackDiscoveryWorkstationDescription,
};

export function EntryPackPrices({ locale }: { readonly locale: Locale }) {
  return (
    <section
      aria-labelledby="pricing-entry-packs-title"
      className="mt-14"
      id="pricing-entry-packs"
    >
      <h2 id="pricing-entry-packs-title" className="text-2xl sm:text-3xl">
        {m.entryPackDiscoveryTitle({}, { locale })}
      </h2>
      <p className="mt-3 text-base leading-7 text-white/76">
        {m.entryPackDiscoveryIntro({}, { locale })}
      </p>
      <ul className="mt-5 divide-y divide-white/14 border-y border-white/14">
        {passTiers.map((tier) => {
          const name = getPassTierName(tier, locale);
          const offers = entryPackOffers.filter(
            ({ product }) => product.tier === tier
          );
          return (
            <li
              key={tier}
              className="grid gap-4 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-8"
            >
              <div className="min-w-0">
                <h3 className="text-xl font-semibold first-letter:uppercase">
                  {name}
                </h3>
                <p className="mt-2 text-base leading-7 text-white/76">
                  {tierDescriptions[tier]({}, { locale })}
                </p>
                <ul className="mt-3 grid gap-1 text-base leading-7 text-white/86">
                  {offers.map(({ product, validityMonths }) => (
                    <li key={product.size}>
                      {m.entryPackDiscoveryValidity(
                        { entries: product.size, months: validityMonths },
                        { locale }
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col items-start gap-3 sm:items-end sm:text-right">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:gap-x-8">
                  {offers.map((offer) => (
                    <div key={offer.product.size} className="min-w-0">
                      <dt className="text-sm leading-6 text-white/76">
                        {m.passEntryCount(
                          { count: offer.product.size },
                          { locale }
                        )}
                      </dt>
                      <dd className="text-2xl font-semibold text-sunset-yellow">
                        {formatMoney(offer.price, locale)}
                      </dd>
                      <dd className="text-sm leading-6 text-white/76">
                        {m.entryPackDiscoveryPerDay(
                          {
                            price: formatMoney(
                              getEntryPackPricePerDay(offer),
                              locale
                            ),
                          },
                          { locale }
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                <Button asChild size="md" caps>
                  <Link
                    aria-label={m.entryPackDiscoveryBuyTier(
                      { tier: name },
                      { locale }
                    )}
                    href={getEntryPackPurchasePath(locale, tier)}
                  >
                    {m.entryPackDiscoveryBuy({}, { locale })}
                  </Link>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
