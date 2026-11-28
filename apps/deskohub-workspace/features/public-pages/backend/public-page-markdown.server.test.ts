import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  type DotyposTable,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { GoogleCalendarEventIdSchema } from "@deskohub/google-calendar";
import { GoogleCalendarServiceMock } from "@deskohub/google-calendar/backend/service.mock";
import { Effect, Layer } from "effect";
import { getPublicCatalogOfferings } from "@/features/checkout/public-offerings";
import { DiscountDefinitionRepositoryMock } from "@/features/discounts/discount-definition.repository.mock";
import type { DiscountReleaseGates } from "@/features/discounts/discount-release-gate.service";
import { storedDiscountIdSchema } from "@/features/discounts/persistence-contracts";
import { classifiedConstancy } from "@/features/feature-flags/backend/feature-flag-constancy.test-utils";
import { m } from "@/features/i18n";
import { publicPages } from "@/features/public-pages/public-page-definitions";
import { salesCalendarIdSchema } from "@/shared/backend/config/calendar-resource.config";
import {
  markdownLinkUrls,
  markdownPlainText,
} from "@/shared/markdown/markdown.test-utils";
import { recordNextCache } from "@/shared/testing/next-cache-recorder.test-utils";

// Outside a Next.js render there is no cache; record what each render asks
// of it instead.
const nextCacheModule = await import("next/cache");
const nextCache = recordNextCache();
mock.module("next/cache", () => ({ ...nextCacheModule, ...nextCache.module }));

// Inside `"use cache"`, Next.js fails the render on any request read, even
// one the app catches. Record each read instead.
const headers = mock(() => {
  throw new Error("headers() was read inside a cached render");
});
const nextHeaders = await import("next/headers");
mock.module("next/headers", () => ({ ...nextHeaders, headers }));

// Every flag varies per visitor, so evaluating one would read the request.
mock.module(
  "@/features/feature-flags/backend/feature-flag-evaluation-mode.server",
  () => ({
    getGlobalWorkspaceFeatureFlagValues: () => Promise.resolve(undefined),
    getGlobalWorkspaceFeatureFlagValue: () => Promise.resolve(undefined),
    getWorkspaceFeatureFlagConstancy: () =>
      Promise.resolve(classifiedConstancy(undefined)),
  })
);

// The shared Calendar sales source, without the Next.js cache around it:
// one 20% sale on every cowork product, running today, while Calendar
// answers.
const saleDiscountId = storedDiscountIdSchema.make(
  "019bfe6e-8ef0-7def-8b16-55cfbc82edc2"
);
let calendarAnswers = true;
const calendarSource = await import(
  "@/features/discounts/calendar-discount-source.server"
);
mock.module("@/features/discounts/calendar-discount-source.server", () => ({
  ...calendarSource,
  loadCalendarDiscountSource: (bookingDate: string) =>
    calendarSource
      .loadCalendarSalesSource({
        calendarId: salesCalendarIdSchema.make("markdown-sales"),
        bookingDate,
      })
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            GoogleCalendarServiceMock({
              listEvents: () =>
                calendarAnswers
                  ? Effect.succeed([
                      {
                        id: GoogleCalendarEventIdSchema.make("markdown-sale"),
                        summary: "Synthetic sale",
                        description: saleDiscountId,
                        start: { date: bookingDate },
                        end: {
                          date: Temporal.PlainDate.from(bookingDate)
                            .add({ days: 1 })
                            .toString(),
                        },
                      },
                    ])
                  : Effect.die("Google Calendar is unavailable"),
            }),
            DiscountDefinitionRepositoryMock({
              loadById: ({ discountId }) =>
                Effect.succeed({
                  id: discountId,
                  labels: { "en-US": "Summer sale", "cs-CZ": "Letní akce" },
                  adjustment: { kind: "percentage", basisPoints: 2000 },
                  products: [{ kind: "cowork" }, { kind: "table" }],
                }),
            })
          )
        ),
        Effect.runPromise
      ),
}));

