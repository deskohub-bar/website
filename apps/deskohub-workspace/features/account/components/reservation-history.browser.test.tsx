import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { renderToReadableStream } from "react-dom/server";
import type { AccountPasses } from "@/features/account/account-passes.server";
import type { CustomerReservationSummary } from "@/features/account/contracts";
import { UnsavedChangesProvider } from "@/shared/components/unsaved-changes-guard";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";
import { ReservationHistory } from "./reservation-history";

const chromiumAvailable = await playwrightChromiumAvailable();
const viewport = { width: 390, height: 844 };
const safeAreaBottom = 34;
let browser: Browser | undefined;
let styles = "";
let document = "";
let streamingDocument = "";
let coveredDocument = "";

const pastVisits = Array.from(
  { length: 14 },
  (_, index): CustomerReservationSummary => {
    const day = String(20 - index).padStart(2, "0");
    return {
      id: `synthetic-visit-${index}`,
      product: { kind: "cowork", tier: "open-space" },
      startsAt: `2026-10-${day}T08:00:00Z`,
      endsAt: `2026-10-${day}T16:00:00Z`,
      seats: 1,
      status: "confirmed",
      ...(index === 0 && { settlement: "paid" as const }),
    };
  }
);

const renderHistory = (entryPacks: Promise<AccountPasses>) =>
  renderToReadableStream(
    <UnsavedChangesProvider>
      <ReservationHistory
        entryPacks={entryPacks}
        history={{
          kind: "available",
          groups: { current: [], past: pastVisits, unavailable: [] },
        }}
        locale="en-US"
      />
    </UnsavedChangesProvider>
  );

const pageOf = (markup: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${styles}</style></head><body><main class="px-4 pt-8 pb-64"><div class="@container min-w-0">${markup}</div></main></body></html>`;

/** The markup React streams before the Entry pack read settles. */
const shellOf = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let markup = "";
  while (!markup.includes("data-footer-layout")) {
    const { done, value } = await reader.read();
    if (done) break;
    markup += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return markup;
};

beforeAll(async () => {
  if (!chromiumAvailable) return;
  styles = await compileWorkspaceAppStyles();
  const stream = await renderHistory(
    Promise.resolve({ held: [], boughtForOthers: [] })
  );
  await stream.allReady;
  document = pageOf(await new Response(stream).text());
  streamingDocument = pageOf(
    await shellOf(await renderHistory(new Promise(() => {})))
  );
  const covered = await renderHistory(
    Promise.resolve({
      held: [
        {
          position: 1,
          tier: "Open Space",
          entryCount: 5,
          entriesLeft: 2,
          lastUsableDay: "Feb 1, 2027",
          status: "active",
          bookPath: "/en-US/passes/entry-pack/book",
        },
      ],
      boughtForOthers: [],
    })
  );
  await covered.allReady;
  coveredDocument = pageOf(await new Response(covered).text());
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const openHistory = async () => {
  if (!browser) throw new Error("Chromium did not start");
  const page = await browser.newPage({ viewport });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom: safeAreaBottom },
  });
  await page.setContent(document);
  return page;
};

const offerBox = async (page: Page) => {
  const box = await page.locator("[data-account-pass-savings]").boundingBox();
  if (!box) throw new Error("The packs and passes offer isn't rendered");
  return box;
};

/** Scrolls whichever element scrolls the page, as a reader's wheel does. */
const scrollBy = async (page: Page, distance: number) => {
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, distance);
  await page.waitForFunction(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(true)))
  );
};

const lastPastRowBottom = async (page: Page) => {
  const row = await page
    .locator('[data-account-reservation-group="past"] tbody tr')
    .last()
    .boundingBox();
  if (!row) throw new Error("The past reservations aren't rendered");
  return row.y + row.height;
};

test.skipIf(!chromiumAvailable)(
  "docks the packs and passes offer above the safe area or the install bar while the list scrolls",
  async () => {
    const page = await openHistory();
    await scrollBy(page, 700);
    // Mid-list: rows continue below the docked offer.
    expect(await lastPastRowBottom(page)).toBeGreaterThan(viewport.height);
    const aboveSafeArea = await offerBox(page);
    expect(aboveSafeArea.y + aboveSafeArea.height).toBeCloseTo(
      viewport.height - safeAreaBottom,
      0
    );

    await page.evaluate(() =>
      window.document.documentElement.style.setProperty(
        "--install-bar-space",
        "72px"
      )
    );
    const aboveInstallBar = await offerBox(page);
    expect(aboveInstallBar.y + aboveInstallBar.height).toBeCloseTo(
      viewport.height - 72,
      0
    );
    await page.close();
  }
);

test.skipIf(!chromiumAvailable)(
  "rests the packs and passes offer below the last past reservation",
  async () => {
    const page = await openHistory();
    await scrollBy(page, 100_000);
    const offer = await offerBox(page);
    expect(offer.y).toBeGreaterThanOrEqual(await lastPastRowBottom(page));
    expect(offer.y + offer.height).toBeLessThan(
      viewport.height - safeAreaBottom
    );
    await page.close();
  }
);

test.skipIf(!chromiumAvailable)(
  "keeps the Past reservations panel's padding unless the offer shows",
  async () => {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport });
    const panelState = () =>
      page
        .locator('[data-account-reservation-group="past"]')
        .evaluate((panel) => {
          const footer = panel.querySelector("[data-footer-layout]");
          return {
            padding: getComputedStyle(panel).paddingBottom,
            footerShown: footer ? getComputedStyle(footer).display : "none",
          };
        });

    await page.setContent(streamingDocument);
    const streaming = await panelState();
    expect(streamingDocument).toContain("<template");
    expect(streaming.footerShown).toBe("none");
    expect(streaming.padding).not.toBe("0px");

    await page.setContent(document);
    // React swaps the streamed offer into its placeholder after load.
    await page.locator("[data-account-pass-savings]").waitFor();
    const offered = await panelState();
    expect(offered.footerShown).not.toBe("none");
    expect(offered.padding).toBe("0px");

    // Settled without an offer: the panel keeps its padding.
    await page.setContent(coveredDocument);
    await page.waitForFunction(
      () => !window.document.querySelector("template")
    );
    const covered = await panelState();
    expect(covered.footerShown).toBe("none");
    expect(covered.padding).not.toBe("0px");
    await page.close();
  }
);
