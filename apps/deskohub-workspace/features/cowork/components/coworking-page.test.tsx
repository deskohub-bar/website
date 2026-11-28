import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { prerender } from "react-dom/static";
import type { WorkspaceCoworkCurrentTier } from "@/features/checkout/product-catalog";
import {
  getPublicCatalogOfferings,
  type PublicPriceListOffering,
} from "@/features/checkout/public-offerings";
import type { GlobalRelease } from "@/features/feature-flags/backend/global-release";
import { type Locale, locales } from "@/features/i18n";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

const nextServer = await import("next/server");

mock.module("server-only", () => ({}));
mock.module("next/server", () => ({
  ...nextServer,
  connection: () => Promise.resolve(),
}));

const releasedFlags: Array<string> = [];
let passesRelease: GlobalRelease = "off";
const isCoworkPassesPageOpenAfterConnection = mock(async () => false);
mock.module("@/features/feature-flags/backend/global-release.server", () => ({
  loadGlobalRelease: async (flag: string) => {
    releasedFlags.push(flag);
    return passesRelease;
  },
}));
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({ isCoworkPassesPageOpenAfterConnection })
);

const { CoworkingPage } = await import("./coworking-page");

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);

beforeEach(() => {
  releasedFlags.length = 0;
  passesRelease = "off";
  isCoworkPassesPageOpenAfterConnection.mockReset();
  isCoworkPassesPageOpenAfterConnection.mockResolvedValue(false);
});

const catalogOffering = (
  locale: Locale,
  tier: WorkspaceCoworkCurrentTier
): PublicPriceListOffering => {
  const offering = getPublicCatalogOfferings({ locale }).find(
    (candidate) => candidate.kind === "cowork" && candidate.tier === tier
  );
  if (!offering) throw new Error(`The catalog lists no ${tier} offering.`);
  return offering;
};

const meetingRoomOfferings = (locale: Locale) =>
  getPublicCatalogOfferings({ locale }).filter(
    (offering) => offering.kind === "meeting-room"
  );

/**
 * The prerendered page. With `visibleOnly`, it drops the hidden containers
 * React streams Suspense content into until script reveals it, leaving what
 * the static shell shows.
 */
const renderPage = async (
  locale: Locale,
  offerings: ReadonlyArray<PublicPriceListOffering>,
  {
    signal,
    visibleOnly = true,
  }: {
    readonly signal?: AbortSignal;
    readonly visibleOnly?: boolean;
  } = {}
) => {
  const renderErrors: unknown[] = [];
  const { prelude } = await prerender(
    <CoworkingPage locale={locale} offerings={offerings} photos={[]} />,
    {
      signal,
      onError(error) {
        if (!signal?.aborted || error !== signal.reason) {
          renderErrors.push(error);
        }
      },
    }
  );
  const document = new DOMParser().parseFromString(
    await new Response(prelude).text(),
    "text/html"
  );
  expect(renderErrors).toEqual([]);
  if (visibleOnly) {
    for (const element of document.querySelectorAll("[hidden], script")) {
      element.remove();
    }
  }
  return document;
};

/** Each desk card's visible text, keyed by tier. */
const renderDeskCards = async (
  locale: Locale,
  offerings: ReadonlyArray<PublicPriceListOffering>
) => {
  const document = await renderPage(locale, offerings);
  return Object.fromEntries(
    [...document.querySelectorAll("article[aria-labelledby]")].map(
      (article) => [
        article.getAttribute("aria-labelledby"),
        article.textContent ?? "",
      ]
    )
  );
};

describe("CoworkingPage desk cards", () => {
  for (const locale of locales) {
    test(`shows each desk's own day price and only a running sale's regular price in ${locale}`, async () => {
      const openSpace = catalogOffering(locale, "open-space");
      const reservedDesk = catalogOffering(locale, "reserved-desk");
      const cards = await renderDeskCards(locale, [
        ...meetingRoomOfferings(locale),
        {
          ...openSpace,
          advertisedPrice: {
            price: currencyCZK(23_200),
            discount: currencyCZK(5800),
          },
        },
        reservedDesk,
      ]);
      const openSpaceCard = cards["coworking-desk-open-space"];
      const reservedDeskCard = cards["coworking-desk-reserved-desk"];

      expect(Object.keys(cards)).toEqual([
        "coworking-desk-open-space",
        "coworking-desk-reserved-desk",
      ]);
      expect(openSpaceCard).toContain(formatMoney(openSpace.price, locale));
      expect(openSpaceCard).toContain(formatMoney(currencyCZK(23_200), locale));
      expect(openSpaceCard).toContain(formatMoney(currencyCZK(29_000), locale));
      expect(reservedDeskCard).toContain(
        formatMoney(reservedDesk.price, locale)
      );
      expect(reservedDeskCard).not.toContain(
        formatMoney(currencyCZK(23_200), locale)
      );
    });
  }

  test("leaves out the price of a desk with no cowork offering", async () => {
    const locale = "en-US";
    const reservedDesk = catalogOffering(locale, "reserved-desk");
    const cards = await renderDeskCards(locale, meetingRoomOfferings(locale));

    expect(cards["coworking-desk-reserved-desk"]).toBeDefined();
    expect(cards["coworking-desk-reserved-desk"]).not.toContain(
      formatMoney(reservedDesk.price, locale)
    );
  });
});

describe("CoworkingPage pass comparison link", () => {
  /** Links to the Pricing page that carry the pass product marks. */
  const passLinks = (document: Document) =>
    [...document.querySelectorAll("a")]
      .filter((link) => link.querySelector('[aria-hidden="true"] svg'))
      .map((link) => link.getAttribute("href"));

  for (const locale of locales) {
    test(`opens the ${locale} Pricing page while cowork passes are released`, async () => {
      passesRelease = "on";
      const document = await renderPage(locale, meetingRoomOfferings(locale));

      expect(passLinks(document)).toEqual([`/${locale}/pricing`]);
      expect(releasedFlags).toEqual(["cowork_passes"]);
    });
  }

  test("leaves only the add-on price note while cowork passes are off", async () => {
    const document = await renderPage("en-US", meetingRoomOfferings("en-US"));

    expect(passLinks(document)).toEqual([]);
    expect(
      [...document.querySelectorAll("a")].map((link) =>
        link.getAttribute("href")
      )
    ).toContain("/en-US/pricing");
    expect(isCoworkPassesPageOpenAfterConnection).not.toHaveBeenCalled();
  });

  test("asks the visitor's cowork passes gate while the release varies", async () => {
    passesRelease = "undecided";
    const streamed = { visibleOnly: false };
    const closed = await renderPage(
      "en-US",
      meetingRoomOfferings("en-US"),
      streamed
    );
    isCoworkPassesPageOpenAfterConnection.mockResolvedValue(true);
    const open = await renderPage(
      "en-US",
      meetingRoomOfferings("en-US"),
      streamed
    );

    expect(passLinks(closed)).toEqual([]);
    expect(passLinks(open)).toEqual(["/en-US/pricing"]);
  });

  test("keeps the varying link out of the shared static shell", async () => {
    passesRelease = "undecided";
    isCoworkPassesPageOpenAfterConnection.mockImplementation(
      () => new Promise(() => {})
    );
    const shell = await renderPage(
      "en-US",
      meetingRoomOfferings("en-US"),
      // Aborting keeps the shell that Next.js prerenders, without the stream.
      { signal: AbortSignal.timeout(100) }
    );

    expect(passLinks(shell)).toEqual([]);
    expect(
      shell.querySelector('#coworking-desks p a[href="/en-US/pricing"]')
    ).not.toBeNull();
  });
});
