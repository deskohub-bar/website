import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "@playwright/test";
import { Effect } from "effect";
import type { CampaignBodyNode } from "@/features/email-campaigns/body/campaign-body-document";
import { renderCampaignEmailPreview } from "@/features/email-campaigns/campaign-email";
import { m } from "@/features/i18n";
import { getWorkspacePageUrl } from "@/features/i18n/page-url";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser | undefined;

beforeAll(async () => {
  if (!chromiumAvailable) return;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const offer = (attrs: CampaignBodyNode["attrs"]): CampaignBodyNode => ({
  type: "passOffer",
  attrs,
});

// Long synthetic lines wrap on a phone, so the text cell outgrows the others.
const cards = {
  entryPack: {
    node: offer({
      product: "entry-pack",
      size: 5,
      headline: "Synthetic saving headline for a pass",
      detail: "a synthetic detail line long enough to wrap on a phone",
    }),
    url: getWorkspacePageUrl("/passes/entry-pack", { size: "5" }),
    background: "#f9cb70",
  },
  unlimited: {
    node: offer({
      product: "unlimited",
      headline: "Synthetic saving headline for a pass",
      detail: "a synthetic detail line long enough to wrap on a phone",
    }),
    url: getWorkspacePageUrl("/passes/unlimited"),
    background: "#761730",
  },
};

for (const width of [1280, 390]) {
  test.skipIf(!chromiumAvailable)(
    `links every point of each pass offer card at ${width}px`,
    async () => {
      if (!browser) throw new Error("Chromium did not launch");
      const { html } = await Effect.runPromise(
        renderCampaignEmailPreview({
          templateKey: "workspace",
          purpose: "marketing",
          locale: "en-US",
          content: {
            subject: "Synthetic",
            preheader: "Synthetic",
            body: {
              formatVersion: 1,
              doc: {
                type: "doc",
                content: [cards.entryPack.node, cards.unlimited.node],
              },
            },
          },
        })
      );
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.route("**/*", (route) => route.abort());
        await page.setContent(html);
        for (const card of Object.values(cards)) {
          const missed = await page.evaluate(
            ({ background, url }) => {
              const table = document.querySelector(
                `table[bgcolor="${background}"]`
              );
              if (!table) return ["no card"];
              const cells = table.querySelectorAll(":scope > tbody > tr > td");
              const misses: string[] = [];
              for (const [index, cell] of [...cells].entries()) {
                const box = cell.getBoundingClientRect();
                // Points two pixels inside each edge and corner, and the centre.
                for (const fx of [0, 0.5, 1]) {
                  for (const fy of [0, 0.5, 1]) {
                    const x = box.left + 2 + fx * (box.width - 4);
                    const y = box.top + 2 + fy * (box.height - 4);
                    const link = document
                      .elementFromPoint(x, y)
                      ?.closest("a")
                      ?.getAttribute("href");
                    if (link !== url)
                      misses.push(`cell ${index} at ${fx},${fy}`);
                  }
                }
              }
              // The card's own edges, painted stripe and borders included;
              // corners are rounded off, so only the edge midpoints count.
              const card = table.getBoundingClientRect();
              for (const [fx, fy] of [
                [0, 0.5],
                [1, 0.5],
                [0.5, 0],
                [0.5, 1],
              ] as const) {
                const x = card.left + 2 + fx * (card.width - 4);
                const y = card.top + 2 + fy * (card.height - 4);
                const link = document
                  .elementFromPoint(x, y)
                  ?.closest("a")
                  ?.getAttribute("href");
                if (link !== url) misses.push(`card edge at ${fx},${fy}`);
              }
              return misses;
            },
            { background: card.background, url: card.url }
          );
          expect(missed).toEqual([]);
        }
        // From the top, the keyboard reaches each card once, at a link that
        // names its product; the decorative cells take no stop.
        const focused = async () => {
          await page.keyboard.press("Tab");
          return page.evaluate(() => {
            const link = document.activeElement;
            return {
              href: link?.getAttribute("href"),
              text: link?.textContent ?? "",
            };
          });
        };
        const first = await focused();
        expect(first.href).toBe(cards.entryPack.url);
        expect(first.text).toContain(m.passEntryPack({}, { locale: "en-US" }));
        const second = await focused();
        expect(second.href).toBe(cards.unlimited.url);
        expect(second.text).toContain(m.passUnlimited({}, { locale: "en-US" }));
      } finally {
        await page.close();
      }
    }
  );
}
