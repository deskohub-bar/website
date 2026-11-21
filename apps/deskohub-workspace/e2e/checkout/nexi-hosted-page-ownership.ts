import { ok as assert } from "node:assert/strict";
import type { Page, Request } from "@playwright/test";
import { Effect } from "effect";
import type { E2EBrowserSession } from "../browser-session";
import type { WorkspaceE2EError } from "../errors";
import type { HostedProviderSessionRow } from "../integrations/database";
import { parseUrl } from "../runtime";
import type { WorkspaceE2ETimeouts } from "../timeouts";
import type { HostedPaymentPage } from "./payment";

export type NexiHostedNavigation = {
  readonly documentUrl: string;
  readonly requestUrls: ReadonlySet<string>;
};

// The new context starts with a single checkout tab. Observe top-level
// navigation across the Pay action, including server redirects and popups
// whose opener the app deliberately clears.
export const observeNexiHostedNavigation = (
  session: E2EBrowserSession,
  launch: Effect.Effect<HostedPaymentPage, WorkspaceE2EError>
) =>
  Effect.acquireUseRelease(
    session.use("observe hosted payment navigation", async (checkoutPage) => {
      const context = checkoutPage.context();
      if (context.pages().length !== 1) return undefined;
      const requests: Request[] = [];
      const record = (request: Request) => {
        if (request.isNavigationRequest()) requests.push(request);
      };
      context.on("request", record);
      return { checkoutPage, context, record, requests };
    }),
    Effect.fnUntraced(function* (observation) {
      const hosted = yield* launch;
      if (!observation || hosted.checkoutPage !== observation.checkoutPage) {
        return hosted;
      }
      return yield* session.use(
        "bind hosted payment navigation",
        async (active) => {
          if (
            active !== hosted.page ||
            active.context() !== observation.context
          ) {
            return hosted;
          }
          const documentUrl = active.url();
          const request = observation.requests.findLast(
            (value) =>
              value.url() === documentUrl && belongsToMainFrame(value, active)
          );
          if (!request) return hosted;

          const requestUrls = new Set<string>();
          for (
            let value: Request | null = request;
            value;
            value = value.redirectedFrom()
          ) {
            requestUrls.add(value.url());
          }
          return { ...hosted, nexiNavigation: { documentUrl, requestUrls } };
        }
      );
    }),
    (observation) =>
      Effect.sync(() => {
        observation?.context.off("request", observation.record);
      })
  );

const belongsToMainFrame = (request: Request, page: Page) => {
  try {
    return request.frame() === page.mainFrame();
  } catch {
    // Playwright has no frame for some requests issued before a page exists.
    return false;
  }
};

/** Removes the exact hosted document from this case's browser before retirement. */
export const leaveNexiPageForMockFallback = ({
  hostedPaymentPage: { checkoutPage, nexiNavigation, page, provider },
  row,
  session,
  statusPageUrl,
  timeouts,
}: {
  readonly hostedPaymentPage: HostedPaymentPage;
  readonly row: HostedProviderSessionRow;
  readonly session: E2EBrowserSession;
  readonly statusPageUrl: string;
  readonly timeouts: Pick<WorkspaceE2ETimeouts, "browserAction">;
}) =>
  session
    .use(
      "isolate rejected Nexi payment before mock fallback",
      async (active) => {
        const context = checkoutPage.context();
        const pages = context.pages();
        const initialDocument =
          nexiNavigation && parseUrl(nexiNavigation.documentUrl);
        const currentDocument = parseUrl(page.url());
        const expectedStatus = new URL(statusPageUrl);
        const checkoutDocument = parseUrl(checkoutPage.url());
        assert(
          provider === "nexi" &&
            row.provider === "nexi" &&
            row.payment_attempt_state === "pending" &&
            row.payment_state === "pending" &&
            nexiNavigation?.requestUrls.has(row.provider_redirect_url) &&
            initialDocument?.origin === "https://xpaysandbox.nexigroup.com" &&
            currentDocument?.origin === initialDocument.origin &&
            (currentDocument.href === initialDocument.href ||
              currentDocument.pathname === "/hpp/nexi/error"),
          "the rejected Nexi document does not match the tracked payment session"
        );
        assert(
          active === page &&
            pages.includes(page) &&
            pages.includes(checkoutPage) &&
            (page === checkoutPage
              ? pages.length === 1
              : pages.length === 2 &&
                checkoutDocument?.origin === expectedStatus.origin &&
                checkoutDocument.pathname === expectedStatus.pathname),
          "the case does not have exclusive control of the rejected Nexi tab"
        );

        if (page === checkoutPage) {
          await page.goto("about:blank", {
            timeout: timeouts.browserAction,
            waitUntil: "commit",
          });
          assert(
            page.url() === "about:blank",
            "the rejected Nexi document is still open"
          );
        } else {
          await page.close();
          assert(page.isClosed(), "the rejected Nexi tab is still open");
        }
        const remainingPages = context.pages();
        assert(
          remainingPages.length === 1 &&
            remainingPages[0] === checkoutPage &&
            parseUrl(checkoutPage.url())?.origin !== initialDocument.origin,
          "the case still has a payable Nexi tab"
        );
      },
      { timeoutMs: timeouts.browserAction }
    )
    .pipe(Effect.andThen(session.activate(checkoutPage)));
