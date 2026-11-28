import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "@playwright/test";
import { Effect } from "effect";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { runBrowserStep } from "../case-runner.browser.test-utils";
import { workspaceE2ETimeouts } from "../timeouts";
import {
  leaveNexiPageForMockFallback,
  observeNexiHostedNavigation,
} from "./nexi-hosted-page-ownership";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser;

beforeAll(async () => {
  if (chromiumAvailable) {
    browser = await chromium.launch({
      args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--no-proxy-server"],
      headless: true,
    });
  }
});
afterAll(async () => browser?.close());

const payUrl = "https://workspace.test/en/checkout/pay";
const statusPageUrl = "https://workspace.test/en/reservation/status/synthetic";
const nexiOrigin = "https://xpaysandbox.nexigroup.com";
const hostedUrl = `${nexiOrigin}/hpp/nexi/card?payment=synthetic`;
const errorUrl = `${nexiOrigin}/hpp/nexi/error`;

const retireHostedDocument = (
  kind: "popup" | "same tab",
  denial?: "duplicate tab" | "unmatched session" | "wrong active tab"
) =>
  runBrowserStep({
    browser,
    prepare: (session) =>
      session.use("prepare synthetic payment pages", async (page) => {
        // Intercept every request. No browser traffic leaves the test context.
        await page.context().route("**/*", async (route) => {
          const body =
            route.request().url() === payUrl
              ? `<a href="${hostedUrl}" ${kind === "popup" ? 'target="_blank" rel="noopener"' : ""}>Pay</a>`
              : "Synthetic page";
          await route.fulfill({ body, contentType: "text/html" });
        });
        await page.goto(payUrl);
      }),
    drive: ({ session }) =>
      Effect.gen(function* () {
        const hosted = yield* observeNexiHostedNavigation(
          session,
          Effect.gen(function* () {
            const launch = yield* session.use(
              "launch the synthetic hosted payment",
              async (checkoutPage) => {
                const hostedPage =
                  kind === "popup"
                    ? checkoutPage.context().waitForEvent("page")
                    : Promise.resolve(checkoutPage);
                await checkoutPage.getByRole("link", { name: "Pay" }).click();
                const page = await hostedPage;
                await page.waitForURL(hostedUrl);
                if (page !== checkoutPage)
                  await checkoutPage.goto(statusPageUrl);
                return {
                  checkoutPage,
                  checkoutPageUrl: payUrl,
                  page,
                  provider: "nexi" as const,
                  url: hostedUrl,
                };
              }
            );
            yield* session.activate(launch.page);
            return launch;
          })
        );

        yield* session.use("show the Nexi rejection", async (page) => {
          await page.goto(errorUrl);
          if (denial === "duplicate tab") {
            const duplicate = await page.context().newPage();
            await duplicate.goto(hostedUrl);
          }
        });
        if (denial === "wrong active tab") {
          yield* session.activate(hosted.checkoutPage);
        } else {
          yield* session.activate(hosted.page);
        }
        yield* leaveNexiPageForMockFallback({
          hostedPaymentPage: hosted,
          row: {
            payment_attempt_state: "pending",
            payment_state: "pending",
            provider: "nexi",
            provider_redirect_url:
              denial === "unmatched session"
                ? `${hostedUrl}-unmatched`
                : hostedUrl,
          },
          session,
          statusPageUrl,
          timeouts: workspaceE2ETimeouts,
        });
        return yield* session.use(
          "read the remaining checkout tab",
          async (page) => ({
            oldPopupClosed: hosted.page.isClosed(),
            remainingTabs: page.context().pages().length,
            url: page.url(),
          })
        );
      }),
  });

test.skipIf(!chromiumAvailable).each(["popup", "same tab"] as const)(
  "removes the exact rejected Nexi document from a %s",
  async (kind) => {
    const result = await retireHostedDocument(kind);
    expect(result.failures).toEqual([]);
    expect(result.value).toEqual({
      oldPopupClosed: kind === "popup",
      remainingTabs: 1,
      url: kind === "popup" ? statusPageUrl : "about:blank",
    });
  }
);

test.skipIf(!chromiumAvailable).each([
  ["duplicate tab", "exclusive control"],
  ["unmatched session", "does not match the tracked payment session"],
  ["wrong active tab", "exclusive control"],
] as const)("rejects ownership with a %s", async (denial, message) => {
  const result = await retireHostedDocument("popup", denial);
  expect(result.succeeded).toBe(false);
  expect(result.failures[0]?.message).toContain(message);
});