// Only the published Team Table offer needs the advisory table inventory.
let inventoryReads = 0;
let inventory: DotyposTable[] = [];
let inventoryUnavailable = false;
const teamTable = (seats: string): DotyposTable => ({
  id: DotyposTableIdSchema.make(seats),
  _cloudId: DotyposCloudIdSchema.make("synthetic-cloud"),
  name: seats,
  seats,
  enabled: true,
  display: true,
  tags: ["reservation:table", "cowork:open-space"],
});
const countInventoryRead = <A>(value: A) =>
  Effect.sync(() => {
    inventoryReads += 1;
    return value;
  });
const { AdvisoryAvailabilityInventory } = await import(
  "@/features/reservation/backend/availability-inventory"
);
const inventoryCache = await import(
  "@/features/reservation/backend/availability-inventory-cache.server"
);
mock.module(
  "@/features/reservation/backend/availability-inventory-cache.server",
  () => ({
    ...inventoryCache,
    SharedAvailabilityInventoryLive: Layer.succeed(
      AdvisoryAvailabilityInventory,
      {
        tables: Effect.suspend(() =>
          inventoryUnavailable
            ? Effect.die("Dotypos is unavailable")
            : countInventoryRead(inventory)
        ),
        listActiveReservationsOverlapping: () => countInventoryRead([]),
        listLimitations: () => countInventoryRead([]),
      }
    ),
  })
);

const { renderPublicPageMarkdown } = await import(
  "./public-page-markdown.server"
);
const { renderLlmsTxt } = await import("./llms-txt.server");

const allGatesReleased: DiscountReleaseGates = {
  calendarSales: true,
  customerDiscounts: true,
  discountCodes: true,
};

// The office and Team Table stay closed unless a test opens them.
const releases = (discountReleaseGates = allGatesReleased) => ({
  publishedPathnames: publicPages
    .map(({ pathname }) => pathname)
    .filter(
      (pathname) =>
        pathname !== "/reservation/office" && pathname !== "/reservation/table"
    ),
  discountReleaseGates,
});

const shared = { cacheLife: "publicContent" } as const;
const unshared = { cacheLife: { expire: 0 } } as const;

beforeEach(() => {
  calendarAnswers = true;
  inventoryReads = 0;
  inventory = [];
  inventoryUnavailable = false;
  nextCache.clear();
  headers.mockClear();
});

