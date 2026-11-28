import type { Locator, Page } from "@playwright/test";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import {
  activateHydratedElement,
  openPage,
  readActivePage,
  readPageUrl,
  summarizeCheckoutPage,
  waitForPageUrl,
  waitForReactHydration,
} from "../browser";
import type { E2EBrowserSession } from "../browser-session";
import type { WorkspaceE2EConfig } from "../config";
import { type E2EPaymentProvider, initialE2EPaymentProvider } from "../e2e-env";
import {
  failWorkspaceE2E,
  toWorkspaceE2EError,
  tryWorkspaceE2ESync,
  type WorkspaceE2EError,
  withoutWorkspaceE2ETimeout,
} from "../errors";
import { pollUntil } from "../polling";
import { addRedaction, redact } from "../redaction";
import {
  recordCheckoutIntent,
  recordReservationResult,
} from "../reservation-intents";
import { assert, log, parseUrl } from "../runtime";
import {
  type WorkspaceE2ETimeouts,
  workspaceE2EPollIntervalMs,
} from "../timeouts";
import type { CheckoutData } from "../types";
import { isExpectedCheckoutStatusUrl } from "../urls";
import {
  addMockPaymentUrlRedactions,
  readMockHostedPaymentUrl,
} from "./mock-payment-url";
import type { NexiHostedNavigation } from "./nexi-hosted-page-ownership";
import {
  prepareReservationForm,
  type ReservationFormPreparation,
  type ReservationPreparationState,
  readReservationPreparationState,
  reservationPreparationStateSchema,
} from "./reservation-form-preparation";

const reservationStartRetryableErrorMessages = [
  "Checkout could not be started.",
  "Platbu se nepodařilo spustit.",
] as const;
const reservationSubmitAttemptCount = 2;
const reservationContinueSelector = "#reservation-continue";
const reservationSubmitSelector = "#reservation-submit";
// The form's one action button: Continue on the selection step, submit on
// the contact step.
const reservationActionSelector = `${reservationContinueSelector}, ${reservationSubmitSelector}`;
const reservationPreparationStateKey = "__deskohubWorkspaceE2EPreparation";
// The bound of each evaluation that reads page state while a wait polls it.
const pageReadTimeoutMs = 30_000;
const decodeWorkspaceReservationId = Schema.decodeUnknownSync(
  workspaceReservationIdSchema
);
const isReservationPreparationState = Schema.is(
  reservationPreparationStateSchema
);

export const prepareCheckoutPaymentAttempt = ({
  config,
  data,
  onOrderId,
  preparation,
  session,
}: {
  config: WorkspaceE2EConfig;
  data: CheckoutData;
  onOrderId?: (orderId: WorkspaceReservationId) => void;
  preparation: ReservationFormPreparation;
  session: E2EBrowserSession;
}): Effect.Effect<WorkspaceReservationId, WorkspaceE2EError> =>
  Effect.gen(function* () {
    yield* openPage(session, config, data.checkoutUrl, {
      timeoutMs: config.timeouts.browserNavigation,
    });
    return yield* submitReservationForPayPage({
      data,
      onOrderId,
      preparation,
      session,
      timeouts: config.timeouts,
    });
  });

export const submitReservationForPayPage = ({
  data,
  onOrderId,
  preparation,
  session,
  timeouts,
}: {
  data: CheckoutData;
  onOrderId?: (orderId: WorkspaceReservationId) => void;
  preparation: ReservationFormPreparation;
  session: E2EBrowserSession;
  timeouts: WorkspaceE2ETimeouts;
}): Effect.Effect<WorkspaceReservationId, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const intent = yield* recordCheckoutIntent(data);
    const payPageUrl = yield* submitReservationAndWaitForPayPage({
      onOrderId,
      preparation,
      session,
      timeouts,
    });
    const orderId = yield* readPayPageOrderIdFrom({
      onOrderId,
      payPageUrl,
      session,
    });
    yield* recordReservationResult(intent, { orderId });
    return orderId;
  });

