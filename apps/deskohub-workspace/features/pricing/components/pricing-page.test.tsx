import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { ComponentProps } from "react";
import { prerender } from "react-dom/static";
import {
  getPublicCatalogOfferings,
  type PublicPriceListOffering,
} from "@/features/checkout/public-offerings";
import type { GlobalRelease } from "@/features/feature-flags/backend/global-release";
import { type Locale, locales, m } from "@/features/i18n";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import type { TeamTablePrice } from "../team-table-price";

const nextServer = await import("next/server");

mock.module("server-only", () => ({}));
mock.module("next/server", () => ({
  ...nextServer,
  connection: () => Promise.resolve(),
}));
mock.module("@/shared/components/guarded-link", () => ({
  GuardedLink: ({
    children,
    href,
    prefetch: _prefetch,
    ...props
  }: Omit<ComponentProps<"a">, "href"> & {
    readonly href: string;
    readonly prefetch?: boolean;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let passesRelease: GlobalRelease = "off";
const isCoworkPassesPageOpenAfterConnection = mock(async () => false);
mock.module("@/features/feature-flags/backend/global-release.server", () => ({
  loadGlobalRelease: async () => passesRelease,
}));
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    isCoworkPassesPageOpenAfterConnection,
  })
);

type PriceListLoad = (
  locale: Locale
) =>
  | ReadonlyArray<PublicPriceListOffering>
  | Promise<ReadonlyArray<PublicPriceListOffering>>;

let sharedPriceList: PriceListLoad;
let variesByVisitor = false;
let visitorPriceList: PriceListLoad;
let teamTablePrices: ReadonlyArray<TeamTablePrice> = [];
let visitorTeamTablePrices: ReadonlyArray<TeamTablePrice> = [];
const loadVisitorPriceList = mock(async (locale: Locale) => ({
  offerings: await visitorPriceList(locale),
  teamTablePrices: visitorTeamTablePrices,
}));
mock.module("@/features/pricing/backend/price-list.server", () => ({
  loadSharedPriceList: async (locale: Locale) => ({
    offerings: await sharedPriceList(locale),
    teamTablePrices,
    variesByVisitor,
    complete: true,
  }),
  loadVisitorPriceList,
}));

const { PricingPage } = await import("./pricing-page");

/** The catalog with a sale on Open Space and the office open. */
const saleOnOpenSpace = (locale: Locale) => {
  const [openSpace, ...rest] = getPublicCatalogOfferings({
    locale,
    office: { maximumSeats: 6 },
  });
  if (!openSpace) throw new Error("The catalog lists no cowork offering.");

  return [
    {
      ...openSpace,
      advertisedPrice: {
        price: currencyCZK(23_200),
        discount: currencyCZK(5800),
      },
    },
    ...rest,
  ];
};

const renderPage = async (locale: Locale, signal?: AbortSignal) => {
  const renderErrors: unknown[] = [];
  const { prelude } = await prerender(<PricingPage locale={locale} />, {
    signal,
    onError(error) {
      if (!signal?.aborted || error !== signal.reason) {
        renderErrors.push(error);
      }
    },
  });
  const html = await new Response(prelude).text();
  expect(renderErrors).toEqual([]);
  return html;
};

/**
 * The page as an agent that drops hidden elements reads it: React puts a
 * streamed Suspense segment in a hidden container until script reveals it.
 */
const visibleDocument = (html: string) => {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of document.querySelectorAll("[hidden], script")) {
    element.remove();
  }
  return document;
};

const visibleText = (html: string) =>
  visibleDocument(html).body.textContent ?? "";

const visibleLinks = (html: string) =>
  [...visibleDocument(html).querySelectorAll("a")].map((link) =>
    link.getAttribute("href")
  );

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);

