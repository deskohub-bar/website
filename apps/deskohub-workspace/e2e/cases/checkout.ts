import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { meetingRoomEmailDetails } from "@/emails/_components/reservation-email-details";
import { renderWorkspaceEmailDetailsText } from "@/emails/workspace-email-detail";
import { NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE } from "@/features/checkout/payment-fallback";
import { isMeetingRoomWholeDayReservationDuration } from "@/features/reservation/meeting-room-reservation-duration";
import {
  formatReservationDisplayDate,
  formatReservationDisplayDateRange,
  formatReservationDisplayDateTimeRange,
  formatReservationDisplayTimeRange,
} from "@/features/reservation/reservation-date";
import { isSingleDayReservationInterval } from "@/features/reservation/reservation-interval-domain";
import { formatMoney } from "@/shared/money/money";
import {
  activateElement,
  activateHydratedElement,
  assertPageCheck,
  normalizeBrowserText,
  openPage,
  readNetworkLog,
  waitForPageCondition,
  waitForPageText,
  waitForPageUrl,
  waitForReactHandler,
} from "../browser";
import type {
  E2EBrowserSession,
  OpenE2EBrowserSession,
} from "../browser-session";
import type { WorkspaceE2EStep, WorkspaceE2EStepRunner } from "../case-runner";
import { completeHostedPayment } from "../checkout/hosted-payment";
import { retireRejectedAttempt } from "../checkout/lifecycle-fixtures";
import {
  formatNexiBuildFailureCodes,
  parseNexiBuildFailures,
} from "../checkout/nexi-build-api";
import {
  leaveNexiPageForMockFallback,
  observeNexiHostedNavigation,
} from "../checkout/nexi-hosted-page-ownership";
import {
  classifyNexiSandboxRejection,
  decideNexiSandboxRetry,
  type NexiSandboxRejection,
  nexiSandboxRetryDelayMs,
} from "../checkout/nexi-sandbox-retry";
import {
  type HostedPaymentPage,
  submitPaymentAndWaitForHostedPage,
  submitReservationForPayPage,
} from "../checkout/payment";
import { retryPaymentInPlace } from "../checkout/payment-retry";
import {
  findRepeatReservationProblem,
  toRepeatReservation,
} from "../checkout/repeat-reservation";
import { matchesExpectedReservationDetails } from "../checkout/reservation-details";
import { reservationStatusIsolationStep } from "../checkout/reservation-status-isolation";
import type { DatasourceConfig, WorkspaceE2EConfig } from "../config";
import { WorkspaceE2EHostedPaymentPermitService } from "../coordination/hosted-payment-permit.service";
import type { WorkspaceE2EProviderVerificationPermitService } from "../coordination/provider-verification-permit.service";
import { type E2EPaymentProvider, initialE2EPaymentProvider } from "../e2e-env";
import { tryWorkspaceE2ESync, type WorkspaceE2EError } from "../errors";
import {
  type ExpectedDiscountApplication,
  type HostedProviderSessionRow,
  markFulfillmentFailedForE2E,
  markPreviewFulfillmentDeliveredForE2E,
  replayPaymentWebhook,
  requireProviderSessionRowAfterRedirect,
  validateDiscountApplications,
  validatePostgres,
} from "../integrations/database";
import type { E2EDatabase } from "../integrations/database.service";
import {
  type ValidatedDotyposReservation,
  validateDotypos,
} from "../integrations/dotypos";
import {
  recordCheckoutIntent,
  recordReservationResult,
} from "../reservation-intents";
import { assert, log, parseUrl } from "../runtime";
import type {
  CheckoutData,
  CheckoutFlow,
  CheckoutFlowState,
  CheckoutRow,
  WorkspaceE2ECaseContext,
} from "../types";
import { isExpectedCheckoutStatusUrl, makeUrl, setSearchParams } from "../urls";

// A focused case test can supply a result only for a step with that result
// type. The regular runner remains the default for every step.
export type CheckoutStepRunner<A> = <R>(
  step: WorkspaceE2EStep<A, R>
) => Effect.Effect<A, WorkspaceE2EError, R>;

type CheckoutFlowSteps = {
  readonly preparePayPage?: CheckoutStepRunner<CheckoutRow["reservation_id"]>;
  readonly checkoutRow?: CheckoutStepRunner<CheckoutRow>;
  readonly dotyposReservation?: CheckoutStepRunner<ValidatedDotyposReservation>;
  readonly check?: CheckoutStepRunner<unknown>;
  readonly replayWebhook?: (
    step: WorkspaceE2EStep<void, never, "provider-verification">
  ) => Effect.Effect<
    void,
    WorkspaceE2EError,
    WorkspaceE2EProviderVerificationPermitService
  >;
  readonly hostedPayment?: HostedCheckoutPaymentSteps;
};