/**
 * Waits for a reservation page that continues to the checkout pay page on
 * its own, without a submit from the runner, and reads the started order id.
 * The reservation a signed-out customer verified the email for does this
 * once the sign-in lands back on it.
 */
export const waitForReservationPayPage = ({
  onOrderId,
  session,
  timeouts,
}: {
  readonly onOrderId?: (orderId: WorkspaceReservationId) => void;
  readonly session: E2EBrowserSession;
  readonly timeouts: WorkspaceE2ETimeouts;
}): Effect.Effect<WorkspaceReservationId, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const result = yield* waitForReservationStart(
      session,
      timeouts.checkoutStart
    );
    const payPageUrl = yield* requireReservationPayPage(result, {
      onOrderId,
      retryableErrorMessage: "Checkout reservation preparation failed",
    });
    return yield* readPayPageOrderIdFrom({ onOrderId, payPageUrl, session });
  });

const readPayPageOrderIdFrom = ({
  onOrderId,
  payPageUrl,
  session,
}: {
  readonly onOrderId?: (orderId: WorkspaceReservationId) => void;
  readonly payPageUrl: string;
  readonly session: E2EBrowserSession;
}): Effect.Effect<WorkspaceReservationId, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const searchOrderId = yield* tryWorkspaceE2ESync(
      "decode checkout pay page order id",
      () => {
        const value = getSearchOrderId(payPageUrl);
        return value ? decodeWorkspaceReservationId(value) : undefined;
      }
    );
    const orderId = searchOrderId ?? (yield* readPayPageOrderId(session));
    yield* Effect.sync(() => onOrderId?.(orderId));
    return orderId;
  });

/** The first reservation id in the pay page's text. Runs in the browser. */
const findPayPageOrderId = () => {
  const idPattern =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = (document.body?.innerText ?? "").match(idPattern);
  return match?.[0] ?? "";
};

// An overrunning read fails rather than timing out.
const readPayPageOrderId = (
  session: E2EBrowserSession
): Effect.Effect<WorkspaceReservationId, WorkspaceE2EError> =>
  session
    .evaluate("read pay page order id", findPayPageOrderId, undefined, {
      timeoutMs: pageReadTimeoutMs,
    })
    .pipe(
      withoutWorkspaceE2ETimeout("read pay page order id"),
      Effect.flatMap((text) =>
        tryWorkspaceE2ESync("assert pay page order id", () => {
          const orderId = redact(text).trim();
          assert(orderId, "checkout pay page order id missing");
          return decodeWorkspaceReservationId(orderId);
        })
      )
    );

const submitReservationAndWaitForPayPage = ({
  onOrderId,
  preparation,
  session,
  timeouts,
}: {
  onOrderId?: (orderId: WorkspaceReservationId) => void;
  preparation: ReservationFormPreparation;
  session: E2EBrowserSession;
  timeouts: WorkspaceE2ETimeouts;
}): Effect.Effect<string, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const timeoutMs = timeouts.checkoutStart;
    const submitAttempt = (
      attempt: number
    ): Effect.Effect<ReservationStartResult, WorkspaceE2EError> =>
      Effect.gen(function* () {
        yield* prepareReservationSelection({
          preparation,
          session,
          timeoutMs,
          timeouts,
        });
        // The same preparation fills the contact step once Continue opens it.
        if (yield* isReservationSelectionStep(session, timeouts)) {
          yield* continueToReservationContactStep({ session, timeouts });
          yield* prepareReservationSelection({
            preparation,
            session,
            timeoutMs,
            timeouts,
          });
        }
        yield* activateHydratedElement(session, reservationSubmitSelector, {
          timeoutMs: timeouts.browserAction,
        });

        const result = yield* waitForReservationStart(session, timeoutMs);
        if (
          result.status !== "retryable_error" ||
          attempt >= reservationSubmitAttemptCount
        ) {
          return result;
        }

        log(
          "Checkout reservation preparation returned a transient error; retrying once with the same checkout attempt"
        );
        return yield* submitAttempt(attempt + 1);
      });

    const result = yield* submitAttempt(1);
    return yield* requireReservationPayPage(result, {
      onOrderId,
      retryableErrorMessage:
        "Checkout reservation preparation failed after one retry",
    });
  });

