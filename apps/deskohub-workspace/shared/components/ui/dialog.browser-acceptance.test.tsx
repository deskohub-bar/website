import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Browser,
  chromium,
  expect as expectInBrowser,
  type Page,
} from "@playwright/test";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser | undefined;
let appStyles = "";
let harness = "";

beforeAll(async () => {
  if (!chromiumAvailable) return;
  const [bundle, styles] = await Promise.all([
    Bun.build({
      entrypoints: [join(import.meta.dir, "dialog.browser-harness.tsx")],
      target: "browser",
    }),
    compileWorkspaceAppStyles(),
  ]);
  const [script] = bundle.outputs;
  if (!script) throw new Error("The dialog browser harness failed to build.");
  harness = await script.text();
  appStyles = styles;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const withPage = async (check: (page: Page) => Promise<void>) => {
  if (!browser) throw new Error("The dialog browser has not been launched.");
  const page = await browser.newPage({
    viewport: { width: 1896, height: 1212 },
  });
  try {
    await page.setContent('<!doctype html><div id="root"></div>');
    await page.addStyleTag({ content: appStyles });
    await page.addScriptTag({ content: harness, type: "module" });
    await check(page);
  } finally {
    await page.close();
  }
};

test.skipIf(!chromiumAvailable)(
  "the dialog and backdrop stay transparent when the exit animation finishes",
  async () => {
    await withPage(async (page) => {
      const trigger = page.getByRole("button", { name: "Open dialog" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Reservation dialog" });
      const exitOpacity = await dialog.evaluate(async (panel) => {
        const backdrop = panel.previousElementSibling;
        if (!backdrop) throw new Error("The dialog backdrop is missing.");
        const closeButton = panel.querySelector("button");
        if (!closeButton) throw new Error("The close button is missing.");

        const closed = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (panel.getAttribute("data-state") === "closed") {
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(panel, { attributeFilter: ["data-state"] });
        });
        closeButton.click();
        await closed;

        return [panel, backdrop].map((element) => {
          const [exit] = element.getAnimations();
          if (!exit?.effect) throw new Error("The exit animation is missing.");
          const { endTime } = exit.effect.getComputedTiming();
          // Sample the endpoint before Radix handles animationend and unmounts.
          exit.pause();
          exit.currentTime = endTime / 2;
          const midpoint = Number(getComputedStyle(element).opacity);
          exit.currentTime = endTime;
          const end = Number(getComputedStyle(element).opacity);
          exit.currentTime = endTime / 2;
          exit.play();
          return { midpoint, end };
        });
      });
      for (const { midpoint, end } of exitOpacity) {
        expect(midpoint).toBeGreaterThan(0);
        expect(midpoint).toBeLessThan(1);
        expect(end).toBe(0);
      }
      await expectInBrowser(dialog).toHaveCount(0);
      await expectInBrowser(trigger).toBeFocused();
    });
  }
);

test.skipIf(!chromiumAvailable)(
  "dialog and sheet close controls are muted round icons",
  async () => {
    await withPage(async (page) => {
      const muted = await page.evaluate(() => {
        const reference = document.createElement("span");
        reference.style.color =
          "color-mix(in oklab, var(--brand-navy-blue) 60%, transparent)";
        document.body.append(reference);
        const color = getComputedStyle(reference).color;
        reference.remove();
        return color;
      });
      for (const surface of ["dialog", "sheet"]) {
        await page.getByRole("button", { name: `Open ${surface}` }).click();
        const panel = page.getByRole("dialog", {
          name: `Reservation ${surface}`,
        });
        const close = panel.getByRole("button", { name: "Close", exact: true });
        const style = await close.evaluate((node) => {
          const computed = getComputedStyle(node);
          return {
            background: computed.backgroundColor,
            color: computed.color,
            height: computed.height,
            radius: Number.parseFloat(computed.borderTopLeftRadius),
            shadow: computed.boxShadow,
            width: computed.width,
          };
        });
        expect(style).toMatchObject({
          background: "rgba(0, 0, 0, 0)",
          color: muted,
          height: "32px",
          shadow: "none",
          width: "32px",
        });
        expect(style.radius).toBeGreaterThanOrEqual(16);
        await page.keyboard.press("Escape");
        await expectInBrowser(panel).toHaveCount(0);
      }
    });
  }
);