export const executeCheckoutFlow = (
  {
    config,
    data,
    datasourceConfig,
    flow,
    openSeparateSession,
    openSession,
    runStep,
    state,
    payPageSteps,
    beforeReservationSubmit,
    expectedDiscounts,
    expectedReservationInvitees,
    afterFulfillment,
    verifyPostFulfillmentPaths = false,
  }: {
    config: WorkspaceE2EConfig;
    data: CheckoutData;
    datasourceConfig: DatasourceConfig;
    flow: CheckoutFlowStart;
    openSeparateSession: WorkspaceE2ECaseContext["openSeparateSession"];
    openSession: OpenE2EBrowserSession;
    runStep: WorkspaceE2EStepRunner;
    state: CheckoutFlowState;
    payPageSteps?: (
      orderId: CheckoutRow["reservation_id"]
    ) => readonly WorkspaceE2EStep<void, E2EDatabase>[];
    beforeReservationSubmit?: Effect.Effect<void, WorkspaceE2EError>;
    expectedDiscounts?: readonly ExpectedDiscountApplication[];
    /** Present for an office or Team Table booked with an attendee list, even with no invitees. */
    expectedReservationInvitees?: readonly string[];
    // Checks on the fulfilled reservation beyond the status page, before any
    // post-fulfillment path changes it.
    afterFulfillment?: (
      orderId: CheckoutRow["reservation_id"],
      dotyposReservation: ValidatedDotyposReservation
    ) => Effect.Effect<void, WorkspaceE2EError, E2EDatabase>;
    // The reserve-again restart, the fulfillment-failed support path, and the
    // reservation status isolation that starts from that support path do not
    // depend on the product, so one paid case opts in instead of every case.
    // The support path marks fulfillment failed, so it runs after every other
    // assertion on the fulfilled reservation.
    verifyPostFulfillmentPaths?: boolean;
  },
  steps: CheckoutFlowSteps = {}
): Effect.Effect<
  void,
  WorkspaceE2EError,
  | E2EDatabase
  | HttpClient.HttpClient
  | WorkspaceE2EHostedPaymentPermitService
  | WorkspaceE2EProviderVerificationPermitService
> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const check = steps.check ?? runStep;
    state.startedAt = new Date();
    const agentIntent =
      "startReservation" in flow
        ? yield* recordCheckoutIntent(data)
        : undefined;
    const orderId =
      "startReservation" in flow
        ? yield* flow.startReservation
        : yield* (steps.preparePayPage ?? runStep)({
            execute: Effect.gen(function* () {
              const browser = yield* openSession;
              yield* openPage(browser, config, data.checkoutUrl, {
                timeoutMs: config.timeouts.browserNavigation,
              });
              if (beforeReservationSubmit) yield* beforeReservationSubmit;
              return yield* submitReservationForPayPage({
                data,
                onOrderId: (startedOrderId) => {
                  state.orderId = startedOrderId;
                },
                session: browser,
                preparation: flow.toReservationPreparation(data),
                timeouts: config.timeouts,
              });
            }),
            id: "prepare-checkout-pay-page",
            timeoutMs: config.timeouts.checkoutStart,
          });
    yield* recordReservationResult(agentIntent, { orderId });
    if (payPageSteps) {
      for (const step of payPageSteps(orderId)) yield* check(step);
    }
    const providerSessionRow = yield* completeHostedCheckoutPayment(
      {
        config,
        data,
        orderId,
        runStep,
        openSession,
        state,
      },
      steps.hostedPayment
    );
    state.orderId = orderId;

    // The deployed webhook handler verifies the selected provider's state.
    yield* (steps.replayWebhook ?? runStep)({
      permit: "provider-verification",
      execute: replayPaymentWebhook(config, providerSessionRow).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient)
      ),
      id: "replay-payment-webhook",
      timeoutMs: config.timeouts.providerTransition,
    });
    yield* check({
      execute: markPreviewFulfillmentDeliveredForE2E(datasourceConfig, orderId),
      id: "complete-test-fulfillment",
      timeoutMs: config.timeouts.datasource,
    });
    const checkoutRow = yield* (steps.checkoutRow ?? runStep)({
      execute: validatePostgres(
        {
          ...datasourceConfig,
          paymentProvider: providerSessionRow.provider,
        },
        data,
        orderId,
        (row) => {
          state.checkoutRow = row;
        }
      ),
      id: "validate-postgres-state",
      timeoutMs: config.timeouts.datasource,
    });
    state.checkoutRow = checkoutRow;
    if (expectedDiscounts) {
      yield* check({
        execute: validateDiscountApplications(
          datasourceConfig,
          orderId,
          expectedDiscounts
        ),
        id: "validate-discount-applications",
        timeoutMs: config.timeouts.datasource,
      });
    }
    const dotyposReservation = yield* (steps.dotyposReservation ?? runStep)({
      execute: validateDotypos(datasourceConfig, data, checkoutRow),
      id: "validate-dotypos-reservation",
      timeoutMs: config.timeouts.datasource,
    });
    yield* check({
      execute: assertFulfilledStatusPage({
        checkoutRow,
        config,
        data,
        dotyposReservation,
        expectedReservationInvitees,
        orderId,
        openSession,
      }),
      id: "assert-fulfilled-status-page",
      timeoutMs: config.timeouts.uiTransition,
    });
    if (afterFulfillment) yield* afterFulfillment(orderId, dotyposReservation);
    if (verifyPostFulfillmentPaths) {
      yield* check({
        execute: restartReservationAfterFulfillment({
          config,
          data,
          openSession,
        }),
        id: "restart-reservation-after-fulfillment",
        timeoutMs: config.timeouts.uiTransition,
      });
    }
    if (
      data.meetingRoom &&
      isMeetingRoomWholeDayReservationDuration(data.meetingRoom.duration)
    ) {
      yield* check({
        execute: assertWholeDayMeetingRoomEmailPreviews({
          checkoutRow,
          data,
          dotyposReservation,
        }),
        id: "assert-whole-day-reservation-email-previews",
        timeoutMs: config.timeouts.datasource,
      });
    }
    if (verifyPostFulfillmentPaths) {
      yield* assertFulfillmentFailedSupportPath({
        config,
        data,
        orderId,
        runStep: check,
        openSession,
      });
      const customerId = yield* tryWorkspaceE2ESync(
        "read paid customer for reservation status isolation",
        () => {
          assert(
            checkoutRow.dotypos_customer_id,
            "paid customer id missing after checkout"
          );
          return checkoutRow.dotypos_customer_id;
        }
      );
      yield* check(
        reservationStatusIsolationStep({
          config,
          customerId,
          data,
          openSeparateSession,
          openSession,
          orderId,
        })
      );
    }

    log(`${flow.id} checkout e2e passed for order ${orderId}`);
  });