describe("renderPublicPageMarkdown", () => {
  test("advertises live Team Table sizes and the current Calendar sale while published", async () => {
    inventory = [teamTable("6"), teamTable("4")];
    const open = {
      ...releases(),
      publishedPathnames: [
        ...releases().publishedPathnames,
        "/reservation/table" as const,
      ],
    };
    const pricing = await renderPublicPageMarkdown("en-US", "/pricing", open);
    const booking = await renderPublicPageMarkdown(
      "en-US",
      "/reservation/table",
      open
    );

    for (const page of [pricing, booking]) {
      const text = markdownPlainText(page);
      expect(text).toContain("Table for 4 · CZK 240 to reserve + CZK 80/hour");
      expect(text).toContain("Table for 6 · CZK 360 to reserve + CZK 120/hour");
      expect(text).toContain("CZK 256 (regular price CZK 320)");
      expect(text).toContain("CZK 384 (regular price CZK 480)");
    }
    expect(markdownLinkUrls(pricing)).toContain(
      "https://workspace.deskohub.cz/reservation/table"
    );
    expect(inventoryReads).toBe(2);
    expect(nextCache.calls).toEqual([shared, shared]);

    const closedPricing = await renderPublicPageMarkdown(
      "en-US",
      "/pricing",
      releases()
    );
    expect(closedPricing).not.toContain("Team Table");
    expect(inventoryReads).toBe(2);
  });

  test("omits Team Table prices without sharing the fallback when the inventory fails", async () => {
    inventoryUnavailable = true;
    const open = {
      ...releases(),
      publishedPathnames: [
        ...releases().publishedPathnames,
        "/reservation/table" as const,
      ],
    };
    const markdown = await renderPublicPageMarkdown("en-US", "/pricing", open);

    expect(markdown).not.toContain("Team Table");
    expect(nextCache.calls).toEqual([unshared]);
  });

  test("prices a sale under the request's gate decisions without reading the request", async () => {
    const saleMarkdown = await renderPublicPageMarkdown(
      "en-US",
      "/reservation/cowork",
      releases()
    );
    const catalogMarkdown = await renderPublicPageMarkdown(
      "en-US",
      "/reservation/cowork",
      releases({ ...allGatesReleased, calendarSales: false })
    );

    expect(headers).not.toHaveBeenCalled();
    expect(saleMarkdown).not.toBe(catalogMarkdown);
    expect(nextCache.calls).toEqual([shared, shared]);
  });

  test("does not share reservation prices while Calendar sales are unavailable, and shares them once they load", async () => {
    calendarAnswers = false;
    const failedMarkdown = await renderPublicPageMarkdown(
      "en-US",
      "/reservation/cowork",
      releases()
    );
    calendarAnswers = true;
    const recoveredMarkdown = await renderPublicPageMarkdown(
      "en-US",
      "/reservation/cowork",
      releases()
    );
    const catalogMarkdown = await renderPublicPageMarkdown(
      "en-US",
      "/reservation/cowork",
      releases({ ...allGatesReleased, calendarSales: false })
    );

    expect(failedMarkdown).toBe(catalogMarkdown);
    expect(recoveredMarkdown).not.toBe(catalogMarkdown);
    expect(nextCache.calls).toEqual([unshared, shared, shared]);
    expect(headers).not.toHaveBeenCalled();
  });

  test.each(["en-US", "cs-CZ"] as const)(
    "shows the home page's %s sale banner only while the sale loads, sharing only that render",
    async (locale) => {
      const saleText = locale === "en-US" ? "Summer sale" : "Letní akce";

      calendarAnswers = false;
      const failedMarkdown = await renderPublicPageMarkdown(
        locale,
        "/",
        releases()
      );
      calendarAnswers = true;
      const saleMarkdown = await renderPublicPageMarkdown(
        locale,
        "/",
        releases()
      );
      const withheldMarkdown = await renderPublicPageMarkdown(
        locale,
        "/",
        releases({ ...allGatesReleased, calendarSales: false })
      );

      expect(saleMarkdown).toContain(saleText);
      expect(saleMarkdown).toContain(m.landingSaleBannerStatus({}, { locale }));
      expect(failedMarkdown).not.toContain(saleText);
      expect(withheldMarkdown).toBe(failedMarkdown);
      expect(nextCache.calls).toEqual([unshared, shared, shared]);
      expect(headers).not.toHaveBeenCalled();
    }
  );

  test.each(["en-US", "cs-CZ"] as const)(
    "lists the open office and the sale on the %s price page without reading the availability inventory",
    async (locale) => {
      const office = getPublicCatalogOfferings({ locale, office: {} }).find(
        ({ kind }) => kind === "office"
      );
      const officeOpen = (discountReleaseGates = allGatesReleased) => ({
        ...releases(discountReleaseGates),
        publishedPathnames: [
          ...releases().publishedPathnames,
          "/reservation/office" as const,
        ],
      });
      const saleMarkdown = await renderPublicPageMarkdown(
        locale,
        "/pricing",
        officeOpen()
      );
      const catalogMarkdown = await renderPublicPageMarkdown(
        locale,
        "/pricing",
        officeOpen({ ...allGatesReleased, calendarSales: false })
      );

      expect(office).toBeDefined();
      expect(saleMarkdown).toContain(office?.name ?? "");
      expect(saleMarkdown).not.toBe(catalogMarkdown);
      expect(inventoryReads).toBe(0);
      expect(nextCache.calls).toEqual([shared, shared]);
      expect(headers).not.toHaveBeenCalled();
    }
  );

  test("shares a page that reads no unavailable source", async () => {
    calendarAnswers = false;

    await renderPublicPageMarkdown("en-US", "/contact", releases());

    expect(nextCache.calls).toEqual([shared]);
  });
});

describe("renderLlmsTxt", () => {
  test("does not share prices while Calendar sales are unavailable, and shares them once they load", async () => {
    calendarAnswers = false;
    const failed = await renderLlmsTxt(releases(), "on");
    calendarAnswers = true;
    const recovered = await renderLlmsTxt(releases(), "on");

    expect(recovered).not.toBe(failed);
    expect(nextCache.calls).toEqual([unshared, shared]);
    expect(headers).not.toHaveBeenCalled();
  });
});
