import type { CustomerTeamTableOfferings } from "@deskohub/workspace-customer-api";
import type { AppLocale } from "../../i18n/app-locale";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";

type TeamTableOffering = CustomerTeamTableOfferings["offerings"][number];

export const teamTableCapacities = (
  offerings: CustomerTeamTableOfferings["offerings"]
): ReadonlyArray<TeamTableOffering> => {
  const bySeats = new Map<number, TeamTableOffering>();
  for (const offering of offerings) {
    bySeats.set(offering.product.seats, offering);
  }
  return [...bySeats.values()].sort(
    (first, second) => first.product.seats - second.product.seats
  );
};

export const teamTableCapacityLabel = (seats: number, locale: AppLocale) =>
  m.booking_team_table_for_seats({ seats }, { locale });

export const teamTableRateLabel = (
  { price }: TeamTableOffering,
  locale: AppLocale
) => {
  // The one-hour regular price includes CZK 60/seat base and CZK 20/seat usage.
  const hourly = Math.round(price.value / 4);
  return m.booking_team_table_rate(
    {
      base: formatMoney({ ...price, value: price.value - hourly }, locale),
      hourly: formatMoney({ ...price, value: hourly }, locale),
    },
    { locale }
  );
};