/**
 * How a checkout reaches its pay page: by submitting the flow's reservation
 * form, or through `startReservation`, which starts the reservation some
 * other way, captures its order for cleanup, and leaves the browser on the
 * pay page.
 */
export type CheckoutFlowStart =
  | Pick<CheckoutFlow, "id" | "toReservationPreparation">
  | {
      readonly id: CheckoutFlow["id"];
      readonly startReservation: Effect.Effect<
        CheckoutRow["reservation_id"],
        WorkspaceE2EError,
        E2EDatabase | HttpClient.HttpClient
      >;
    };

export type HostedCheckoutPaymentOptions = {
  readonly outcome?: "approved" | "declined";
  readonly config: WorkspaceE2EConfig;
  readonly data: CheckoutData;
  readonly orderId: CheckoutRow["reservation_id"];
  readonly runStep: WorkspaceE2EStepRunner;
  readonly openSession: OpenE2EBrowserSession;
  readonly state: CheckoutFlowState;
};

type HostedPaymentRejection = {
  readonly authorizationRequested: boolean;
  readonly error: WorkspaceE2EError;
  readonly rejection: NexiSandboxRejection;
  readonly row: HostedProviderSessionRow;
};

type OpenedHostedCheckout = {
  readonly provider: E2EPaymentProvider;
  readonly complete: (
    onAuthorizationRequested: () => void
  ) => Effect.Effect<void, WorkspaceE2EError>;
  readonly restart: (
    rejected: HostedPaymentRejection,
    fallback?: boolean
  ) => Effect.Effect<boolean, WorkspaceE2EError, E2EDatabase>;
};

type HostedPaymentAttempt =
  | { readonly kind: "completed"; readonly row: HostedProviderSessionRow }
  | (HostedPaymentRejection & {
      readonly kind: "sandbox-rejected";
      readonly checkout: OpenedHostedCheckout;
    });

export type HostedCheckoutPaymentSteps = {
  readonly open?: CheckoutStepRunner<OpenedHostedCheckout>;
  readonly read?: CheckoutStepRunner<HostedProviderSessionRow>;
  readonly check?: CheckoutStepRunner<unknown>;
  readonly restart?: CheckoutStepRunner<boolean>;
};

// Drives the selected hosted page. The shared Nexi sandbox sometimes rejects a
// payment on its own side; when that happened before Nexi could authorize
// anything, the runner restarts the attempt once within the hosted-payment permit.
export const completeHostedCheckoutPayment = (
  options: HostedCheckoutPaymentOptions,
  steps: HostedCheckoutPaymentSteps = {}
): Effect.Effect<
  HostedProviderSessionRow,
  WorkspaceE2EError,
  E2EDatabase | WorkspaceE2EHostedPaymentPermitService
> =>
  Effect.gen(function* () {
    const hostedPaymentPermit = yield* WorkspaceE2EHostedPaymentPermitService;
    return yield* hostedPaymentPermit.withPermit(
      "hosted checkout payment",
      Effect.gen(function* () {
        const { config, runStep } = options;
        const paymentProvider = initialE2EPaymentProvider(
          config.paymentProvider
        );
        const first = yield* runHostedPaymentAttempt(
          options,
          steps,
          paymentProvider
        );
        if (first.kind === "completed") return first.row;

        const restarted = yield* (steps.restart ?? runStep)({
          execute: first.checkout.restart(first),
          id: "restart-sandbox-rejected-payment",
          timeoutMs:
            options.config.timeouts.datasource +
            nexiSandboxRetryDelayMs +
            options.config.timeouts.browserNavigation,
        });
        if (!restarted) return yield* first.error;

        const retry = yield* runHostedPaymentAttempt(options, steps, "nexi", {
          row: first.row,
          suffix: "-retry",
        });
        if (retry.kind === "completed") return retry.row;
        if (config.paymentProvider !== "fallback") return yield* retry.error;

        const fellBack = yield* (steps.restart ?? runStep)({
          execute: retry.checkout.restart(retry, true),
          id: "restart-sandbox-rejected-payment-with-mock",
          timeoutMs:
            config.timeouts.datasource +
            config.timeouts.browserAction +
            config.timeouts.browserNavigation,
        });
        if (!fellBack) return yield* retry.error;

        const mock = yield* runHostedPaymentAttempt(options, steps, "mock", {
          row: retry.row,
          suffix: "-mock-fallback",
        });
        return mock.kind === "completed" ? mock.row : yield* mock.error;
      })
    );
  });

