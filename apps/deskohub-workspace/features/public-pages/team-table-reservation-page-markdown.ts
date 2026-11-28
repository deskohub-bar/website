import { Effect } from "effect";
import { type Locale, m } from "@/features/i18n";
import { teamTablePriceMarkdown } from "@/features/pricing/team-table-price-markdown";
import {
  type MarkdownBlocks,
  markdownHeading,
  markdownParagraph,
} from "@/shared/markdown/markdown";
import type { PublicPageMarkdownSources } from "./public-page-markdown";

export const teamTableReservationPageMarkdown = (
  locale: Locale,
  { teamTablePrices }: PublicPageMarkdownSources
): Effect.Effect<MarkdownBlocks> =>
  Effect.map(teamTablePrices, (prices) => [
    markdownHeading(1, m.reservationTableProductTitle({}, { locale })),
    markdownParagraph(m.landingOfferingTeamTableText({}, { locale })),
    ...(prices.length > 0
      ? [
          markdownHeading(2, m.landingNavPricing({}, { locale })),
          teamTablePriceMarkdown(prices, locale),
        ]
      : []),
  ]);