/**
 * The pay page URL a reservation start reached. A start that did not reach
 * it still reports any order id its URL carries, so cleanup releases the
 * hold, and fails with the browser diagnostics.
 */
const requireReservationPayPage = (
  result: ReservationStartResult,
  {
    onOrderId,
    retryableErrorMessage,
  }: {
    readonly onOrderId?: (orderId: WorkspaceReservationId) => void;
    readonly retryableErrorMessage: string;
  }
): Effect.Effect<string, WorkspaceE2EError> =>
  Effect.gen(function* () {
    if (result.status === "ready") return result.url;

    const orderId = yield* tryWorkspaceE2ESync(
      "decode failed checkout reservation order id",
      () => {
        const value = getSearchOrderId(result.url);
        return value ? decodeWorkspaceReservationId(value) : undefined;
      }
    );
    if (orderId) yield* Effect.sync(() => onOrderId?.(orderId));

    return yield* tryWorkspaceE2ESync(
      "assert checkout pay page reached",
      () => {
        throw new Error(
          [
            result.status === "retryable_error"
              ? retryableErrorMessage
              : "Timed out waiting for checkout pay page",
            result.diagnostics
              ? `Browser diagnostics:\n${result.diagnostics}`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n")
        );
      }
    );
  });

const hasElement = (selector: string) =>
  document.querySelector(selector) !== null;

const isReservationSelectionStep = (
  session: E2EBrowserSession,
  timeouts: WorkspaceE2ETimeouts
): Effect.Effect<boolean, WorkspaceE2EError> =>
  session
    .evaluate(
      "read reservation checkout step",
      hasElement,
      reservationContinueSelector,
      { timeoutMs: timeouts.browserAction }
    )
    .pipe(withoutWorkspaceE2ETimeout("read reservation checkout step"));

/**
 * Activates the selection step's Continue natively and waits for the
 * hydrated contact step. Continue changes only the URL's `step`, so the
 * page keeps its selection and nothing is submitted.
 */
export const continueToReservationContactStep = ({
  session,
  timeouts,
}: {
  readonly session: E2EBrowserSession;
  readonly timeouts: WorkspaceE2ETimeouts;
}): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    yield* activateHydratedElement(session, reservationContinueSelector, {
      timeoutMs: timeouts.browserAction,
    });
    yield* waitForReactHydration(session, reservationSubmitSelector, {
      timeoutMs: timeouts.browserAction,
    });
  });

/**
 * Runs a side-effect-free reservation form preparation on the hydrated form:
 * a short evaluation starts it and keeps its status in the page, and the
 * runner polls that status within `timeoutMs`. Nothing is submitted.
 */
export const prepareReservationSelection = ({
  preparation,
  session,
  timeoutMs,
  timeouts,
}: {
  readonly preparation: ReservationFormPreparation;
  readonly session: E2EBrowserSession;
  readonly timeoutMs: number;
  readonly timeouts: WorkspaceE2ETimeouts;
}): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    yield* waitForReactHydration(session, reservationActionSelector, {
      timeoutMs: timeouts.browserAction,
    });
    yield* session
      .evaluate(
        "start checkout reservation preparation",
        prepareReservationForm,
        { detachInto: reservationPreparationStateKey, preparation },
        { timeoutMs: timeouts.browserAction }
      )
      .pipe(
        withoutWorkspaceE2ETimeout("start checkout reservation preparation")
      );
    yield* waitForReservationPreparation(session, timeoutMs);
  });

const waitForReservationPreparation = (
  session: E2EBrowserSession,
  timeoutMs: number
): Effect.Effect<void, WorkspaceE2EError> =>
  pollUntil(
    readPreparationState(session).pipe(
      Effect.flatMap((state) =>
        state.status === "failed"
          ? Effect.fail(
              toWorkspaceE2EError(
                "prepare checkout reservation",
                new Error(redact(state.error))
              )
            )
          : Effect.succeed(state.status === "ready" ? true : undefined)
      )
    ),
    {
      intervalMs: workspaceE2EPollIntervalMs.browser,
      label: "checkout reservation preparation",
      timeoutMs,
    }
  ).pipe(Effect.asVoid);