const runHostedPaymentAttempt = (
  options: HostedCheckoutPaymentOptions,
  steps: HostedCheckoutPaymentSteps,
  paymentProvider: E2EPaymentProvider,
  restart?: {
    readonly row: CheckoutRow;
    readonly suffix: "-retry" | "-mock-fallback";
  }
): Effect.Effect<HostedPaymentAttempt, WorkspaceE2EError, E2EDatabase> =>
  Effect.gen(function* () {
    const { config, orderId, runStep, openSession, state } = options;
    const check = steps.check ?? runStep;
    const stepId = (id: string) => `${id}${restart?.suffix ?? ""}`;
    const checkout = yield* (steps.open ?? runStep)({
      execute: openHostedCheckout(options, paymentProvider, restart?.suffix),
      id: stepId("start-checkout-payment"),
      timeoutMs: config.timeouts.providerTransition,
    });
    const readProviderSession = {
      execute: requireProviderSessionRowAfterRedirect(orderId, {
        onRow: (value) => {
          state.checkoutRow = value;
        },
        paymentProvider: checkout.provider,
        timeoutMs: config.timeouts.browserAction,
      }),
      id: stepId("read-provider-session-row"),
      timeoutMs: config.timeouts.datasource,
    };
    const row = yield* runStep({
      ...readProviderSession,
      execute: (
        steps.read?.(readProviderSession) ?? readProviderSession.execute
      ).pipe(
        Effect.tap((value) =>
          restart
            ? tryWorkspaceE2ESync("assert fresh payment attempt", () =>
                assertFreshPaymentAttempt(restart.row, value)
              )
            : Effect.void
        )
      ),
    });

    let authorizationRequested = false;
    const rejected = yield* check({
      execute: checkout.complete(() => {
        authorizationRequested = true;
      }),
      id: stepId("complete-hosted-payment"),
      timeoutMs: config.timeouts.hostedPayment,
    }).pipe(
      Effect.as(undefined),
      Effect.catch((error) => {
        const rejection =
          checkout.provider === "nexi"
            ? classifyNexiSandboxRejection(error)
            : undefined;
        return rejection
          ? Effect.succeed({
              authorizationRequested,
              error,
              checkout,
              kind: "sandbox-rejected" as const,
              rejection,
              row,
            })
          : Effect.fail(error);
      })
    );
    if (rejected) return rejected;

    yield* check({
      execute: waitForCheckoutStatusPage(config, openSession),
      id: stepId("reach-checkout-status-page"),
      timeoutMs: config.timeouts.providerTransition,
    });
    return { kind: "completed", row };
  });

const openHostedCheckout = (
  options: HostedCheckoutPaymentOptions,
  paymentProvider: E2EPaymentProvider,
  suffix: "-retry" | "-mock-fallback" | undefined
): Effect.Effect<OpenedHostedCheckout, WorkspaceE2EError> => {
  const { config, data, openSession, outcome } = options;
  return Effect.flatMap(openSession, (browser) => {
    const launch = submitPaymentAndWaitForHostedPage({
      config,
      paymentProvider,
      session: browser,
    });
    return config.paymentProvider === "fallback" && suffix === "-retry"
      ? observeNexiHostedNavigation(browser, launch)
      : launch;
  }).pipe(
    Effect.map((hostedPaymentPage) => ({
      provider: hostedPaymentPage.provider,
      complete: (onNexiAuthorizationRequested) =>
        Effect.flatMap(openSession, (session) =>
          completeHostedPayment({
            config,
            data,
            hostedPaymentPage,
            ...(outcome === undefined ? {} : { outcome }),
            onNexiAuthorizationRequested,
            session,
          })
        ),
      restart: (rejected, fallback) =>
        restartSandboxRejectedPayment(
          options,
          { ...rejected, hostedPaymentPage },
          fallback
        ),
    }))
  );
};

export const assertFreshPaymentAttempt = (
  rejectedRow: Pick<CheckoutRow, "payment_attempt_id" | "provider_order_id">,
  row: Pick<CheckoutRow, "payment_attempt_id" | "provider_order_id">
) => {
  assert(
    row.payment_attempt_id !== rejectedRow.payment_attempt_id,
    "restarted payment reused the rejected payment attempt"
  );
  assert(
    row.provider_order_id !== rejectedRow.provider_order_id,
    "restarted payment reused the rejected provider order"
  );
};

