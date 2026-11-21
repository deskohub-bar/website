import { Effect } from "effect";
import type { E2EBrowserSession } from "../browser-session";
import type { WorkspaceE2EConfig } from "../config";
import { assert } from "../runtime";
import type { CheckoutData } from "../types";
import { readMockHostedPaymentUrl } from "./mock-payment-url";
import { completeNexiHostedPayment } from "./nexi-hosted-payment";
import {
  type HostedPaymentPage,
  waitForReturnedPaymentTabToClose,
} from "./payment";

export const completeHostedPayment = ({
  config,
  data,
  hostedPaymentPage,
  outcome = "approved",
  onNexiAuthorizationRequested,
  session,
}: {
  readonly config: WorkspaceE2EConfig;
  readonly data: CheckoutData;
  readonly hostedPaymentPage: HostedPaymentPage;
  readonly outcome?: "approved" | "declined";
  readonly onNexiAuthorizationRequested?: () => void;
  readonly session: E2EBrowserSession;
}) => {
  const { baseUrl, timeouts } = config;
  if (hostedPaymentPage.provider === "nexi") {
    return completeNexiHostedPayment({
      challengeOutcome: outcome === "approved" ? "authenticated" : "failed",
      data,
      hostedPaymentPage,
      ...(onNexiAuthorizationRequested
        ? { onPaymentAuthorizationRequested: onNexiAuthorizationRequested }
        : {}),
      session,
      timeouts,
    });
  }
  const name =
    outcome === "approved" ? "Approve test payment" : "Decline test payment";
  return session
    .use("submit mock hosted payment", async (page) => {
      assert(
        page === hostedPaymentPage.page &&
          readMockHostedPaymentUrl(page.url(), [baseUrl]),
        "mock payment page must be on the exact preview origin"
      );
      await page
        .getByRole("button", { exact: true, name })
        .click({ timeout: timeouts.browserAction });
    })
    .pipe(
      Effect.andThen(
        waitForReturnedPaymentTabToClose({
          hostedPaymentPage,
          session,
          timeoutMs: timeouts.providerTransition,
        })
      )
    );
};
