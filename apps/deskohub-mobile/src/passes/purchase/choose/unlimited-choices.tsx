import type {
  CustomerMonitorOption,
  CustomerPassTier,
  CustomerUnlimitedStartDates,
  Money,
} from "@deskohub/workspace-customer-api";
import Coffee from "lucide-react-native/icons/coffee";
import { StyleSheet, View } from "react-native";
import { addDays } from "../../../booking/selection/prague-date";
import { AddonToggle } from "../../../booking/ui/addon-toggle";
import { BookingSectionHeading } from "../../../booking/ui/booking-section-heading";
import { MonthCalendar } from "../../../booking/ui/month-calendar";
import type { AppLocale } from "../../../i18n/app-locale";
import { m } from "../../../i18n/messages";
import { formatMoney } from "../../../i18n/money-format";
import { LoadingIndicator } from "../../../ui/loading-indicator";
import { Notice } from "../../../ui/notice";
import { Text } from "../../../ui/text";
import { space } from "../../../ui/tokens";
import { ChooseCards, ChooseNote } from "./choose-cards";
import type { PassOptionProps } from "./pass-choose";

const monitorSetups = {
  "2x27-qhd": {
    label: "2× 27″ QHD",
    description: m.pass_choose_monitor_27_qhd,
  },
  "2x32-qhd": {
    label: "2× 32″ QHD",
    description: m.pass_choose_monitor_32_qhd,
  },
  "2x27-4k": { label: "2× 27″ 4K", description: m.pass_choose_monitor_27_4k },
  "2x32-4k": { label: "2× 32″ 4K", description: m.pass_choose_monitor_32_4k },
} satisfies Record<CustomerMonitorOption, unknown>;

const monitorOptions: readonly CustomerMonitorOption[] = [
  "2x27-qhd",
  "2x32-qhd",
  "2x27-4k",
  "2x32-4k",
];

export const availableStarts = (
  dates: CustomerUnlimitedStartDates,
  tier: CustomerPassTier
): ReadonlySet<string> =>
  new Set(
    tier === "reserved-desk-workstation"
      ? monitorOptions.flatMap((option) => dates.starts[tier][option])
      : dates.starts[tier]
  );

const hasMonitor = (
  dates: CustomerUnlimitedStartDates,
  startDate: string | undefined,
  monitor: CustomerMonitorOption | undefined
) =>
  startDate !== undefined &&
  monitor !== undefined &&
  dates.starts["reserved-desk-workstation"][monitor].includes(startDate);

export function UnlimitedChoices({
  catalog,
  dates,
  datesFailed,
  selection,
  onChange,
  locale,
}: PassOptionProps & {
  readonly dates?: CustomerUnlimitedStartDates;
  readonly datesFailed: boolean;
}) {
  const { tier, startDate, monitorOption } = selection;
  const offer = catalog.unlimited.find((entry) => entry.product.tier === tier);
  if (offer === undefined) return null;

  const days = offer.validityDays;
  const label = m.pass_choose_start_date({}, { locale });
  const starts = dates ? availableStarts(dates, tier) : undefined;
  const selected = startDate && starts?.has(startDate) ? startDate : undefined;
  const selectedMonitor =
    dates && hasMonitor(dates, selected, monitorOption)
      ? monitorOption
      : undefined;
  const unavailable = new Set<string>();
  if (dates && starts) {
    for (
      let day = dates.today;
      day <= dates.lastStartDate;
      day = addDays(day, 1)
    ) {
      if (!starts.has(day)) unavailable.add(day);
    }
  }
  const noStarts = starts?.size === 0;
  const selectDate = (date: string) => {
    if (!starts?.has(date)) return;
    onChange({
      startDate: date,
      monitorOption:
        dates &&
        tier === "reserved-desk-workstation" &&
        hasMonitor(dates, date, monitorOption)
          ? monitorOption
          : undefined,
    });
  };

  return (
    <>
      <BookingSectionHeading title={label} />
      <Notice
        tone="info"
        message={noStarts ? m.pass_choose_no_starts({}, { locale }) : undefined}
      />
      {dates ? (
        <MonthCalendar
          label={label}
          locale={locale}
          dates={{
            earliest: dates.today,
            latest: dates.lastStartDate,
            unavailable,
          }}
          today={dates.today}
          selected={selected}
          onSelect={selectDate}
          range={
            selected
              ? {
                  kind: "coverage",
                  start: selected,
                  end: addDays(selected, days - 1),
                }
              : undefined
          }
          coveredDayLabel={m.pass_choose_calendar_covered({}, { locale })}
          previousMonthLabel={m.booking_calendar_previous_month({}, { locale })}
          nextMonthLabel={m.booking_calendar_next_month({}, { locale })}
          unavailableLabel={m.pass_choose_calendar_unavailable({}, { locale })}
        />
      ) : (
        !datesFailed && (
          <View style={styles.loading}>
            <LoadingIndicator
              size="section"
              tone="navy"
              label={m.booking_availability_loading({}, { locale })}
            />
          </View>
        )
      )}
      {tier === "open-space" && (
        <CoffeeChoice
          days={days}
          price={catalog.unlimitedCoffeePrice}
          checked={selection.coffee}
          onToggle={(coffee) => onChange({ coffee })}
          locale={locale}
        />
      )}
      {tier === "reserved-desk-workstation" && dates && (
        <MonitorChoices
          days={days}
          dates={dates}
          date={selected}
          selected={selectedMonitor}
          onSelect={(monitorOption) => onChange({ monitorOption })}
          locale={locale}
        />
      )}
    </>
  );
}

function MonitorChoices({
  days,
  dates,
  date,
  selected,
  onSelect,
  locale,
}: {
  readonly days: number;
  readonly dates: CustomerUnlimitedStartDates;
  readonly date: string | undefined;
  readonly selected: CustomerMonitorOption | undefined;
  readonly onSelect: (option: CustomerMonitorOption) => void;
  readonly locale: AppLocale;
}) {
  const label = m.pass_choose_monitor_setup({ days }, { locale });
  return (
    <>
      <BookingSectionHeading title={label} />
      <ChooseCards
        label={label}
        selected={selected}
        onSelect={onSelect}
        options={monitorOptions.map((option) => {
          const setup = monitorSetups[option];
          const available = hasMonitor(dates, date, option);
          return {
            value: option,
            label: setup.label,
            disabled: !available,
            content: (
              <Text variant="bodySmall" tone="muted">
                {date && !available
                  ? m.pass_choose_monitor_unavailable({ days }, { locale })
                  : setup.description({}, { locale })}
              </Text>
            ),
          };
        })}
      />
    </>
  );
}

function CoffeeChoice({
  days,
  price,
  checked,
  onToggle,
  locale,
}: {
  readonly days: number;
  readonly price: Money;
  readonly checked: boolean;
  readonly onToggle: (checked: boolean) => void;
  readonly locale: AppLocale;
}) {
  const label = m.pass_choose_coffee({ days }, { locale });
  const addedPrice = m.booking_addon_price(
    { price: formatMoney(price, locale) },
    { locale }
  );
  return (
    <>
      <BookingSectionHeading title={label} />
      <AddonToggle
        label={`${label}, ${addedPrice}`}
        icon={Coffee}
        checked={checked}
        onToggle={onToggle}
        price={addedPrice}
      />
      <ChooseNote icon={Coffee}>
        {m.pass_choose_coffee_note({}, { locale })}
      </ChooseNote>
    </>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", padding: space.xl },
});