// Decides whether the rejected payment may restart. If so, retires the rejected attempt, leaves the hosted page, and
// retries the payment from the order's status page, whose Pay page starts a fresh attempt and Nexi order.
const restartSandboxRejectedPayment = (
  { config, orderId, openSession, state }: HostedCheckoutPaymentOptions,
  rejected: HostedPaymentRejection & {
    readonly hostedPaymentPage: HostedPaymentPage;
  },
  fallback = false
): Effect.Effect<boolean, WorkspaceE2EError, E2EDatabase> =>
  Effect.gen(function* () {
    const browser = yield* openSession;
    const networkLog = yield* readNetworkLog(browser);
    const decision = decideNexiSandboxRetry({
      authorizationRequested: rejected.authorizationRequested,
      error: rejected.error,
      requireNoAuthorization: fallback,
    });
    const nexiCodes = formatNexiBuildFailureCodes(
      parseNexiBuildFailures(networkLog)
    );
    if (!decision.retry) {
      log(
        `Nexi sandbox rejection ${rejected.rejection.diagnosticCode} is not restarted: ${decision.reason} (Nexi codes: ${nexiCodes})`
      );
      return false;
    }
    const paymentAttemptId = rejected.row.payment_attempt_id;
    if (!paymentAttemptId) return false;

    // Paying an ended payment again is a payment retry: its status page's
    // "Try payment again" opens the same order's Pay page.
    const statusPageUrl = yield* getOrderStatusPageUrl(
      rejected.hostedPaymentPage.checkoutPageUrl,
      orderId
    );
    log(
      `Nexi sandbox rejected the hosted payment (${rejected.rejection.diagnosticCode}; Nexi codes: ${nexiCodes}); ${fallback ? "checking whether the case can retry with mock" : "restarting once with a fresh Nexi attempt"}`
    );
    if (fallback) {
      yield* leaveNexiPageForMockFallback({
        hostedPaymentPage: rejected.hostedPaymentPage,
        row: rejected.row,
        session: browser,
        statusPageUrl,
        timeouts: config.timeouts,
      });
      state.checkoutRow = yield* retireRejectedAttempt(
        orderId,
        paymentAttemptId,
        NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE
      );
      yield* openPage(browser, config, statusPageUrl, {
        timeoutMs: config.timeouts.browserNavigation,
      });
    } else {
      state.checkoutRow = yield* retireRejectedAttempt(
        orderId,
        paymentAttemptId
      );
      yield* leaveRejectedHostedPayment({
        config,
        hostedPaymentPage: {
          ...rejected.hostedPaymentPage,
          checkoutPageUrl: statusPageUrl,
        },
        session: browser,
      });
    }
    yield* retryPaymentInPlace({
      label: "sandbox-rejected payment",
      orderId,
      session: browser,
      timeouts: config.timeouts,
    });
    return true;
  });

/** The order's status page, in the locale and origin of its Pay page. */
const getOrderStatusPageUrl = (
  checkoutPageUrl: string,
  orderId: CheckoutRow["reservation_id"]
) =>
  tryWorkspaceE2ESync("build the order's status page URL", () => {
    const payUrl = parseUrl(checkoutPageUrl);
    const locale = payUrl?.pathname.split("/")[1];
    assert(payUrl && locale, "the checkout pay page URL has no locale");
    return new URL(
      `/${locale}/reservation/status/${orderId}`,
      payUrl.origin
    ).toString();
  });

/**
 * Closes Nexi's own page, if the payment opened one, and reopens the checkout
 * pay page after `nexiSandboxRetryDelayMs`, which starts a fresh payment
 * attempt and Nexi order.
 */
export const leaveRejectedHostedPayment = ({
  config,
  hostedPaymentPage: { checkoutPage, checkoutPageUrl, page },
  session,
}: {
  readonly config: Pick<WorkspaceE2EConfig, "bypassSecret" | "timeouts">;
  readonly hostedPaymentPage: HostedPaymentPage;
  readonly session: E2EBrowserSession;
}): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    if (page !== checkoutPage) {
      // A page that already closed fails; the close has no bound of its own.
      yield* session.use(
        "close browser tab",
        async () => {
          if (page.isClosed()) throw new Error("hosted payment tab is closed");
          await page.close();
        },
        { timeoutMs: config.timeouts.browserAction }
      );
      yield* session.activate(checkoutPage);
    }
    // Give the shared sandbox a moment before the next card-data submission.
    yield* Effect.sleep(`${nexiSandboxRetryDelayMs} millis`);
    yield* openPage(session, config, checkoutPageUrl, {
      timeoutMs: config.timeouts.browserNavigation,
    });
  });

const waitForCheckoutStatusPage = (
  config: WorkspaceE2EConfig,
  openSession: OpenE2EBrowserSession
) =>
  waitForPageUrl({
    description: "checkout status page",
    matches: (url) => isExpectedCheckoutStatusUrl(url, config.expectedHost),
    session: openSession,
    timeoutMs: config.timeouts.providerTransition,
  }).pipe(Effect.asVoid);

