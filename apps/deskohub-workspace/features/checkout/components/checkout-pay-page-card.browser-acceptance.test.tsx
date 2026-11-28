import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildCoworkCheckoutSummary } from "@/features/checkout/checkout-quote.test-utils";
import { type Locale, locales } from "@/features/i18n";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";
import {
  CheckoutPayCard,
  CheckoutPayMethodButtons,
  CheckoutPaySubmitButton,
} from "./checkout-pay-page-card";

const appDirectory = resolve(import.meta.dir, "../../..");
// The narrowest supported phone, the widths either side of the label's
// 18rem breakpoint (a 287px and a 288px button), a common phone and a
// desktop.
const viewportWidths = [320, 369, 370, 390, 1280] as const;

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser | undefined;
let appStyles = "";
let wordmarkDataUrl = "";

beforeAll(async () => {
  if (!chromiumAvailable) return;
  const brandFont = await readFile(
    join(appDirectory, "assets/fonts/Sculpin/regular.woff2")
  );
  const wordmark = await readFile(
    join(appDirectory, "public/payment/nexi-wordmark-white.png")
  );
  wordmarkDataUrl = `data:image/png;base64,${wordmark.toString("base64")}`;
  // Production text widths come from the brand font that next/font injects.
  appStyles = `@font-face { font-family: "Sculpin"; font-weight: 400; src: url(data:font/woff2;base64,${brandFont.toString("base64")}) format("woff2"); }
:root { --font-sculpin: "Sculpin"; }
${await compileWorkspaceAppStyles()}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const { total } = buildCoworkCheckoutSummary({
  entryTier: "basic",
  coffee: false,
});
// A six-figure amount, such as a long office booking, lengthens the label.
const largeTotal = { ...total, value: 12_345_650, exponent: 2 };

// The pay card inside the checkout page's gutter, with every label the pay
// button shows: pay, retry, the pending state and a large amount.
const payCardMarkup = (locale: Locale) =>
  renderToStaticMarkup(
    <main className="mx-auto w-full max-w-3xl px-4 sm:px-6">
      <CheckoutPayCard title="Checkout">
        <CheckoutPaySubmitButton locale={locale} total={total} variant="pay" />
        <CheckoutPaySubmitButton
          locale={locale}
          total={total}
          variant="retry"
        />
        <CheckoutPaySubmitButton
          locale={locale}
          pending
          total={total}
          variant="retry"
        />
        <CheckoutPaySubmitButton
          locale={locale}
          total={largeTotal}
          variant="pay"
        />
        <CheckoutPayMethodButtons locale={locale} total={largeTotal} />
      </CheckoutPayCard>
    </main>
  );

test.skipIf(!chromiumAvailable)(
  "keeps the pay button's label and icon inside the button from the narrowest phone up, in every locale",
  async () => {
    if (!browser) throw new Error("The pay card browser has not launched.");
    let sawWrappedLabel = false;
    for (const locale of locales) {
      const page = await browser.newPage();
      try {
        const markup = payCardMarkup(locale).replaceAll(
          "/payment/nexi-wordmark-white.png",
          wordmarkDataUrl
        );
        await page.setContent(
          `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${markup}</body></html>`
        );
        await page.addStyleTag({
          content: `${appStyles}\n* { transition: none !important; }`,
        });
        await page.evaluate(() => document.fonts.ready);
        await page.locator("button img").evaluateAll(async (images) => {
          await Promise.all(
            images.map((image) => {
              if (!(image instanceof HTMLImageElement)) {
                throw new Error("Expected a pay button image");
              }
              return image.decode();
            })
          );
        });
        for (const width of viewportWidths) {
          await page.setViewportSize({ height: 900, width });

          const buttons = await page.$$eval("main button", (elements) =>
            elements.map((button) => {
              const box = button.getBoundingClientRect();
              const style = getComputedStyle(button);
              const content = {
                left: box.left + Number.parseFloat(style.paddingLeft),
                right: box.right - Number.parseFloat(style.paddingRight),
              };
              const label = document.createRange();
              const labelElement = button.querySelector(
                "[data-checkout-pay-label]"
              );
              if (!labelElement) throw new Error("Missing pay button label");
              label.selectNodeContents(labelElement);
              const labelBox = labelElement.getBoundingClientRect();
              const iconElement = button.querySelector("svg, img");
              const icon = iconElement?.getBoundingClientRect();
              let iconCenterFraction = 0.5;
              let iconLeftFraction = 0;
              // Align the visible wordmark, including any transparent margins.
              if (iconElement instanceof HTMLImageElement) {
                const canvas = document.createElement("canvas");
                canvas.width = iconElement.naturalWidth;
                canvas.height = iconElement.naturalHeight;
                const context = canvas.getContext("2d");
                if (!context) throw new Error("Missing wordmark canvas");
                context.drawImage(iconElement, 0, 0);
                const { data } = context.getImageData(
                  0,
                  0,
                  canvas.width,
                  canvas.height
                );
                let left = canvas.width;
                let right = 0;
                for (let i = 3; i < data.length; i += 4) {
                  if (data[i] === 0) continue;
                  const x = ((i - 3) / 4) % canvas.width;
                  left = Math.min(left, x);
                  right = Math.max(right, x + 1);
                }
                iconCenterFraction = (left + right) / (2 * canvas.width);
                iconLeftFraction = left / canvas.width;
              }
              return {
                background: style.backgroundColor,
                height: box.height,
                top: box.top,
                buttonCenterX: (box.left + box.right) / 2,
                payment: button.getAttribute("value"),
                iconWidth: icon?.width,
                iconCenterX:
                  icon && icon.left + icon.width * iconCenterFraction,
                iconLeftX: icon && icon.left + icon.width * iconLeftFraction,
                iconCentered:
                  !!icon &&
                  Math.abs(
                    (icon.top + icon.bottom) / 2 -
                      (labelBox.top + labelBox.bottom) / 2
                  ) <= 0.5,
                wrapped: label.getClientRects().length > 1,
                label: label.getBoundingClientRect(),
                content,
              };
            })
          );

          expect(buttons).toHaveLength(6);
          // The pending button shows no icon.
          const [pay, retry, , largePay, qr, card] = buttons;
          if (!pay || !retry || !largePay || !qr || !card) {
            throw new Error("Missing checkout pay buttons");
          }
          expect(qr.payment).toBe("qr");
          expect(card.payment).toBe("card");
          for (const [button, imageWidth] of [
            [pay, 48],
            [retry, 16],
            [largePay, 48],
            [card, 48],
            [qr, 16],
          ] as const) {
            const { iconCentered, iconWidth, wrapped } = button;
            sawWrappedLabel ||= wrapped;
            expect({ locale, width, iconCentered, iconWidth }).toEqual({
              locale,
              width,
              iconCentered: true,
              iconWidth: imageWidth,
            });
          }
          expect(card.background).toBe("rgb(45, 50, 170)");
          expect(qr.background).toBe(retry.background);
          expect(card.top).toBeGreaterThanOrEqual(qr.top + qr.height);
          expect(
            Math.abs((card.iconCenterX ?? -1) - (qr.iconCenterX ?? -1))
          ).toBeLessThanOrEqual(0.5);
          expect(card.label.left).toBeCloseTo(qr.label.left);
          if (!qr.wrapped && !card.wrapped) {
            const blockLeft = Math.min(card.iconLeftX ?? 0, qr.iconLeftX ?? 0);
            const blockRight = Math.max(card.label.right, qr.label.right);
            const blockCenter = (blockLeft + blockRight) / 2;
            expect(
              Math.abs(blockCenter - card.buttonCenterX)
            ).toBeLessThanOrEqual(6);
          }
          for (const { content, height, label, payment } of buttons) {
            expect(height).toBeGreaterThanOrEqual(48);
            expect({ locale, width, payment, overflow: false }).toEqual({
              locale,
              width,
              payment,
              overflow:
                label.left < content.left - 0.5 ||
                label.right > content.right + 0.5,
            });
          }
        }
      } finally {
        await page.close();
      }
    }
    expect(sawWrappedLabel).toBe(true);
  }
);
