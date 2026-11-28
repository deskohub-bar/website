import type {
  CustomerBookingOfferings,
  CustomerPassCatalog,
  CustomerPassTier,
  Money,
} from "@deskohub/workspace-customer-api";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { StyleSheet, View } from "react-native";
import { bookingOfferingsAtom } from "../../../booking/data/booking-queries";
import {
  addDays,
  addMonths,
  pragueToday,
} from "../../../booking/selection/prague-date";
import { BookingSectionHeading } from "../../../booking/ui/booking-section-heading";
import { formatPragueDate } from "../../../booking/ui/prague-date-format";
import { m } from "../../../i18n/messages";
import { formatMoney } from "../../../i18n/money-format";
import { Badge } from "../../../ui/badge";
import { Text } from "../../../ui/text";
import { space } from "../../../ui/tokens";
import { ChooseCards, ChooseNote } from "./choose-cards";
import type { PassOptionProps } from "./pass-choose";

export const entryPricePerDay = ({
  price,
  product,
}: CustomerPassCatalog["entryPacks"][number]) => ({
  ...price,
  value: Math.round(price.value / product.size),
});

function regularDayPrice(
  bookingOfferings: CustomerBookingOfferings | undefined,
  tier: CustomerPassTier
): Money | undefined {
  const offer = bookingOfferings?.offerings.find(
    (offering) =>
      offering.family === "cowork" &&
      offering.tier === (tier === "open-space" ? tier : "reserved-desk")
  );
  if (offer?.family !== "cowork") return undefined;
  if (tier !== "reserved-desk-workstation") return offer.price;

  const workstation = offer.addOns.find(({ id }) => id === "workstation");
  if (
    !workstation ||
    workstation.price.currency !== offer.price.currency ||
    workstation.price.exponent !== offer.price.exponent
  )
    return undefined;

  return { ...offer.price, value: offer.price.value + workstation.price.value };
}

export function EntryPackChoices({
  catalog,
  selection,
  onChange,
  locale,
  tierName,
}: PassOptionProps & { readonly tierName: string }) {
  const bookingOfferings = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(bookingOfferingsAtom(locale)))
  );
  const today = pragueToday(new Date());
  const { tier, size } = selection;
  const regularPrice = regularDayPrice(bookingOfferings, tier);
  const label = m.pass_choose_pack_size({ tier: tierName }, { locale });
  const options = catalog.entryPacks
    .filter((offer) => offer.product.tier === tier)
    .sort((first, second) => first.product.size - second.product.size)
    .map((offer) => {
      const dayPrice = entryPricePerDay(offer);
      const saving =
        regularPrice?.currency === dayPrice.currency &&
        regularPrice.exponent === dayPrice.exponent
          ? regularPrice.value - dayPrice.value
          : 0;
      const date = addDays(addMonths(today, offer.validityMonths), -1);
      return {
        value: offer.product.size,
        label: m.pass_choose_entries({ count: offer.product.size }, { locale }),
        content: (
          <>
            <Text variant="title" numeric>
              {formatMoney(offer.price, locale)}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {m.pass_choose_validity(
                {
                  months: offer.validityMonths,
                  date: formatPragueDate(date, locale, { dateStyle: "medium" }),
                },
                { locale }
              )}
            </Text>
            <Text variant="subhead">
              {m.pass_choose_per_day(
                { price: formatMoney(dayPrice, locale) },
                { locale }
              )}
            </Text>
            {saving > 0 && (
              <View style={styles.saving}>
                <Badge
                  tone="positive"
                  label={m.pass_choose_saving(
                    {
                      price: formatMoney(
                        { ...dayPrice, value: saving },
                        locale
                      ),
                    },
                    { locale }
                  )}
                />
              </View>
            )}
          </>
        ),
      };
    });

  if (options.length === 0) return null;
  return (
    <>
      <BookingSectionHeading title={label} />
      <ChooseCards
        label={label}
        options={options}
        selected={size}
        onSelect={(size) => onChange({ size })}
      />
      <ChooseNote>{m.pass_choose_entry_note({}, { locale })}</ChooseNote>
    </>
  );
}

const styles = StyleSheet.create({ saving: { marginTop: space.sm } });