const restartReservationAfterFulfillment = ({
  config,
  data,
  openSession,
}: {
  config: WorkspaceE2EConfig;
  data: CheckoutData;
  openSession: OpenE2EBrowserSession;
}): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const reservationPath = yield* tryWorkspaceE2ESync(
      "read fresh reservation path",
      () => {
        const url = parseUrl(data.checkoutUrl);
        if (!url) throw new Error("checkout URL is invalid");
        return url.pathname;
      }
    );

    const browser = yield* openSession;
    yield* activateElement(browser, "#checkout-status-reserve-again", {
      timeoutMs: config.timeouts.browserAction,
    });
    yield* waitForReactHandler(browser, "form", "onSubmit", {
      timeoutMs: config.timeouts.uiTransition,
    });
    yield* waitForPageCondition(
      browser,
      "fresh reservation form remains active",
      isFreshReservationFormSettled,
      { reservationPath },
      { timeoutMs: config.timeouts.uiTransition }
    );
    yield* assertPageCheck(
      browser,
      "assert repeat reservation defaults",
      findRepeatReservationProblem,
      toRepeatReservation(data),
      { timeoutMs: config.timeouts.browserAction }
    );
  });

/**
 * Runs in the browser: whether the page has stayed on the fresh reservation
 * form at `reservationPath` for a second. It records when it first saw the
 * form on the document element and forgets it once the page leaves.
 */
export const isFreshReservationFormSettled = ({
  reservationPath,
}: {
  readonly reservationPath: string;
}) => {
  const root = document.documentElement;
  if (location.pathname !== reservationPath) {
    delete root.dataset.checkoutRestartReadyAt;
    return false;
  }
  const readyAt = Number(root.dataset.checkoutRestartReadyAt);
  if (!Number.isFinite(readyAt) || readyAt <= 0) {
    root.dataset.checkoutRestartReadyAt = String(Date.now());
    return false;
  }
  return Date.now() - readyAt >= 1000;
};

export const assertFulfilledStatusPage = ({
  checkoutRow,
  config,
  data,
  dotyposReservation,
  expectedReservationInvitees,
  orderId,
  openSession,
}: {
  checkoutRow: Pick<
    CheckoutRow,
    "amount_value" | "amount_exponent" | "currency"
  >;
  config: WorkspaceE2EConfig;
  data: {
    readonly locale: CheckoutData["locale"];
    readonly meetingRoom?: Pick<
      NonNullable<CheckoutData["meetingRoom"]>,
      "duration"
    >;
    readonly office?: Pick<NonNullable<CheckoutData["office"]>, "seats">;
    readonly table?: Pick<NonNullable<CheckoutData["table"]>, "seats">;
  };
  dotyposReservation: Pick<
    ValidatedDotyposReservation,
    "assignedTableName" | "reservedFrom" | "reservedUntil"
  >;
  expectedReservationInvitees?: readonly string[];
  orderId: CheckoutRow["reservation_id"];
  openSession: OpenE2EBrowserSession;
}): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const expectedPaymentPrice = yield* tryWorkspaceE2ESync(
      "read checkout payment amount for status assertion",
      () => {
        if (
          checkoutRow.amount_value === null ||
          checkoutRow.amount_exponent === null ||
          checkoutRow.currency === null
        ) {
          throw new Error("checkout payment amount is incomplete");
        }

        return formatMoney(
          {
            value: checkoutRow.amount_value,
            exponent: checkoutRow.amount_exponent,
            currency: checkoutRow.currency,
          },
          data.locale
        );
      }
    );
    // The payment return already left this browser on the ordinary production
    // status route. Keep that page alive so its real auto-refresh observes the
    // fulfillment transition instead of starting another streamed RSC request
    // for every paid case.
    const browser = yield* openSession;
    yield* waitForPageUrl({
      description: "fulfilled checkout status page",
      matches: (url) => {
        const parsed = parseUrl(url);
        return Boolean(
          parsed &&
            isExpectedCheckoutStatusUrl(url, config.expectedHost) &&
            parsed.pathname.endsWith(`/reservation/status/${orderId}`)
        );
      },
      session: browser,
      timeoutMs: config.timeouts.uiTransition,
    });
    const expectedReservationText = yield* tryWorkspaceE2ESync(
      "read confirmed reservation interval for status assertion",
      () => {
        if (data.office) {
          return [
            "Private office",
            formatReservationDisplayDateRange(
              dotyposReservation.reservedFrom,
              dotyposReservation.reservedUntil,
              data.locale
            ),
            ...(expectedReservationInvitees === undefined
              ? ["Seats", String(data.office.seats)]
              : ["Who is coming"]),
            expectedPaymentPrice,
          ];
        }
        if (data.table) {
          return [
            "Team Table",
            ...(dotyposReservation.assignedTableName
              ? [dotyposReservation.assignedTableName]
              : []),
            formatReservationDisplayDateTimeRange(
              dotyposReservation.reservedFrom,
              dotyposReservation.reservedUntil,
              data.locale
            ),
            "Who is coming",
            expectedPaymentPrice,
          ];
        }
        if (!data.meetingRoom) return [];

        const interval = {
          startsAt: dotyposReservation.reservedFrom,
          endsAt: dotyposReservation.reservedUntil,
        };

        return [
          formatReservationDisplayDate(interval.startsAt, data.locale),
          isSingleDayReservationInterval(interval)
            ? "whole day"
            : formatReservationDisplayTimeRange(
                interval.startsAt,
                interval.endsAt,
                data.locale
              ),
          expectedPaymentPrice,
        ];
      }
    );
    yield* waitForPageText({
      description: "fulfilled checkout status copy",
      matches: (text) => {
        const normalizedText = normalizeBrowserText(text).toLocaleLowerCase(
          data.locale
        );

        return (
          /Your reservation is confirmed\./i.test(normalizedText) &&
          /emailed you the secure access link/i.test(normalizedText) &&
          expectedReservationText.every((expected) =>
            normalizedText.includes(
              normalizeBrowserText(expected).toLocaleLowerCase(data.locale)
            )
          )
        );
      },
      session: browser,
      timeoutMs: config.timeouts.uiTransition,
    });
    let expectedPeople:
      | { readonly count: number; readonly invitees: readonly string[] }
      | undefined;
    if (expectedReservationInvitees !== undefined) {
      if (data.office) {
        expectedPeople = {
          count: data.office.seats,
          invitees: expectedReservationInvitees,
        };
      } else if (data.table) {
        expectedPeople = {
          count: 1 + expectedReservationInvitees.length,
          invitees: expectedReservationInvitees,
        };
      }
    }
    yield* assertPageCheck(
      browser,
      "assert fulfilled checkout status page",
      findFulfilledStatusPageProblem,
      expectedPeople,
      { timeoutMs: config.timeouts.browserAction }
    );
    log("Checkout status page validated");
  });

