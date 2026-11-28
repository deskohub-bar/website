import type {
  CustomerPassCatalog,
  CustomerPassTier,
} from "@deskohub/workspace-customer-api";
import type { PragueDate } from "../booking/selection/prague-date";
import { formatPragueDate } from "../booking/ui/prague-date-format";
import type { AppLocale } from "../i18n/app-locale";
import { m } from "../i18n/messages";
import { formatMoney } from "../i18n/money-format";

export const passTierName = (tier: CustomerPassTier, locale: AppLocale) =>
  ({
    "open-space": m.passes_open_space,
    "reserved-desk": m.passes_reserved_desk,
    "reserved-desk-workstation": m.passes_reserved_workstation,
  })[tier]({}, { locale });

export const passDate = (date: PragueDate, locale: AppLocale, year = true) =>
  formatPragueDate(date, locale, {
    day: "numeric",
    month: "short",
    ...(year && { year: "numeric" }),
  });

export const passPeriod = (
  start: PragueDate,
  end: PragueDate,
  locale: AppLocale
) =>
  m.passes_date_range(
    {
      start: passDate(start, locale, start.slice(0, 4) !== end.slice(0, 4)),
      end: passDate(end, locale),
    },
    { locale }
  );

export const cheapestPackDay = (
  catalog: CustomerPassCatalog,
  locale: AppLocale
) => {
  const price = catalog.entryPacks
    .map(({ product, price }) => ({
      ...price,
      value: Math.round(price.value / product.size),
    }))
    .sort((first, second) => first.value - second.value)[0];
  return price === undefined ? undefined : formatMoney(price, locale);
};
