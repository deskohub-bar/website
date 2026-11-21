import { Ticket } from "lucide-react";
import {
  getWorkspaceProductByTier,
  workspaceProductWorkstationAddonPrice,
} from "@/features/checkout/product-catalog";
import { type Locale, m } from "@/features/i18n";
import { ReservationFormCard } from "@/features/reservation/components/reservation-form-card";
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import {
  type EntryPackProduct,
  type EntryPackSize,
  entryPackOffers,
} from "../pass-offer";

import { formatPassDate, getPassTierName } from "../pass-offer.i18n";
import { PassCheckoutContinue } from "./pass-checkout-continue";
import { PassTierInput } from "./pass-tier-input";

export function EntryPackChoose({
  locale,
  product,
  validity,
  onChange,
  onContinue,
}: {
  readonly locale: Locale;
  readonly product: EntryPackProduct;
  readonly validity: Partial<Record<EntryPackSize, string>>;
  readonly onChange: (product: EntryPackProduct) => void;
  readonly onContinue: () => void;
}) {
  const { tier, size } = product;
  const singleDayPrice =
    getWorkspaceProductByTier(tier === "open-space" ? tier : "reserved-desk")
      .price.value +
    (tier === "reserved-desk-workstation"
      ? workspaceProductWorkstationAddonPrice.value
      : 0);
  return (
    <ReservationFormCard>
      <form
        className="space-y-7"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <PassTierInput
          locale={locale}
          tier={tier}
          onChange={(next) => onChange({ ...product, tier: next })}
          priceForTier={(option) => {
            const price = currencyCZK(
              Math.min(
                ...entryPackOffers
                  .filter((offer) => offer.product.tier === option)
                  .map((offer) => offer.price.value / offer.product.size)
              )
            );
            return m.entryPackCheckoutFromPerDay(
              { price: formatMoney(price, locale) },
              { locale }
            );
          }}
        />
        <fieldset>
          <legend className="mb-1 font-semibold text-sm uppercase tracking-widest text-navy-blue/75">
            {m.entryPackCheckoutSize(
              { tier: getPassTierName(tier, locale) },
              { locale }
            )}
          </legend>
          <ReservationTypeInput
            className="lg:grid-cols-2"
            idPrefix="entry-pack-size"
            value={String(size)}
            onChange={(next) =>
              onChange({ ...product, size: next === "5" ? 5 : 10 })
            }
          >
            {entryPackOffers
              .filter((offer) => offer.product.tier === tier)
              .map((offer) => {
                const count = offer.product.size;
                const dayPrice = offer.price.value / count;
                const date = validity[count];
                return (
                  <ReservationTypeOption
                    key={count}
                    value={String(count)}
                    title={m.passEntryCount({ count }, { locale })}
                    price={formatMoney(offer.price, locale)}
                  >
                    <span className="block text-sm leading-6 text-navy-blue/75">
                      {date
                        ? m.entryPackCheckoutValidity(
                            {
                              months: offer.validityMonths,
                              date: formatPassDate(date, locale),
                            },
                            { locale }
                          )
                        : m.entryPackCheckoutValidityMonths(
                            { months: offer.validityMonths },
                            { locale }
                          )}
                    </span>
                    <span className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-semibold">
                      {m.entryPackCheckoutPerDay(
                        { price: formatMoney(currencyCZK(dayPrice), locale) },
                        { locale }
                      )}
                      <span className="rounded-full bg-aquamarine-green/20 px-2.5 text-xs leading-5 text-aquamarine-ink">
                        {m.entryPackCheckoutSaving(
                          {
                            price: formatMoney(
                              currencyCZK(singleDayPrice - dayPrice),
                              locale
                            ),
                          },
                          { locale }
                        )}
                      </span>
                    </span>
                  </ReservationTypeOption>
                );
              })}
          </ReservationTypeInput>
        </fieldset>
        <p className="flex items-start gap-2 text-sm leading-6 text-navy-blue/75">
          <Ticket
            aria-hidden="true"
            className="mt-1 shrink-0 text-burned-orange"
            size={16}
          />
          {m.entryPackCheckoutUseNote({}, { locale })}
        </p>
        <PassCheckoutContinue locale={locale} />
      </form>
    </ReservationFormCard>
  );
}