/**
 * Runs in the browser: why the page is not the canonical fulfilled checkout
 * status page, or `null` when it is. It must not close over anything.
 */
export const findFulfilledStatusPageProblem = (reservationPeople?: {
  readonly count: number;
  readonly invitees: readonly string[];
}): string | null => {
  if (document.querySelector("[data-reservation-access]")) {
    return "reservation access rendered on checkout status page";
  }
  // Only account-origin navigation may intercept the status route. A checkout
  // status rendered in a dialog means the reservation modal slot leaked.
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (/Your reservation is confirmed\./i.test(dialog.textContent ?? "")) {
      return "checkout status rendered in a reservation dialog";
    }
  }
  if (reservationPeople) {
    const rows = Array.from(
      document.querySelectorAll("[data-office-status-people] > ul > li")
    );
    if (rows.length !== reservationPeople.count) {
      return "office attendee count does not match the booking";
    }
    const labels = rows.map((row) =>
      row.firstElementChild?.textContent?.trim()
    );
    if (!reservationPeople.invitees.every((email) => labels.includes(email))) {
      return "office status is missing an expected invitee";
    }
  }
  const text = document.body?.textContent ?? "";
  return /Your reservation is confirmed\./i.test(text) &&
    /emailed you the secure access link/i.test(text)
    ? null
    : "fulfilled checkout status copy not visible";
};

type WholeDayEmailCheckoutRow = Pick<
  CheckoutRow,
  "dotypos_customer_id" | "dotypos_reservation_id" | "reservation_details"
>;

export const assertWholeDayMeetingRoomEmailPreviews = ({
  checkoutRow,
  data,
  dotyposReservation,
}: {
  checkoutRow: WholeDayEmailCheckoutRow;
  data: Pick<CheckoutData, "expectedReservationDetails" | "meetingRoom">;
  dotyposReservation: ValidatedDotyposReservation;
}): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const reservation = yield* tryWorkspaceE2ESync(
      "build whole-day reservation email preview",
      () => {
        assert(
          data.meetingRoom &&
            isMeetingRoomWholeDayReservationDuration(data.meetingRoom.duration),
          "whole-day meeting-room checkout data missing"
        );
        assert(
          isSingleDayReservationInterval({
            startsAt: dotyposReservation.reservedFrom,
            endsAt: dotyposReservation.reservedUntil,
          }),
          "confirmed Dotypos reservation is not one Prague calendar day"
        );
        assert(
          checkoutRow.dotypos_customer_id,
          "Dotypos customer id missing from checkout row"
        );
        assert(
          checkoutRow.dotypos_reservation_id,
          "Dotypos reservation id missing from checkout row"
        );

        assert(
          matchesExpectedReservationDetails(
            checkoutRow.reservation_details,
            data.expectedReservationDetails
          ),
          "meeting-room checkout row does not record the booked offer"
        );

        return {
          reservedFrom: dotyposReservation.reservedFrom,
          reservedUntil: dotyposReservation.reservedUntil,
        };
      }
    );
    const customerRows = meetingRoomEmailDetails(reservation, "en-US");
    const internalRows = meetingRoomEmailDetails(reservation, "cs-CZ");
    const customerText =
      renderWorkspaceEmailDetailsText(customerRows).join("\n");
    const internalText =
      renderWorkspaceEmailDetailsText(internalRows).join("\n");

    yield* tryWorkspaceE2ESync(
      "assert whole-day reservation email previews",
      () => {
        const customerDate = formatReservationDisplayDate(
          reservation.reservedFrom,
          "en-US"
        );
        const internalDate = formatReservationDisplayDate(
          reservation.reservedFrom,
          "cs-CZ"
        );
        const customerTimeRange = formatReservationDisplayTimeRange(
          reservation.reservedFrom,
          reservation.reservedUntil,
          "en-US"
        );
        const internalTimeRange = formatReservationDisplayTimeRange(
          reservation.reservedFrom,
          reservation.reservedUntil,
          "cs-CZ"
        );

        assert(
          customerRows[1]?.value === customerDate &&
            customerRows[2]?.value === "whole day",
          "customer email detail rows do not match the confirmed calendar day"
        );
        assert(
          internalRows[1]?.value === internalDate &&
            internalRows[2]?.value === "celý den",
          "internal email detail rows do not match the confirmed calendar day"
        );
        assert(
          customerText.includes(customerDate) &&
            customerText.includes("whole day"),
          "customer email does not present the confirmed calendar day"
        );
        assert(
          internalText.includes(internalDate) &&
            internalText.includes("celý den"),
          "internal email does not present the confirmed calendar day"
        );
        assert(
          !customerText.includes(customerTimeRange),
          "customer email exposes the whole-day midnight time range"
        );
        assert(
          !internalText.includes(internalTimeRange),
          "internal email exposes the whole-day midnight time range"
        );
      }
    );
    log("Whole-day reservation email previews validated");
  });

