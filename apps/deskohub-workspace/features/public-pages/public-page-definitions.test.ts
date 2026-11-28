import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Locale, locales } from "@/features/i18n";
import {
  getLegalDocument,
  type LegalDocumentKey,
} from "@/features/legal/content";
import { legalTranslationDates } from "@/features/legal/legal-translation-dates";
import { runtimeImportGraph } from "@/shared/testing/runtime-import-graph.test-utils";
import { workspaceSiteConstants } from "@/shared/utils";
import {
  getPublicPageContentDate,
  publicPageDefinitions,
  publicPages,
} from "./public-page-definitions";

const workspaceRoot = resolve(import.meta.dir, "../..");
const renderingPackage = /^(react|react-dom|server-only|next)(\/|$)/;

test("the registry loads no rendering or server-only modules", async () => {
  const { modules, packages } = await runtimeImportGraph(
    resolve(import.meta.dir, "public-page-definitions.ts"),
    workspaceRoot
  );

  expect(modules.length).toBeGreaterThan(1);
  expect(modules.filter((module) => module.endsWith(".tsx"))).toEqual([]);
  expect(packages.filter((name) => renderingPackage.test(name))).toEqual([]);
});

const legalDocumentKeys = [
  "terms-and-conditions",
  "privacy-policy",
  "cookie-policy",
  "operating-rules",
  "marketing-communications",
] as const satisfies ReadonlyArray<LegalDocumentKey>;

const teamTableLegalPages = [
  "/terms-and-conditions",
  "/privacy-policy",
  "/operating-rules",
] as const;

// The legal pages print their date in each locale's long form; English uses
// the day-first form.
const dateFormatLocale = (locale: Locale) =>
  locale === "en-US" ? "en-GB" : locale;

const longDate = (isoDate: string, locale: Locale) =>
  new Intl.DateTimeFormat(dateFormatLocale(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T12:00:00Z`));

describe("public page content dates", () => {
  test("dates the Open Space seating policy update on each page that presents it", () => {
    for (const path of ["/coworking", "/faq", "/reservation/cowork"] as const) {
      for (const locale of locales) {
        const date = getPublicPageContentDate(
          publicPageDefinitions[path],
          locale
        );
        expect(date >= "2026-11-27").toBe(true);
      }
    }
  });

  test("date each page by its publication or scheduled legal effective date", () => {
    const today = Temporal.Now.plainDateISO("Europe/Prague");

    for (const { pathname, contentDate, localeContentDates } of publicPages) {
      for (const isoDate of [
        contentDate,
        ...Object.values(localeContentDates ?? {}),
      ]) {
        const date = Temporal.PlainDate.from(isoDate);
        expect(date.toString()).toBe(isoDate);
        const scheduledLegalRevision =
          isoDate === contentDate &&
          isoDate === "2026-12-01" &&
          teamTableLegalPages.some((page) => page === pathname);
        if (!scheduledLegalRevision) {
          expect(Temporal.PlainDate.compare(date, today)).toBeLessThanOrEqual(
            0
          );
        }
      }
    }
  });

  test.each(teamTableLegalPages)(
    "date %s in every locale by the Team Table revision",
    (pathname) => {
      for (const locale of locales) {
        expect(
          getPublicPageContentDate(publicPageDefinitions[pathname], locale)
        ).toBe("2026-12-01");
      }
    }
  );

  test("date each legal page by its document's last update in every locale", () => {
    for (const documentKey of legalDocumentKeys) {
      for (const locale of locales) {
        expect(getLegalDocument(locale, documentKey).updatedAt).toBe(
          longDate(publicPageDefinitions[`/${documentKey}`].contentDate, locale)
        );
      }
    }
  });

  test("date the cookie policy sitemap entries by the 2026-11-19 republication", () => {
    const page = publicPageDefinitions["/cookie-policy"];
    for (const locale of locales) {
      expect(getPublicPageContentDate(page, locale)).toBe("2026-11-19");
    }
  });

  // A translated locale's legal text can change, as its translation notice
  // did, without a new Czech version or document date.
  test("date each legal page in a translated locale by its translation too", () => {
    for (const documentKey of legalDocumentKeys) {
      expect(
        publicPageDefinitions[`/${documentKey}`].localeContentDates
      ).toEqual(legalTranslationDates);
    }
  });

  // English's translation notice changed with the new locales' translations
  // on 2026-11-09; a translated page takes the later of that day and its
  // Czech document date. Czech keeps each document's date.
  test("date the translated legal pages by the later of their 2026-11-09 translations and the document date", () => {
    for (const documentKey of legalDocumentKeys) {
      const page = publicPageDefinitions[`/${documentKey}`];
      const translatedDate =
        page.contentDate > "2026-11-09" ? page.contentDate : "2026-11-09";
      for (const locale of ["en-US", "de-DE", "uk-UA", "sk-SK"] as const) {
        expect(getPublicPageContentDate(page, locale)).toBe(translatedDate);
      }
      expect(getPublicPageContentDate(page, "cs-CZ")).toBe(page.contentDate);
    }
  });
});

describe("public page titles and descriptions", () => {
  // The document title appends the site name to the page's own title.
  test("title every page in every locale without the site name", () => {
    for (const { title } of publicPages) {
      for (const locale of locales) {
        const pageTitle = title({}, { locale });
        expect(pageTitle.trim()).not.toBe("");
        expect(pageTitle).not.toContain(workspaceSiteConstants.brand.name);
      }
    }
  });

  test("describe every page in every locale", () => {
    for (const { description } of publicPages) {
      for (const locale of locales) {
        expect(description?.({}, { locale }).trim()).toBeTruthy();
      }
    }
  });
});
