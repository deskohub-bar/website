import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { m } from "@/features/administration/i18n";
import { type Locale, locales } from "@/features/i18n";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";
import { CampaignInboxPreview } from "./campaign-inbox-preview";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser | undefined;
let appStyles = "";

beforeAll(async () => {
  if (!chromiumAvailable) return;
  appStyles = await compileWorkspaceAppStyles();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const markup = ({
  routeLocale = "en-US",
  shown,
  updating,
}: {
  readonly routeLocale?: Locale;
  readonly shown: readonly Locale[];
  readonly updating?: boolean;
}) => {
  const [locale] = shown;
  if (!locale) throw new Error("Expected at least one preview locale.");
  return renderToStaticMarkup(
    <RouteLocaleProvider locale={routeLocale}>
      <CampaignInboxPreview
        locale={locale}
        locales={shown}
        onLocaleChange={() => undefined}
        placeholder="Synthetic placeholder"
        preheader="Synthetic preheader"
        subject="Synthetic subject"
        updating={updating}
      />
    </RouteLocaleProvider>
  );
};

const openPage = async (body: string) => {
  if (!browser) throw new Error("The preview browser has not been launched.");
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`
  );
  // A spinner caught mid-turn measures wider than the space it takes.
  await page.addStyleTag({
    content: `${appStyles}*{animation:none!important;transition:none!important}`,
  });
  return { context, page };
};

test.skipIf(!chromiumAvailable).each([
  ["a narrow phone", 288, locales],
  ["a phone", 326, locales],
  ["the composer's side column", 416, locales],
  ["a wide section", 1100, locales],
  ["a phone with two languages", 326, ["cs-CZ", "en-US"]],
] as const)(
  "keeps every language reachable in %s",
  async (_, width, shown) => {
    const { context, page } = await openPage(
      `<main style="width:${width}px">${markup({ shown })}</main>`
    );
    try {
      const { card, choices, heading } = await page.evaluate(() => {
        const box = (element: Element) => {
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        };
        const section = document.querySelector("section");
        const heading = section?.querySelector("h2");
        if (!section || !heading) {
          throw new Error("Expected the inbox preview card and heading.");
        }
        return {
          card: box(section),
          heading: box(heading),
          choices: [...section.querySelectorAll("label")].map(box),
        };
      });
      expect(choices).toHaveLength(shown.length);
      for (const choice of choices) {
        expect(choice.left).toBeGreaterThanOrEqual(card.left);
        expect(choice.right).toBeLessThanOrEqual(card.right);
      }
      // One row beside the heading wherever every language fits there.
      if (width === 1100 || shown.length === 2) {
        for (const choice of choices) {
          expect(choice.top).toBeLessThan(heading.bottom);
        }
      }

      const radios = page.getByRole("radio");
      await radios.first().focus();
      for (let index = 1; index < shown.length; index++) {
        await page.keyboard.press("ArrowRight");
        expect(await radios.nth(index).isChecked()).toBe(true);
      }
      for (let index = 0; index < shown.length; index++) {
        await page.locator("label").nth(index).tap({ timeout: 5000 });
        expect(await radios.nth(index).isChecked()).toBe(true);
      }
    } finally {
      await context.close();
    }
  },
  30_000
);

test.skipIf(!chromiumAvailable).each([...locales])(
  "shows the whole updating label without moving any set of languages at any width in %s",
  async (routeLocale) => {
    // A published email offers any number of the languages.
    const { context, page } = await openPage(
      locales
        .flatMap((_, index) =>
          [true, false].map(
            (updating) =>
              `<main>${markup({ routeLocale, shown: locales.slice(0, index + 1), updating })}</main>`
          )
        )
        .join("")
    );
    try {
      const failures = await page.evaluate(
        (label) => {
          const failed: string[] = [];
          const mains = [...document.querySelectorAll("main")];
          const layout = (card: Element) => {
            const header = card.firstElementChild;
            if (!header) throw new Error("Expected the preview card header.");
            const origin = card.getBoundingClientRect();
            return JSON.stringify(
              [header, ...card.querySelectorAll("label")].map((element) => {
                const box = element.getBoundingClientRect();
                return [box.x - origin.x, box.y - origin.y, box.height].map(
                  Math.round
                );
              })
            );
          };
          for (let index = 0; index < mains.length; index += 2) {
            const busy = mains[index];
            const idle = mains[index + 1];
            const busyCard = busy?.querySelector("section");
            const idleCard = idle?.querySelector("section");
            if (!busy || !idle || !busyCard || !idleCard) {
              throw new Error("Expected paired busy and idle preview cards.");
            }
            const count = index / 2 + 1;
            const text = document.createRange();
            const shownLabel = [...busy.querySelectorAll("span")].find(
              (span) =>
                span.textContent === label &&
                span.getBoundingClientRect().width > 1
            );
            if (!shownLabel)
              throw new Error("Expected a visible update label.");
            text.selectNodeContents(shownLabel);
            for (let width = 288; width <= 1100; width += 4) {
              busy.style.width = idle.style.width = `${width}px`;
              const at = `${count} languages at ${width}`;
              if (layout(busyCard) !== layout(idleCard)) {
                failed.push(`moved ${at}`);
              }
              const inner = text.getBoundingClientRect();
              const outer = shownLabel.getBoundingClientRect();
              const card = busyCard.getBoundingClientRect();
              if (
                inner.left < Math.max(outer.left, card.left) - 0.5 ||
                inner.right > Math.min(outer.right, card.right) + 0.5
              ) {
                failed.push(`clipped ${at}`);
              }
            }
          }
          return failed;
        },
        m.emailCampaignsEmailPreviewUpdating({}, { locale: routeLocale })
      );
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  },
  30_000
);