const readPreparationState = (
  session: E2EBrowserSession
): Effect.Effect<ReservationPreparationState, WorkspaceE2EError> =>
  session
    .evaluate(
      "read checkout reservation preparation state",
      readReservationPreparationState,
      reservationPreparationStateKey,
      { timeoutMs: pageReadTimeoutMs }
    )
    .pipe(
      withoutWorkspaceE2ETimeout("read checkout reservation preparation state"),
      Effect.flatMap((value) =>
        tryWorkspaceE2ESync(
          "parse checkout reservation preparation state",
          () => {
            assert(
              isReservationPreparationState(value),
              "checkout reservation preparation state invalid"
            );
            return value;
          }
        )
      )
    );

type ReservationStartResult =
  | {
      readonly status: "ready";
      readonly url: string;
    }
  | {
      readonly diagnostics: string | undefined;
      readonly status: "not_ready" | "retryable_error";
      readonly url: string | undefined;
    };

const waitForReservationStart = (
  session: E2EBrowserSession,
  timeoutMs: number
): Effect.Effect<ReservationStartResult, WorkspaceE2EError> =>
  Effect.gen(function* () {
    let latest: ReservationStartDiagnostics | undefined;

    const reservationStartExit = yield* Effect.exit(
      pollUntil(
        Effect.gen(function* () {
          const url = yield* readPageUrl(session);
          if (url?.includes("/checkout/pay"))
            return { status: "ready" as const, url };

          latest = yield* readReservationStartDiagnostics(session);
          if (isRetryableReservationStartError(latest)) {
            return {
              diagnostics: formatReservationStartDiagnostics(latest),
              status: "retryable_error" as const,
              url: latest?.url,
            };
          }
          return undefined;
        }),
        {
          intervalMs: workspaceE2EPollIntervalMs.browser,
          label: "checkout pay page",
          timeoutMs,
        }
      )
    );

    if (Exit.isSuccess(reservationStartExit)) return reservationStartExit.value;

    latest = addReservationStartTimeout(
      latest,
      Cause.squash(reservationStartExit.cause)
    );
    latest ??= yield* readReservationStartDiagnostics(session);
    return {
      diagnostics: formatReservationStartDiagnostics(latest),
      status: "not_ready",
      url: latest?.url,
    };
  });

type ReservationStartDiagnostics = {
  readonly body?: string;
  readonly submitDisabled?: boolean | null;
  readonly submitText?: string | null;
  readonly timeoutError?: string;
  readonly title?: string;
  readonly url?: string;
};

const isRetryableReservationStartError = (
  diagnostics: ReservationStartDiagnostics | undefined
) =>
  reservationStartRetryableErrorMessages.some((message) =>
    diagnostics?.body?.includes(message)
  );

// An unreadable page has no diagnostics. Its text is redacted.
const readReservationStartDiagnostics = (
  session: E2EBrowserSession
): Effect.Effect<ReservationStartDiagnostics | undefined> =>
  session
    .evaluate(
      "read reservation start diagnostics",
      summarizeCheckoutPage,
      undefined,
      { timeoutMs: pageReadTimeoutMs }
    )
    .pipe(
      Effect.map(
        (summary): ReservationStartDiagnostics => ({
          body: redact(summary.body),
          submitDisabled: summary.submitDisabled,
          submitText:
            summary.submitText === null ? null : redact(summary.submitText),
          title: redact(summary.title),
          url: redact(summary.url),
        })
      ),
      Effect.orElseSucceed(() => undefined)
    );

const addReservationStartTimeout = (
  diagnostics: ReservationStartDiagnostics | undefined,
  error: unknown
): ReservationStartDiagnostics => ({
  ...diagnostics,
  timeoutError: error instanceof Error ? error.message : String(error),
});

