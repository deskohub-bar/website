import { type Locale, m } from "@/features/i18n";
import {
  unlimitedPassCoffeePrice,
  unlimitedPassOffers,
} from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { getUnlimitedPassPurchasePath } from "@/features/passes/unlimited-pass-discovery";
import { GuardedLink as Link } from "@/shared/components/guarded-link";
import { Button } from "@/shared/components/ui/button";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney, moneyMajorAmount } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";

export function UnlimitedPassPrices({ locale }: { readonly locale: Locale }) {
  return (
    <section
      aria-labelledby="pricing-unlimited-title"
      className="mt-14"
      id="pricing-unlimited"
    >
      <h2 id="pricing-unlimited-title" className="text-2xl sm:text-3xl">
        {m.passUnlimited({}, { locale })}
      </h2>
      <p className="mt-3 text-base leading-7 text-white/76">
        {m.unlimitedPassDiscoveryIntro({}, { locale })}
      </p>
      <ul className="mt-5 divide-y divide-white/14 border-y border-white/14">
        {unlimitedPassOffers.map(
          ({ product: { tier }, price, validityDays }) => {
            const name = getPassTierName(tier, locale);
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
                    {
                      {
                        "open-space":
                          m.unlimitedPassDiscoveryOpenSpaceDescription(
                            {
                              until:
                                workspaceSiteConstants.openingHours
                                  .openSpaceUsableUntil,
                            },
                            { locale }
                          ),
                        "reserved-desk":
                          m.unlimitedPassDiscoveryReservedDeskDescription(
                            {},
                            { locale }
                          ),
                        "reserved-desk-workstation":
                          m.unlimitedPassDiscoveryWorkstationDescription(
                            {},
                            { locale }
                          ),
                      }[tier]
                    }
                  </p>
                  {tier === "open-space" && (
                    <p className="mt-3 text-base leading-7 text-white/86">
                      {m.unlimitedPassDiscoveryCoffee(
                        {
                          price: formatMoney(unlimitedPassCoffeePrice, locale),
                        },
                        { locale }
                      )}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-start sm:items-end sm:text-right">
                  <p className="text-2xl font-semibold text-sunset-yellow">
                    {m.unlimitedPassDiscoveryPrice(
                      { price: formatMoney(price, locale), days: validityDays },
                      { locale }
                    )}
                  </p>
                  <p className="text-sm leading-6 text-white/76">
                    {m.unlimitedPassDiscoveryPerDay(
                      {
                        price: formatMoney(
                          currencyCZK(
                            Math.round(moneyMajorAmount(price) / validityDays) *
                              100
                          ),
                          locale
                        ),
                      },
                      { locale }
                    )}
                  </p>
                  <Button asChild size="md" caps className="mt-3">
                    <Link
                      aria-label={m.unlimitedPassDiscoveryBuyTier(
                        { tier: name },
                        { locale }
                      )}
                      href={getUnlimitedPassPurchasePath(locale, tier)}
                    >
                      {m.entryPackDiscoveryBuy({}, { locale })}
                    </Link>
                  </Button>
                </div>
              </li>
            );
          }
        )}
      </ul>
    </section>
  );
}
