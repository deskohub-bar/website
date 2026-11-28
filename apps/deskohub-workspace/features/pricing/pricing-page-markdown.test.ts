import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  getWorkspaceMeetingRoomProductTitle,
  getWorkspaceOfficeProductTitle,
} from "@/features/checkout/product-catalog.i18n";
import type { PublicOffering } from "@/features/checkout/public-offerings";
import { advertisedCatalogOfferings } from "@/features/checkout/public-offerings.test-utils";
import { type Locale, locales, m } from "@/features/i18n";
import { unlimitedPassOffers } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { serializeMarkdown } from "@/shared/markdown/markdown";
import { markdownPlainText } from "@/shared/markdown/markdown.test-utils";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { pricingPageMarkdown } from "./pricing-page-markdown";
import type { TeamTablePrice } from "./team-table-price";

const renderPricingPage = async (
  locale: Locale,
  offerings: ReadonlyArray<PublicOffering>,
  {
    coworkPassesPublished = false,
    teamTablePrices = [],
  }: {
    readonly coworkPassesPublished?: boolean;
    readonly teamTablePrices?: ReadonlyArray<TeamTablePrice>;
  } = {}
) =>
  serializeMarkdown(
    await Effect.runPromise(
      pricingPageMarkdown(locale, {
        coworkPassesPublished,
        isPublished: () => true,
        offerings: Effect.succeed(offerings),
        teamTablePrices: Effect.succeed(teamTablePrices),
        saleBanner: Effect.succeed(undefined),
      })
    )
  );

const headings = (markdown: string, depth: number) =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith(`${"#".repeat(depth)} `))
    .map((line) => line.slice(depth + 1));

test("prints Team Table rates and a booking link alongside Unlimited membership", async () => {
  const locale = "en-US";
  const offerings = advertisedCatalogOfferings({ locale });
  const markdown = await renderPricingPage(locale, offerings, {
    coworkPassesPublished: true,
    teamTablePrices: [
      {
        seats: 4,
        base: currencyCZK(24_000),
        hourly: currencyCZK(8_000),
        advertisedPrice: {
          price: currencyCZK(25_600),
          discount: currencyCZK(6_400),
        },
      },
      { seats: 6, base: currencyCZK(36_000), hourly: currencyCZK(12_000) },
    ],
  });
  const text = markdownPlainText(markdown);

  expect(headings(markdown, 2)).toContain(m.passUnlimited({}, { locale }));
  expect(text).toContain("Table for 4 · CZK 240 to reserve + CZK 80/hour");
  expect(text).toContain("Table for 6 · CZK 360 to reserve + CZK 120/hour");
  expect(text).toContain("CZK 256 (regular price CZK 320)");
  expect(markdown).toContain("https://workspace.deskohub.cz/reservation/table");
  expect(await renderPricingPage(locale, offerings)).not.toContain(
    "Team Table"
  );
});

describe.each(locales)("pricingPageMarkdown in %s", (locale) => {
  test("lists the opening hours, every price by family, and the address", async () => {
    const markdown = await renderPricingPage(
      locale,
      advertisedCatalogOfferings({ locale, office: {} })
    );
    const text = markdownPlainText(markdown);
    const { address } = workspaceSiteConstants.location;

    expect(markdown).toStartWith(`# ${m.pricingPageTitle({}, { locale })}`);
    expect(headings(markdown, 2)).toEqual([
      m.pricingOpeningHoursTitle({}, { locale }),
      m.pricingCoworkTitle({}, { locale }),
      getWorkspaceMeetingRoomProductTitle(locale),
      getWorkspaceOfficeProductTitle(locale),
      m.contactAddressLabel({}, { locale }),
    ]);
    for (const line of [
      m.pricingOpeningHoursSpace({}, { locale }),
      m.pricingOpeningHoursOpenSpace({ until: "17:00" }, { locale }),
      m.pricingOpeningHoursCodeAccess({}, { locale }),
      `${address.street}, ${address.cityDistrict}, ${address.postalCode} ${address.city}`,
      ...[29_000, 41_000, 35_000, 98_000, 182_000, 53_000, 31_500].map(
        (value) =>
          // Plain text collapses the formatter's no-break spaces.
          formatMoney(currencyCZK(value), locale).replace(/\s+/g, " ")
      ),
    ]) {
      expect(text).toContain(line);
    }
  });

  test("leaves out the office while its page is unpublished", async () => {
    const markdown = await renderPricingPage(
      locale,
      advertisedCatalogOfferings({ locale })
    );

    expect(headings(markdown, 2)).not.toContain(
      getWorkspaceOfficeProductTitle(locale)
    );
  });

  test("names the membership and prices each tier for its validity period", async () => {
    const markdown = await renderPricingPage(
      locale,
      advertisedCatalogOfferings({ locale }),
      { coworkPassesPublished: true }
    );
    const text = markdownPlainText(markdown);

    expect(headings(markdown, 2)).toContain(m.passUnlimited({}, { locale }));
    for (const { product, price, validityDays } of unlimitedPassOffers) {
      const tier = getPassTierName(product.tier, locale);
      const cadence = m.unlimitedPassDiscoveryPrice(
        { price: formatMoney(price, locale), days: validityDays },
        { locale }
      );
      expect(text).toContain(`${tier} · ${cadence}`.replace(/\s+/g, " "));
    }
  });
});
