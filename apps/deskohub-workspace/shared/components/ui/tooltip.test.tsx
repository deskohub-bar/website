import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Browser,
  chromium,
  expect as expectPage,
  type Page,
} from "@playwright/test";
import { m } from "@/features/i18n";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";

const browserAvailable = await playwrightChromiumAvailable();
const frame =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script>globalThis.process = { env: { NODE_ENV: "production" } }</script><div id="root"></div><script src="/fixture.js"></script>';
let browser: Browser;
let script: string;

function tooltipTest(
  name: string,
  run: (page: Page) => Promise<void>,
  hasTouch = false
) {
  test.skipIf(!browserAvailable)(name, async () => {
    const context = await browser.newContext({
      hasTouch,
      isMobile: hasTouch,
      viewport: { width: 600, height: 550 },
    });
    try {
      await context.route("http://tooltip.test/", (route) =>
        route.fulfill({ body: frame, contentType: "text/html" })
      );
      await context.route("http://tooltip.test/fixture.js", (route) =>
        route.fulfill({ body: script, contentType: "text/javascript" })
      );
      const page = await context.newPage();
      const pageErrors: Error[] = [];
      page.on("pageerror", (error) => pageErrors.push(error));
      await page.goto("http://tooltip.test/");
      await run(page);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

describe("Workspace tooltips", () => {
  beforeAll(async () => {
    if (!browserAvailable) return;
    const build = await Bun.build({
      entrypoints: [
        new URL("./tooltip.test-fixture.tsx", import.meta.url).pathname,
      ],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const output = build.outputs[0];
    if (!output) throw new Error("The tooltip fixture did not build.");
    script = await output.text();
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  tooltipTest(
    "tab focuses the checkout discount button and shows the offer",
    async (page) => {
      const hint = page.getByRole("tooltip");
      await expectPage(hint).toBeHidden();
      await page.getByRole("button", { name: "Insert value" }).focus();
      await page.keyboard.press("Tab");
      const discount = page.getByRole("button", {
        name: m.checkoutSummaryDiscountDetailsTrigger(
          { product: "Reserved Desk" },
          { locale: "en-US" }
        ),
      });
      await expectPage(discount).toBeFocused();
      await expectPage(hint.getByText("Summer sale")).toBeVisible();
      await page.keyboard.press("Escape");
      await expectPage(hint).toBeHidden();
      await expectPage(discount).toBeFocused();
    }
  );

  tooltipTest(
    "touch toggles the hint and still runs a composed control",
    async (page) => {
      const toggle = page.getByRole("button", { name: "Format" });
      const hint = page.getByRole("tooltip");
      await toggle.tap();
      await expectPage(toggle).toHaveAttribute("aria-pressed", "true");
      await expectPage(hint).toHaveText("Formatting hint");
      await toggle.tap();
      await expectPage(toggle).toHaveAttribute("aria-pressed", "false");
      await expectPage(hint).toBeHidden();
      await toggle.tap();
      await expectPage(hint).toBeVisible();
      await page.getByTestId("outside").tap({ position: { x: 10, y: 10 } });
      await expectPage(hint).toBeHidden();
    },
    true
  );

  tooltipTest(
    "a touch tap still submits a form from a tooltip trigger",
    async (page) => {
      await page.getByRole("button", { name: "Submit action" }).tap();
      await expectPage(page.getByLabel("Submissions")).toHaveText("1");
      await expectPage(page.getByRole("tooltip")).toHaveText("Submit hint");
    },
    true
  );

  tooltipTest(
    "touch and keyboard can open editor popovers and menus through their hints",
    async (page) => {
      const popoverTrigger = page.getByRole("button", { name: "Edit link" });
      await popoverTrigger.tap();
      await expectPage(
        page.getByRole("textbox", { name: "Link address" })
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expectPage(popoverTrigger).toBeFocused();

      const menuTrigger = page.getByRole("button", { name: "Insert value" });
      await menuTrigger.focus();
      await page.keyboard.press("ArrowDown");
      const menuItem = page.getByRole("menuitem", { name: "Customer name" });
      await expectPage(menuItem).toBeFocused();
      await page.keyboard.press("Enter");
      await expectPage(menuItem).toBeHidden();
      await expectPage(menuTrigger).toBeFocused();
    },
    true
  );

  tooltipTest(
    "mouse hover works after a touchscreen tap on the same control",
    async (page) => {
      const trigger = page.getByRole("button", { name: "Format" });
      const hint = page.getByRole("tooltip");
      await trigger.tap();
      await expectPage(hint).toBeVisible();
      await page.getByTestId("outside").tap({ position: { x: 10, y: 10 } });
      await expectPage(hint).toBeHidden();
      await trigger.hover();
      await expectPage(hint).toBeVisible();
    },
    true
  );

  tooltipTest(
    "keyboard can read a localized hint for a disabled action",
    async (page) => {
      const wrapper = page.getByRole("group", { name: "Unavailable action" });
      const child = wrapper.getByRole("button", { name: "Unavailable action" });
      const hint = page.getByRole("tooltip");
      await expectPage(child).toBeDisabled();
      await page.getByRole("button", { name: "Submit action" }).focus();
      await page.keyboard.press("Tab");
      await expectPage(wrapper).toBeFocused();
      await expectPage(hint).toHaveText(
        m.account_future_feature_tooltip({}, { locale: "cs-CZ" })
      );
      await expectPage(wrapper).toHaveAccessibleDescription(
        await hint.innerText()
      );
      await page.keyboard.press("Escape");
      await expectPage(hint).toBeHidden();
      await expectPage(wrapper).toBeFocused();
    }
  );
});
