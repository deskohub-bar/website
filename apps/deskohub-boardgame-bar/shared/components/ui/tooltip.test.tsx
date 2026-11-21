import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "@playwright/test";

const chromiumAvailable = existsSync(chromium.executablePath());
if (!chromiumAvailable && process.env.CI) {
  throw new Error("Install Playwright Chromium before running the Bar tests.");
}

const url = "http://tooltip.test";
const frame =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script>globalThis.process = { env: { NODE_ENV: "production" } }</script><div id="root"></div><script src="/fixture.js"></script>';
let browser: Browser;
let script: string;

async function openFixture(page: Page, query = "") {
  await page.goto(`${url}/${query}`);
  await page.getByRole("button", { name: "Info" }).waitFor();
}

function tooltipTest(
  name: string,
  run: (page: Page) => Promise<void>,
  hasTouch = false
) {
  test.skipIf(!chromiumAvailable)(name, async () => {
    const context = await browser.newContext({
      hasTouch,
      isMobile: hasTouch,
      viewport: { width: 600, height: 550 },
    });
    try {
      await context.route("**/*", async (route) => {
        switch (route.request().url().split("?")[0]) {
          case `${url}/`:
            await route.fulfill({ body: frame, contentType: "text/html" });
            break;
          case `${url}/fixture.js`:
            await route.fulfill({
              body: script,
              contentType: "text/javascript",
            });
            break;
          default:
            await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(1500);
      const pageErrors: Error[] = [];
      page.on("pageerror", (error) => pageErrors.push(error));
      await openFixture(page);
      await run(page);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

const trigger = (page: Page) => page.getByRole("button", { name: "Info" });

function hintIsVisible(page: Page, visible: boolean) {
  return page
    .getByRole("tooltip")
    .waitFor({ state: visible ? "visible" : "hidden" });
}

async function focusTrigger(page: Page) {
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(
    await trigger(page).evaluate((button) => button.matches(":focus"))
  ).toBe(true);
}

async function cancelTouch(page: Page) {
  const bounds = await trigger(page).boundingBox();
  if (!bounds) throw new Error("The tooltip trigger must be visible.");
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}

describe("Tooltip", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) return;
    const bundle = await Bun.build({
      entrypoints: [
        new URL("./tooltip.test-fixture.tsx", import.meta.url).pathname,
      ],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const [output] = bundle.outputs;
    if (!output)
      throw new AggregateError(
        bundle.logs,
        "Tooltip fixture failed to bundle."
      );
    script = await output.text();
    browser = await chromium.launch({ channel: "chromium" });
  });

  afterAll(async () => {
    await browser?.close();
  });

  tooltipTest(
    "starts closed unless opened by default or by its owner",
    async (page) => {
      await hintIsVisible(page, false);
      await openFixture(page, "?defaultOpen");
      await hintIsVisible(page, true);
      await openFixture(page, "?controlled&defaultOpen");
      await hintIsVisible(page, false);
      await openFixture(page, "?controlled&open");
      await hintIsVisible(page, true);
    }
  );

  tooltipTest(
    "opens on hover and closes when the pointer moves away or clicks",
    async (page) => {
      await trigger(page).hover();
      await hintIsVisible(page, true);
      await page.getByRole("button", { name: "Outside" }).hover();
      await hintIsVisible(page, false);
      await trigger(page).hover();
      await hintIsVisible(page, true);
      await trigger(page).click();
      await hintIsVisible(page, false);
    }
  );

  tooltipTest(
    "a mouse click before the hover delay leaves it closed",
    async (page) => {
      await page.clock.install();
      await trigger(page).click();
      await page.clock.runFor(250);
      await hintIsVisible(page, false);
      expect(await page.getByTestId("changes").textContent()).toBe("[]");
    }
  );

  tooltipTest(
    "focus shows the described hint and Escape leaves focus on the button",
    async (page) => {
      const describedBy = await trigger(page).getAttribute("aria-describedby");
      const hiddenHint = page.getByRole("tooltip", { includeHidden: true });
      expect(describedBy).toBe(await hiddenHint.getAttribute("id"));
      expect(await hiddenHint.textContent()).toBe("Test hint");

      await focusTrigger(page);
      await hintIsVisible(page, true);
      await page.keyboard.press("Escape");
      await hintIsVisible(page, false);
      expect(
        await trigger(page).evaluate((button) => button.matches(":focus"))
      ).toBe(true);
    }
  );

  tooltipTest(
    "Enter closes a focused hint and a second Enter leaves it closed",
    async (page) => {
      await focusTrigger(page);
      await hintIsVisible(page, true);
      await page.keyboard.press("Enter");
      await hintIsVisible(page, false);
      await page.keyboard.press("Enter");
      await hintIsVisible(page, false);
      expect(await page.getByTestId("changes").textContent()).toBe(
        "[true,false]"
      );
    }
  );

  tooltipTest(
    "two taps report one open and one close",
    async (page) => {
      await trigger(page).tap();
      await hintIsVisible(page, true);
      expect(await page.getByTestId("changes").textContent()).toBe("[true]");
      await trigger(page).tap();
      await hintIsVisible(page, false);
      expect(await page.getByTestId("changes").textContent()).toBe(
        "[true,false]"
      );
    },
    true
  );

  tooltipTest(
    "a cancelled touch and a subsequent synthetic click leave the hint closed",
    async (page) => {
      await cancelTouch(page);
      await hintIsVisible(page, false);
      await trigger(page).evaluate((button) => {
        button.dispatchEvent(
          new PointerEvent("click", {
            bubbles: true,
            detail: 1,
            pointerType: "touch",
          })
        );
      });
      await hintIsVisible(page, false);
      expect(await page.getByTestId("changes").textContent()).toBe("[]");
      await trigger(page).tap();
      await hintIsVisible(page, true);
    },
    true
  );

  tooltipTest(
    "an outside tap, Escape, and scrolling each dismiss an open hint",
    async (page) => {
      await trigger(page).tap();
      await hintIsVisible(page, true);
      await page.getByRole("button", { name: "Outside" }).tap();
      await hintIsVisible(page, false);
      await trigger(page).tap();
      await hintIsVisible(page, true);
      await page.keyboard.press("Escape");
      await hintIsVisible(page, false);
      await trigger(page).tap();
      await hintIsVisible(page, true);
      await page.evaluate(() => window.scrollBy(0, 200));
      await hintIsVisible(page, false);
    },
    true
  );

  tooltipTest(
    "an outside touch dismisses the hint even without a click",
    async (page) => {
      await trigger(page).tap();
      await hintIsVisible(page, true);
      const outside = page.getByTestId("blank-space");
      await outside.evaluate((element) => {
        element.addEventListener(
          "touchend",
          (event) => event.preventDefault(),
          {
            once: true,
            passive: false,
          }
        );
      });
      const bounds = await outside.boundingBox();
      if (!bounds) throw new Error("The outside tap target must be visible.");
      await page.touchscreen.tap(bounds.x + 12, bounds.y + 12);
      await hintIsVisible(page, false);
      expect(await outside.getAttribute("data-clicked")).toBeNull();
    },
    true
  );

  tooltipTest(
    "a controlled owner can accept a change asynchronously",
    async (page) => {
      await openFixture(page, "?controlled");
      await trigger(page).tap();
      await hintIsVisible(page, true);
      await page.getByRole("button", { name: "Outside" }).tap();
      await hintIsVisible(page, false);
    },
    true
  );

  tooltipTest(
    "a controlled owner can ignore a change and set open itself",
    async (page) => {
      await openFixture(page, "?controlled&veto");
      await trigger(page).tap();
      await hintIsVisible(page, false);
      expect(await page.getByTestId("changes").textContent()).toBe("[true]");
      const owner = page.getByRole("button", { name: "Change open" });
      await owner.dispatchEvent("click");
      await hintIsVisible(page, true);
      await owner.dispatchEvent("click");
      await hintIsVisible(page, false);
    },
    true
  );
});
