import type { Locale } from "@/features/i18n";
import { markdownList, markdownListItem } from "@/shared/markdown/markdown";
import { getTeamTablePriceCopy, type TeamTablePrice } from "./team-table-price";

export const teamTablePriceItems = (
  prices: ReadonlyArray<TeamTablePrice>,
  locale: Locale,
  label = ""
) =>
  prices.map((price) => {
    const { rates, sale } = getTeamTablePriceCopy(price, locale);
    return markdownListItem(`${label}${rates}${sale ? ` ${sale}` : ""}`);
  });

export const teamTablePriceMarkdown = (
  prices: ReadonlyArray<TeamTablePrice>,
  locale: Locale
) => markdownList(teamTablePriceItems(prices, locale));