const formatReservationStartDiagnostics = (
  diagnostics: ReservationStartDiagnostics | undefined
) => {
  if (!diagnostics) return undefined;

  return JSON.stringify(
    {
      body: diagnostics.body?.slice(0, 1200),
      submitDisabled: diagnostics.submitDisabled,
      submitText: diagnostics.submitText,
      timeoutError: diagnostics.timeoutError,
      title: diagnostics.title,
      url: diagnostics.url,
    },
    null,
    2
  );
};

export type HostedPaymentPage = {
  readonly checkoutPage: Page;
  readonly checkoutPageUrl: string;
  readonly nexiNavigation?: NexiHostedNavigation;
  readonly page: Page;
  readonly provider: E2EPaymentProvider;
  readonly url: string;
};

/** Waits for the selected hosted page, leaving its tab active. */
export const submitPaymentAndWaitForHostedPage = ({
  config,
  paymentProvider = initialE2EPaymentProvider(config.paymentProvider),
  session,
}: {
  config: WorkspaceE2EConfig;
  paymentProvider?: E2EPaymentProvider;
  session: E2EBrowserSession;
}): Effect.Effect<HostedPaymentPage, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const { timeouts } = config;
    const checkoutPageUrl = yield* readPageUrl(session);
    if (!checkoutPageUrl) {
      return yield* failWorkspaceE2E("checkout pay page URL is unavailable", {
        operation: "read checkout pay page URL",
      });
    }
    // A sandbox restart reopens this URL; keep its sealed pay state out of logs.
    addRedaction(
      parseUrl(checkoutPageUrl)?.searchParams.get("payState") ?? undefined
    );
    const checkoutPage = yield* submitCheckoutPayment(session, timeouts);

    const hostedPaymentUrl = yield* waitForPageUrl({
      description: `${paymentProvider} hosted payment page`,
      matches: (url) =>
        paymentProvider === "mock"
          ? readMockHostedPaymentUrl(url, [config.baseUrl]) !== undefined
          : url.includes("nexigroup.com") || url.includes("/hpp/nexi/"),
      session,
      timeoutMs: timeouts.providerTransition,
    });
    if (paymentProvider === "mock") {
      const mockUrl = readMockHostedPaymentUrl(hostedPaymentUrl, [
        config.baseUrl,
      ]);
      if (mockUrl) addMockPaymentUrlRedactions(mockUrl);
    }
    const hostedPage = yield* readActivePage(session);
    if (hostedPage !== checkoutPage) {
      yield* session.activate(checkoutPage);
      yield* waitForPageUrl({
        description: "checkout status page in original tab",
        matches: (url) => isExpectedCheckoutStatusUrl(url, config.expectedHost),
        session,
        timeoutMs: timeouts.providerTransition,
      });
      yield* session.activate(hostedPage);
    }
    return {
      checkoutPage,
      checkoutPageUrl,
      page: hostedPage,
      provider: paymentProvider,
      url: hostedPaymentUrl,
    } satisfies HostedPaymentPage;
  });

export const waitForReturnedPaymentTabToClose = ({
  hostedPaymentPage: { checkoutPage, page },
  session,
  timeoutMs,
}: {
  readonly hostedPaymentPage: HostedPaymentPage;
  readonly session: E2EBrowserSession;
  readonly timeoutMs: number;
}) =>
  page === checkoutPage
    ? Effect.void
    : Effect.gen(function* () {
        yield* pollUntil(
          session.use("read browser tabs", async (active) => {
            const pages = active.context().pages();
            return pages.length === 1 && pages[0] === checkoutPage
              ? true
              : undefined;
          }),
          {
            intervalMs: workspaceE2EPollIntervalMs.browser,
            label: "returned payment tab to close",
            timeoutMs,
          }
        );
        yield* session.activate(checkoutPage);
      });

/**
 * Gives the pay page's legal consent and activates its enabled pay button
 * with native key presses. Returns the checkout page it submitted from, which
 * the caller activates again when the payment opens another page.
 */