const assertFulfillmentFailedSupportPath = ({
  config,
  data,
  orderId,
  runStep,
  openSession,
}: {
  config: WorkspaceE2EConfig;
  data: CheckoutData;
  orderId: CheckoutRow["reservation_id"];
  runStep: CheckoutStepRunner<unknown>;
  openSession: OpenE2EBrowserSession;
}): Effect.Effect<void, WorkspaceE2EError, E2EDatabase> =>
  Effect.gen(function* () {
    // Each step reaches the browser itself, so a browser that fails to open
    // stays attributed to the step that needed it.
    const inBrowser = <A>(
      drive: (browser: E2EBrowserSession) => Effect.Effect<A, WorkspaceE2EError>
    ) => Effect.flatMap(openSession, drive);
    yield* runStep({
      execute: markFulfillmentFailedForE2E(orderId),
      id: "mark-fulfillment-failed-for-support-path",
      timeoutMs: config.timeouts.datasource,
    });
    yield* runStep({
      execute: Effect.gen(function* () {
        const statusUrl = yield* makeUrl(
          "build fulfillment failed checkout status URL",
          `${config.baseUrl}/${data.locale}/reservation/status/${orderId}`
        );
        yield* setSearchParams(statusUrl, {
          e2eAt: String(Date.now()),
        });
        yield* inBrowser((browser) =>
          openPage(browser, config, statusUrl.toString(), {
            timeoutMs: config.timeouts.browserNavigation,
          })
        );
      }),
      id: "open-fulfillment-failed-status-page",
      timeoutMs: config.timeouts.browserNavigation,
    });
    yield* runStep({
      execute: inBrowser((browser) =>
        waitForPageText({
          description: "fulfillment failed support link",
          matches: (text) =>
            /couldn't deliver your confirmation/i.test(text) &&
            /Send support request/i.test(text),
          session: browser,
          timeoutMs: config.timeouts.uiTransition,
        })
      ),
      id: "wait-for-fulfillment-support-link",
      timeoutMs: config.timeouts.uiTransition,
    });
    yield* runStep({
      execute: inBrowser((browser) =>
        assertPageCheck(
          browser,
          "assert fulfillment failed support link",
          findFulfillmentSupportLinkProblem,
          { locale: data.locale, orderId },
          { timeoutMs: config.timeouts.browserAction }
        )
      ),
      id: "assert-fulfillment-support-link",
      timeoutMs: config.timeouts.browserAction,
    });
    yield* runStep({
      execute: inBrowser((browser) =>
        activateHydratedElement(browser, "#checkout-status-support-contact", {
          timeoutMs: config.timeouts.browserAction,
        })
      ),
      id: "activate-fulfillment-support-link",
      timeoutMs: config.timeouts.browserAction,
    });
    yield* runStep({
      execute: inBrowser((browser) =>
        waitForPageUrl({
          description: "fulfillment failed support contact page",
          matches: (url) => {
            const parsed = parseUrl(url);
            return (
              parsed?.pathname === `/${data.locale}/contact` &&
              (parsed.searchParams.get("message") ?? "").includes(orderId)
            );
          },
          session: browser,
          timeoutMs: config.timeouts.uiTransition,
        })
      ),
      id: "reach-fulfillment-support-contact-page",
      timeoutMs: config.timeouts.uiTransition,
    });
    log("Fulfillment failed support path e2e passed");
  });

/**
 * Runs in the browser: why the fulfillment-failed status page does not offer
 * a support request for `orderId` on the locale's contact page, or `null`
 * when it does. It must not close over anything.
 */
export const findFulfillmentSupportLinkProblem = ({
  locale,
  orderId,
}: {
  readonly locale: string;
  readonly orderId: string;
}): string | null => {
  const text = document.body?.textContent ?? "";
  if (!/couldn't deliver your confirmation/i.test(text)) {
    return "fulfillment failed status copy not visible";
  }
  const link = [...document.querySelectorAll("a")].find((candidate) =>
    /Send support request/i.test(candidate.textContent ?? "")
  );
  if (!(link instanceof HTMLAnchorElement)) {
    return "support contact link not found";
  }
  const url = new URL(link.href);
  if (url.pathname !== `/${locale}/contact`) {
    return "support contact link points at unexpected path";
  }
  if (!(url.searchParams.get("message") ?? "").includes(orderId)) {
    return "support contact message missing order id";
  }
  return null;
};
