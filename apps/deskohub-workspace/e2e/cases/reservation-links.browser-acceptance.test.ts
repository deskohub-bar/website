import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutSummaryLine } from "@/features/checkout/components/checkout-summary-line";
import { formatDiscountAdjustment } from "@/features/checkout/format-discount-adjustment";
import { m } from "@/features/i18n";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import type { CheckoutData } from "../types";
import {
  isAppliedZeroTotalPaySummary,
  isDiscountListedOnce,
  isSelectedDurationZeroPrice,
  toAppliedZeroTotalPaySummary,
  toDiscountListedOnce,
  toSelectedDurationZeroPrice,
} from "./reservation-links";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser | undefined;
let page: Page | undefined;

beforeAll(async () => {
  if (!chromiumAvailable) return;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

/** Whether the in-page `check` accepts `html` for `arg`. */
const holdsOn = async <Arg>(
  html: string,
  check: (arg: Arg) => boolean,
  arg: Arg
) => {
  if (!page) throw new Error("Chromium is not running");
  await page.setContent(html);
  return page.evaluate(check as (arg: unknown) => boolean, arg);
};

const enData = {
  locale: "en-US",
  meetingRoom: { duration: { unit: "hour", amount: 1 } },
} as CheckoutData;
const csData = {
  locale: "cs-CZ",
  meetingRoom: { duration: { unit: "hour", amount: 1 } },
} as CheckoutData;

const zeroText = (data: CheckoutData) =>
  formatMoney(currencyCZK(0), data.locale);

test.skipIf(!chromiumAvailable)(
  "exact-total check requires exactly one zero total row per locale",
  async () => {
    const summaryLine = (
      label: string,
      locale: CheckoutData["locale"],
      amount = 0
    ) =>
      renderToStaticMarkup(
        createElement(CheckoutSummaryLine, {
          amount: currencyCZK(amount),
          label,
          locale,
        })
      );
    const enTotal = summaryLine("Total to pay", "en-US");
    const en = toAppliedZeroTotalPaySummary(enData);
    const enApplied = `<p>${en.appliedMessage}</p>`;

    expect(await holdsOn(enTotal, isAppliedZeroTotalPaySummary, en)).toBe(
      false
    );
    expect(
      await holdsOn(enTotal + enApplied, isAppliedZeroTotalPaySummary, en)
    ).toBe(true);

    const csApplied = m.checkoutDiscountCodeApplied(
      { discount: "100 %" },
      { locale: "cs-CZ" }
    );
    expect(
      await holdsOn(
        `${summaryLine("Celkem k platbě", "cs-CZ")}<p>${csApplied}</p>`,
        isAppliedZeroTotalPaySummary,
        toAppliedZeroTotalPaySummary(csData)
      )
    ).toBe(true);

    expect(
      await holdsOn(
        summaryLine("Total to pay", "en-US", 100) + enApplied,
        isAppliedZeroTotalPaySummary,
        en
      )
    ).toBe(false);

    expect(
      await holdsOn(
        summaryLine("E2E 100% discount", "en-US") +
          summaryLine("Total to pay", "en-US", 350) +
          enApplied,
        isAppliedZeroTotalPaySummary,
        en
      )
    ).toBe(false);

    expect(
      await holdsOn(
        enTotal + enTotal + enApplied,
        isAppliedZeroTotalPaySummary,
        en
      )
    ).toBe(false);
  }
);

const tooltip = (items: readonly string[]) => `
  <button data-checkout-discount-details aria-describedby="discount-details">details</button>
  <div id="discount-details"><ul>${items
    .map((item) => `<li>${item}</li>`)
    .join("")}</ul></div>`;

test.skipIf(!chromiumAvailable)(
  "discount-listed-once check counts the fixture label exactly once",
  async () => {
    const expected = toDiscountListedOnce({
      adjustmentText: "100%",
      label: "e2e 100% discount",
    });

    expect(
      await holdsOn(
        tooltip(["E2E Calendar sale 20%", "E2E 100% discount 100%"]),
        isDiscountListedOnce,
        expected
      )
    ).toBe(true);

    expect(
      await holdsOn(
        tooltip(["E2E 100% discount 100%", "E2E 100% discount 100%"]),
        isDiscountListedOnce,
        expected
      )
    ).toBe(false);

    expect(
      await holdsOn(
        tooltip(["E2E Calendar sale 20%"]),
        isDiscountListedOnce,
        expected
      )
    ).toBe(false);

    expect(
      await holdsOn(
        "<ul><li>E2E 100% discount 100%</li></ul>",
        isDiscountListedOnce,
        expected
      )
    ).toBe(false);
  }
);

test.skipIf(!chromiumAvailable)(
  "czech discount-listed-once check tolerates the localized NBSP percent",
  async () => {
    // Use the actual formatter output: cs-CZ emits "100 %" with a
    // non-breaking space, which must match after normalization.
    const adjustmentText = formatDiscountAdjustment(
      { kind: "percentage", basisPoints: 10_000 },
      "cs-CZ"
    );
    expect(adjustmentText).toMatch(/^100[\s ]?%$/);
    const expected = toDiscountListedOnce({
      adjustmentText,
      label: "E2E sleva 100 %",
    });
    const item = (adjustment: string) => `E2E sleva 100 % ${adjustment}`;

    expect(
      await holdsOn(
        tooltip(["E2E kalendářová sleva 20%", item(adjustmentText)]),
        isDiscountListedOnce,
        expected
      )
    ).toBe(true);

    expect(
      await holdsOn(
        tooltip([item(adjustmentText), item(adjustmentText)]),
        isDiscountListedOnce,
        expected
      )
    ).toBe(false);
  }
);

test.skipIf(!chromiumAvailable)(
  "selected-duration check demands the exact discounted zero price",
  async () => {
    const option = (discounted: string, visible: string, original?: string) => `
    <div data-reservation-type-option="hour:1">
      ${original ? `<del aria-hidden="true">${original}</del>` : ""}
      <span class="sr-only">Discounted price: ${discounted}</span>
      <span><span aria-hidden="true">${visible}</span></span>
    </div>`;
    const en = toSelectedDurationZeroPrice(enData);

    expect(
      await holdsOn(
        option(zeroText(enData), zeroText(enData), "CZK 350"),
        isSelectedDurationZeroPrice,
        en
      )
    ).toBe(true);

    expect(
      await holdsOn(
        option("CZK 350", "CZK 350"),
        isSelectedDurationZeroPrice,
        en
      )
    ).toBe(false);

    expect(
      await holdsOn(
        option(zeroText(enData), "CZK 350", "CZK 350"),
        isSelectedDurationZeroPrice,
        en
      )
    ).toBe(false);

    const csOption = `
    <div data-reservation-type-option="hour:1">
      <del aria-hidden="true">350 Kč</del>
      <span class="sr-only">${m.checkoutSummaryDiscountedPrice(
        { price: "0 Kč" },
        { locale: "cs-CZ" }
      )}</span>
      <span><span aria-hidden="true">0 Kč</span></span>
    </div>`;
    expect(
      await holdsOn(
        csOption,
        isSelectedDurationZeroPrice,
        toSelectedDurationZeroPrice(csData)
      )
    ).toBe(true);
  }
);