export const submitCheckoutPayment = (
  session: E2EBrowserSession,
  timeouts: WorkspaceE2ETimeouts
): Effect.Effect<Page, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const checkoutPage = yield* readActivePage(session);
    yield* giveCheckoutPayConsent(session, timeouts);
    yield* activateCheckoutPayButton(session, timeouts);
    return checkoutPage;
  });

// The consent and the pay button are found in the interactive snapshot,
// polling for at most `checkoutPayControl` and failing, not timing out, when
// they never show; each is focused within `browserAction`.
const giveCheckoutPayConsent = Effect.fnUntraced(function* (
  session: E2EBrowserSession,
  timeouts: WorkspaceE2ETimeouts
) {
  yield* waitForReactHydration(session, "#checkout-pay-legal-consent", {
    timeoutMs: timeouts.checkoutPayControl,
  });
  const nameMatch = yield* session
    .use(
      "payment legal consent",
      (page) =>
        waitForPayControl(
          (match) => checkoutPayConsent(page, match),
          timeouts.checkoutPayControl
        ),
      { timeoutMs: timeouts.checkoutPayControl }
    )
    .pipe(withoutWorkspaceE2ETimeout("payment legal consent"));
  yield* session.use("focus browser element", (page) =>
    checkoutPayConsent(page, nameMatch).focus({
      timeout: timeouts.browserAction,
    })
  );
  // The key press has no timeout of its own.
  yield* session.use("press browser key", (page) =>
    page.keyboard.press("Space")
  );
});

const activateCheckoutPayButton = Effect.fnUntraced(function* (
  session: E2EBrowserSession,
  timeouts: WorkspaceE2ETimeouts
) {
  const nameMatch = yield* session
    .use(
      "enabled payment submit button",
      (page) =>
        waitForPayControl(
          (match) => checkoutPayButton(page, match),
          timeouts.checkoutPayControl
        ),
      { timeoutMs: timeouts.checkoutPayControl }
    )
    .pipe(withoutWorkspaceE2ETimeout("enabled payment submit button"));
  yield* session.use("focus browser element", (page) =>
    checkoutPayButton(page, nameMatch).focus({
      timeout: timeouts.browserAction,
    })
  );
  yield* session.use("press browser key", (page) =>
    page.keyboard.press("Enter")
  );
});

/** Whether a control is matched by its exact accessible name. */
type NameMatch = "contains" | "equals";

// The pay page's controls by their English or Czech accessible names.
const payControlName = (labels: string, nameMatch: NameMatch) =>
  new RegExp(nameMatch === "equals" ? `^(?:${labels})$` : labels, "i");

const checkoutPayConsent = (page: Page, nameMatch: NameMatch) =>
  page
    .getByRole("checkbox", {
      name: payControlName("I agree to the|Souhlasím", nameMatch),
    })
    .filter({ visible: true })
    .first();

// The pay button is looked up by name in the page's whole accessibility
// snapshot, whatever its role, so any enabled widget named so qualifies, the
// first in document order.
const payButtonRoles = [
  "button",
  "checkbox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
  "treeitem",
] as const;

const checkoutPayButton = (page: Page, nameMatch: NameMatch) => {
  // A payment retry's Pay page names its button for paying again.
  const name = payControlName("Order and pay|Try payment again", nameMatch);
  return payButtonRoles
    .map((role) => page.getByRole(role, { disabled: false, name }))
    .reduce((controls, control) => controls.or(control))
    .filter({ visible: true })
    .first();
};

/**
 * Waits for a visible control and tells how to match it: a control named
 * exactly a label wins over one whose name only contains it.
 */
const waitForPayControl = async (
  locate: (nameMatch: NameMatch) => Locator,
  timeout: number
): Promise<NameMatch> => {
  await locate("contains").waitFor({ timeout });
  return (await locate("equals").count()) > 0 ? "equals" : "contains";
};

const getSearchOrderId = (value: string | undefined) => {
  if (!value) return undefined;
  const url = parseUrl(value);
  return url?.searchParams.get("orderId") ?? undefined;
};