beforeEach(() => {
  passesRelease = "off";
  isCoworkPassesPageOpenAfterConnection.mockReset();
  isCoworkPassesPageOpenAfterConnection.mockResolvedValue(false);
  sharedPriceList = saleOnOpenSpace;
  variesByVisitor = false;
  visitorPriceList = saleOnOpenSpace;
  teamTablePrices = [];
  visitorTeamTablePrices = [];
  loadVisitorPriceList.mockClear();
});

describe("PricingPage", () => {
  test("shows configured Team Table rates and a sale in server HTML and JSON-LD", async () => {
    teamTablePrices = [
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
    ];
    const html = await renderPage("en-US");
    const text = visibleText(html).replace(/\s+/g, " ");
    const document = new DOMParser().parseFromString(html, "text/html");
    const schema = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
      (script) => JSON.parse(script.textContent ?? "null")
    ).find((data) => data.name === "Team Table");

    expect(text).toContain("Table for 4 · CZK 240 to reserve + CZK 80/hour");
    expect(text).toContain("Table for 6 · CZK 360 to reserve + CZK 120/hour");
    expect(text).toContain("CZK 256 (regular price CZK 320)");
    expect(visibleLinks(html)).toContain("/en-US/reservation/table");
    expect(schema?.offers).toMatchObject([
      {
        price: 256,
        priceSpecification: [{ price: 240 }, { price: 80, unitCode: "HUR" }],
      },
      { priceSpecification: [{ price: 360 }, { price: 120, unitCode: "HUR" }] },
    ]);
  });

  test("omits Team Table rates, link, and structured offers when there are no public prices", async () => {
    const html = await renderPage("en-US");

    expect(visibleText(html)).not.toContain("Team Table");
    expect(html).not.toContain("/reservation/table");
  });

  test("publishes the same Team Table rate and sale in visitor HTML and structured data during rollout", async () => {
    variesByVisitor = true;
    visitorTeamTablePrices = [
      {
        seats: 4,
        base: currencyCZK(24_000),
        hourly: currencyCZK(8_000),
        advertisedPrice: {
          price: currencyCZK(25_600),
          discount: currencyCZK(6_400),
        },
      },
    ];
    const html = await renderPage("en-US");
    const document = new DOMParser().parseFromString(html, "text/html");
    const services = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
      (script) => JSON.parse(script.textContent ?? "null")
    ).filter((data) => data.name === "Team Table");

    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Table for 4 · CZK 240 to reserve + CZK 80/hour");
    expect(text).toContain("CZK 256 (regular price CZK 320)");
    expect(services).toMatchObject([
      {
        offers: [
          {
            price: 256,
            priceSpecification: [
              { price: 240 },
              { price: 80, unitCode: "HUR" },
            ],
          },
        ],
      },
    ]);
    expect(services).toHaveLength(1);
  });

  test("keeps cowork pass offers out of the price page while the release is off", async () => {
    const html = await renderPage("en-US");
    expect(
      visibleDocument(html).getElementById("pricing-entry-packs")
    ).toBeNull();
    expect(
      visibleLinks(html).some((href) => href?.includes("/passes/entry-pack"))
    ).toBe(false);
    expect(
      visibleDocument(html).getElementById("pricing-unlimited")
    ).toBeNull();
    expect(
      visibleLinks(html).some((href) => href?.includes("/passes/unlimited"))
    ).toBe(false);
    expect(isCoworkPassesPageOpenAfterConnection).not.toHaveBeenCalled();
  });

  test("shows all Entry pack tiers and their catalog prices in the static price page", async () => {
    passesRelease = "on";
    const locale = "cs-CZ";
    const document = visibleDocument(await renderPage(locale));
    const packs = document.getElementById("pricing-entry-packs");
    if (!packs) throw new Error("Expected the Entry packs price section");

    expect(packs.previousElementSibling?.getAttribute("aria-labelledby")).toBe(
      "pricing-cowork-title"
    );
    expect(packs.querySelector("h2")?.textContent).toBe("Balíčky vstupů");
    const price = (value: number) => formatMoney(currencyCZK(value), locale);
    for (const expected of [
      115_000, 219_000, 159_000, 309_000, 205_000, 399_000, 23_000, 21_900,
      31_800, 30_900, 41_000, 39_900,
    ]) {
      expect(packs.textContent).toContain(price(expected));
    }
    expect(packs.textContent).toContain("5 vstupů s platností 2 měsíce");
    expect(packs.textContent).toContain("10 vstupů s platností 3 měsíce");
    expect(
      Array.from(packs.querySelectorAll("a"), (link) =>
        link.getAttribute("href")
      )
    ).toEqual([
      "/cs-CZ/passes/entry-pack?tier=open-space",
      "/cs-CZ/passes/entry-pack?tier=reserved-desk",
      "/cs-CZ/passes/entry-pack?tier=reserved-desk-workstation",
    ]);
    expect(isCoworkPassesPageOpenAfterConnection).not.toHaveBeenCalled();
  });

  test("shows the three Unlimited pass purchase options and their 30-day prices in the static price page", async () => {
    passesRelease = "on";
    const locale = "en-US";
    const section = visibleDocument(await renderPage(locale)).getElementById(
      "pricing-unlimited"
    );
    if (!section) throw new Error("Expected the Unlimited pass price section");

    expect(section.previousElementSibling?.id).toBe("pricing-entry-packs");
    expect(section.querySelector("h2")?.textContent).toBe(
      "Unlimited membership"
    );
    const price = (amount: number) => formatMoney(currencyCZK(amount), locale);
    const rows = [...section.querySelectorAll("li")];
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      const offer = [
        { tier: "open-space", price: 349_000, perDay: 11_600 },
        { tier: "reserved-desk", price: 599_000, perDay: 20_000 },
        { tier: "reserved-desk-workstation", price: 849_000, perDay: 28_300 },
      ][index];
      expect(row.textContent).toContain(`${price(offer.price)} / 30 days`);
      expect(row.textContent).toContain(`About ${price(offer.perDay)} a day`);
      expect(row.textContent?.includes(price(69_000))).toBe(index === 0);
      const link = row.querySelector("a");
      expect(link?.getAttribute("href")).toBe(
        `/en-US/passes/unlimited?tier=${offer.tier}`
      );
      expect(link?.getAttribute("aria-label")).toBe(
        `Buy Unlimited membership (${row.querySelector("h3")?.textContent})`
      );
    }
    expect(isCoworkPassesPageOpenAfterConnection).not.toHaveBeenCalled();
  });

  test("links to the Unlimited pass purchase in the visitor's locale", async () => {
    passesRelease = "on";
    expect(visibleLinks(await renderPage("cs-CZ"))).toContain(
      "/cs-CZ/passes/unlimited?tier=open-space"
    );
  });

  test.each([false, true])(
    "asks for the visitor's flag when the global release is undecided (visitor open: %s)",
    async (visitorOpen) => {
      passesRelease = "undecided";
      isCoworkPassesPageOpenAfterConnection.mockResolvedValue(visitorOpen);

      const html = await renderPage("en-US");

      expect(html.includes("/en-US/passes/entry-pack?tier=open-space")).toBe(
        visitorOpen
      );
      expect(html.includes("/en-US/passes/unlimited?tier=open-space")).toBe(
        visitorOpen
      );
      expect(isCoworkPassesPageOpenAfterConnection).toHaveBeenCalledTimes(1);
    }
  );

  for (const locale of locales) {
    test(`shows every price, the office, the sale, and the opening hours in the visible server HTML in ${locale}`, async () => {
      const html = await renderPage(locale);
      const text = visibleText(html);
      const price = (value: number) => formatMoney(currencyCZK(value), locale);

      for (const expected of [
        m.pricingPageTitle({}, { locale }),
        m.pricingOpeningHoursSpace({}, { locale }),
        m.pricingOpeningHoursOpenSpace({ until: "17:00" }, { locale }),
        m.pricingOpeningHoursCodeAccess({}, { locale }),
        m.pricingPerDay({ price: price(29_000) }, { locale }),
        m.pricingPerDay({ price: price(41_000) }, { locale }),
        m.pricingAddOnPrice(
          {
            name: m.reservationCoffeeLabel({}, { locale }),
            price: price(5000),
          },
          { locale }
        ),
        m.pricingAddOnPrice(
          {
            name: m.reservationWorkstationLabel({}, { locale }),
            price: price(12_000),
          },
          { locale }
        ),
        m.pricingSalePrice(
          { price: price(23_200), regularPrice: price(29_000) },
          { locale }
        ),
        price(35_000),
        price(98_000),
        price(182_000),
        m.pricingPerDay({ price: price(53_000) }, { locale }),
        m.pricingOfficeSeatPrice({ price: price(31_500) }, { locale }),
      ]) {
        expect(text).toContain(expected);
      }
      // Nothing waits in a hidden container, and the request is never read.
      expect(html).not.toContain("hidden");
      expect(loadVisitorPriceList).not.toHaveBeenCalled();
      // The meeting-room durations share one usage sentence, shown once.
      expect(
        text.split(m.publicOfferingMeetingRoomUsage({}, { locale })).length
      ).toBe(2);

      const links = visibleLinks(html);
      for (const href of [
        `/${locale}/reservation/cowork?entryTier=open-space`,
        `/${locale}/reservation/cowork?entryTier=reserved-desk`,
        `/${locale}/reservation/meeting-room?duration=hour%3A1`,
        `/${locale}/reservation/meeting-room?duration=hour%3A4`,
        `/${locale}/reservation/meeting-room?duration=day%3A1`,
        `/${locale}/reservation/office`,
        `/${locale}/contact`,
      ]) {
        expect(links).toContain(href);
      }
    });
  }

  test("says the space is open 24/7 and Open Space closes at 17:00", async () => {
    const text = visibleText(await renderPage("en-US"));

    expect(text).toContain("The space is open 24/7");
    expect(text).toContain("until 17:00");
    expect(text).toContain("24/7 code access");
  });

  test("keeps the shared prices visible while a gate decided per visitor streams the visitor's list", async () => {
    // A gate decided per visitor stays closed in the shared list.
    sharedPriceList = (locale) => getPublicCatalogOfferings({ locale });
    variesByVisitor = true;
    visitorPriceList = () => new Promise(() => {});
    // Aborting keeps the shell that Next.js prerenders, without the stream.
    const html = await renderPage("en-US", AbortSignal.timeout(100));
    const text = visibleText(html);
    const price = (value: number) => formatMoney(currencyCZK(value), "en-US");

    for (const expected of [
      m.pricingPerDay({ price: price(29_000) }, { locale: "en-US" }),
      m.pricingPerDay({ price: price(41_000) }, { locale: "en-US" }),
      price(35_000),
      price(98_000),
      price(182_000),
    ]) {
      expect(text).toContain(expected);
    }
    expect(loadVisitorPriceList).toHaveBeenCalledTimes(1);
    expect(html).not.toContain('id="pricing-office-title"');
  });

  test("lists catalog prices without a sale line when no quote answered", async () => {
    sharedPriceList = (locale) => getPublicCatalogOfferings({ locale });
    const html = await renderPage("en-US");
    const text = visibleText(html);

    expect(text).toContain(
      m.pricingPerDay(
        { price: formatMoney(currencyCZK(29_000), "en-US") },
        { locale: "en-US" }
      )
    );
    expect(text).not.toContain("On sale today");
    // The office is listed only while its release gate is on.
    expect(html).not.toContain('id="pricing-office-title"');
    expect(html).not.toContain("/en-US/reservation/office");
  });
});
