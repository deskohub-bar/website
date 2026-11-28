import type {
  CustomerMonitorOption,
  CustomerPassCatalog,
  CustomerPassTier,
  CustomerUnlimitedStartDates,
  Money,
} from "@deskohub/workspace-customer-api";
import Interpolate from "@doist/react-interpolate";
import { StyleSheet, View } from "react-native";
import { tierArtwork } from "../../../booking/family/cowork-tier-cards";
import { openSpaceClosingTime } from "../../../booking/selection/cowork-selection";
import { BookingSectionHeading } from "../../../booking/ui/booking-section-heading";
import { formatPragueTime } from "../../../booking/ui/prague-date-format";
import type { AppLocale } from "../../../i18n/app-locale";
import { m } from "../../../i18n/messages";
import { formatMoney } from "../../../i18n/money-format";
import { Text } from "../../../ui/text";
import { color, radius, space } from "../../../ui/tokens";
import { ChooseCards } from "./choose-cards";
import { EntryPackChoices, entryPricePerDay } from "./entry-pack-choices";
import { availableStarts, UnlimitedChoices } from "./unlimited-choices";

export type PassChooseSelection = {
  tier: CustomerPassTier;
  size: 5 | 10;
  startDate?: string;
  coffee: boolean;
  monitorOption?: CustomerMonitorOption;
};

type PassChooseProps = {
  readonly kind: "entry-pack" | "unlimited";
  readonly catalog: CustomerPassCatalog;
  readonly dates?: CustomerUnlimitedStartDates;
  readonly datesFailed?: boolean;
  readonly selection: PassChooseSelection;
  readonly onChange: (patch: Partial<PassChooseSelection>) => void;
  readonly locale: AppLocale;
};

const tierNames = {
  "open-space": m.pass_choose_open_space,
  "reserved-desk": m.pass_choose_reserved_desk,
  "reserved-desk-workstation": m.pass_choose_workstation,
} satisfies Record<CustomerPassTier, unknown>;

export const passTierName = (tier: CustomerPassTier, locale: AppLocale) =>
  tierNames[tier]({}, { locale });

const tiers: readonly CustomerPassTier[] = [
  "open-space",
  "reserved-desk",
  "reserved-desk-workstation",
];

const bookingTier = (tier: CustomerPassTier) =>
  tier === "open-space" ? "open-space" : "reserved-desk";

export function PassChoose({
  kind,
  catalog,
  dates,
  datesFailed = false,
  selection,
  onChange,
  locale,
}: PassChooseProps) {
  const label = m.booking_cowork_tier_heading({}, { locale });
  const entryPack = kind === "entry-pack";
  const tierOptions = tiers.flatMap((tier) => {
    const unlimited = catalog.unlimited.find(
      (offer) => offer.product.tier === tier
    );
    const perDay = catalog.entryPacks
      .filter((offer) => offer.product.tier === tier)
      .map(entryPricePerDay);
    const price = entryPack
      ? perDay.reduce<Money | undefined>(
          (lowest, next) =>
            lowest === undefined || next.value < lowest.value ? next : lowest,
          undefined
        )
      : unlimited?.price;
    if (price === undefined) return [];

    const description = {
      "open-space": m.pass_choose_open_space_description(
        { until: formatPragueTime(openSpaceClosingTime, locale) },
        { locale }
      ),
      "reserved-desk": m.pass_choose_reserved_desk_description({}, { locale }),
      "reserved-desk-workstation": m.pass_choose_workstation_description(
        {},
        { locale }
      ),
    }[tier];
    const amount = (
      <Text key={tier} variant="dialogTitle" tone="positive" numeric>
        {formatMoney(price, locale)}
      </Text>
    );
    return [
      {
        value: tier,
        label: passTierName(tier, locale),
        artwork: tierArtwork(
          bookingTier(tier),
          tier === "reserved-desk-workstation"
        ),
        content: (
          <>
            <View style={styles.pricePanel}>
              <Text variant="hint" tone="muted">
                {entryPack ? (
                  <Interpolate
                    string={m.pass_choose_from_per_day(
                      { price: "<price/>" },
                      { locale }
                    )}
                    mapping={{ price: amount }}
                  />
                ) : (
                  <>
                    {amount}
                    {unlimited &&
                      ` ${m.pass_choose_price_period({ days: unlimited.validityDays }, { locale })}`}
                  </>
                )}
              </Text>
            </View>
            <Text
              variant="bodySmall"
              tone="muted"
              style={styles.tierDescription}
            >
              <Text style={styles.descriptionHighlight}>{description}</Text>
            </Text>
          </>
        ),
      },
    ];
  });

  const selectTier = (tier: CustomerPassTier) => {
    if (entryPack) {
      const offers = catalog.entryPacks.filter(
        (offer) => offer.product.tier === tier
      );
      const size =
        offers.find((offer) => offer.product.size === selection.size)?.product
          .size ?? offers[0]?.product.size;
      onChange({ tier, size: size ?? selection.size });
      return;
    }
    const startDate = selection.startDate;
    const unavailable =
      dates &&
      startDate &&
      (startDate < dates.today ||
        (startDate <= dates.lastStartDate &&
          !availableStarts(dates, tier).has(startDate)));
    onChange({
      tier,
      startDate: unavailable ? undefined : startDate,
      monitorOption: undefined,
      coffee: tier === "open-space" && selection.coffee,
    });
  };

  return (
    <>
      <BookingSectionHeading title={label} first />
      <ChooseCards
        label={label}
        options={tierOptions}
        selected={selection.tier}
        onSelect={selectTier}
      />
      {entryPack ? (
        <EntryPackChoices
          tierName={passTierName(selection.tier, locale)}
          catalog={catalog}
          selection={selection}
          onChange={onChange}
          locale={locale}
        />
      ) : (
        <UnlimitedChoices
          catalog={catalog}
          dates={dates}
          datesFailed={datesFailed}
          selection={selection}
          onChange={onChange}
          locale={locale}
        />
      )}
    </>
  );
}

export type PassOptionProps = Pick<
  PassChooseProps,
  "catalog" | "selection" | "onChange" | "locale"
>;

const styles = StyleSheet.create({
  pricePanel: {
    alignSelf: "flex-start",
    backgroundColor: color.surface,
    borderRadius: radius.tile,
    maxWidth: "100%",
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  tierDescription: { alignSelf: "flex-start", maxWidth: "62%" },
  descriptionHighlight: { backgroundColor: color.surface },
});
