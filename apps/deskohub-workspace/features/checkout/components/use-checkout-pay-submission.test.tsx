import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { buildCoworkCheckoutSummary } from "@/features/checkout/checkout-quote.test-utils";
import { m } from "@/features/i18n";
import {
  type WorkspaceActionExecute,
  workspaceRouterPush,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { checkoutPaymentActionCallbacks } from "./checkout-payment.test-utils";
import { openTestPaymentWindow } from "./payment-window-fixture";
import type { StartCheckoutPaymentAction } from "./use-checkout-pay-submission";

mock.module("server-only", () => ({}));
const submitReservationActions = await import(
  "@/features/reservation/actions/submit-reservation"
);
mock.module("@/features/reservation/actions/submit-reservation", () => ({
  ...submitReservationActions,
  submitReservation: mock(),
}));

const { useCheckoutPaySubmission } = await import(
  "./use-checkout-pay-submission"
);

type ActionState = NonNullable<ReturnType<typeof workspaceUseAction>>;

type PaymentActionData = Awaited<
  ReturnType<StartCheckoutPaymentAction>
>["data"];

const submitError = m.checkoutPaySubmitError({}, { locale: "en-US" });
const statusUrl = "/en-US/reservation/status/reservation-hook";
const statusOwnerKey = `deskohub:checkout-status-owner:${statusUrl}`;

const renderSubmission = ({
  actionState = { isExecuting: false, result: {} },
  earlyPerformanceRequestRequired = true,
  payStateToken = "signed-summary",
}: {
  readonly actionState?: ActionState;
  readonly earlyPerformanceRequestRequired?: boolean;
  readonly payStateToken?: string;
} = {}) => {
  const execute = mock<WorkspaceActionExecute>();
  workspaceUseAction.mockReturnValue({ ...actionState, execute });
  const hook = renderHook(() =>
    useCheckoutPaySubmission({
      earlyPerformanceRequestRequired,
      locale: "en-US",
      payStateToken,
    })
  );
  const options = checkoutPaymentActionCallbacks<PaymentActionData>(execute);
  const submitPayment = () => {
    act(() => {
      hook.result.current.setLegalConsent(true);
    });
    act(() => {
      hook.result.current.submit("card");
    });
  };
  return { execute, hook, options, submitPayment };
};

describe("useCheckoutPaySubmission", () => {
  beforeAll(() => {
    registerWorkspaceComponentTestEnv();
  });

  beforeEach(() => {
    workspaceRouterPush.mockClear();
    workspaceUseAction.mockClear();
  });

  afterEach(() => {
    cleanup();
    sessionStorage.removeItem(statusOwnerKey);
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await unregisterWorkspaceComponentTestEnv();
  });

  test("sends the tab to the fresh Pay page after a price change", () => {
    const openWindow = spyOn(window, "open");
    const { hook, options, submitPayment } = renderSubmission();
    submitPayment();

    act(() => {
      options.onSuccess({
        data: {
          status: "pricing_changed",
          message: "",
          freshPayUrl: "/en-US/fresh-pay",
          changedKeys: { sectionKeys: ["total"], itemKeys: [] },
          freshSummary: buildCoworkCheckoutSummary({
            entryTier: "basic",
            coffee: false,
          }),
        },
      });
    });

    expect(workspaceRouterPush).toHaveBeenCalledWith("/en-US/fresh-pay");
    expect(openWindow).not.toHaveBeenCalled();
    expect(hook.result.current.errorMessage).toBeNull();
  });

  test.each([
    ["a checkout already in progress", { status: "in_progress", message: "" }],
    [
      "a redirect without a gateway URL",
      { status: "redirect", redirectUrl: "", message: "" },
    ],
    ["no result", undefined],
  ] as const)("shows the submit error for %s", (_name, data) => {
    const openWindow = spyOn(window, "open");
    const { hook, options, submitPayment } = renderSubmission();
    submitPayment();

    act(() => {
      options.onSuccess({ data });
    });

    expect(hook.result.current.errorMessage).toBe(submitError);
    expect(workspaceRouterPush).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  test("opens the gateway in an owned payment tab and sends this tab to status", () => {
    const paymentWindow = openTestPaymentWindow();
    const openWindow = spyOn(window, "open").mockImplementation(
      () => paymentWindow
    );
    const { options, submitPayment } = renderSubmission();
    submitPayment();

    act(() => {
      options.onSuccess({
        data: {
          status: "redirect",
          message: "",
          redirectUrl: "https://payments.example.test/checkout",
          statusUrl,
        },
      });
    });

    expect(openWindow).toHaveBeenCalledWith(
      "https://payments.example.test/checkout",
      "_blank"
    );
    expect(paymentWindow.opener).toBeNull();
    expect(sessionStorage.getItem(statusOwnerKey)).toBe("true");
    expect(workspaceRouterPush).toHaveBeenCalledWith(statusUrl);
  });

  test("sends this tab straight to a gateway URL without a status page", () => {
    const openWindow = spyOn(window, "open");
    const { options, submitPayment } = renderSubmission();
    submitPayment();

    act(() => {
      options.onSuccess({
        data: {
          status: "redirect",
          message: "",
          redirectUrl: `${statusUrl}?outcome=success`,
        },
      });
    });

    expect(openWindow).not.toHaveBeenCalled();
    expect(workspaceRouterPush).toHaveBeenCalledWith(
      `${statusUrl}?outcome=success`
    );
  });

  test("navigates this tab to the gateway when the browser blocks the payment tab", () => {
    const openWindow = spyOn(window, "open").mockImplementation(() => null);
    const { options, submitPayment } = renderSubmission();
    submitPayment();

    act(() => {
      options.onSuccess({
        data: {
          status: "redirect",
          message: "",
          redirectUrl: "https://payments.example.test/checkout",
          statusUrl,
        },
      });
    });

    expect(openWindow).toHaveBeenCalledWith(
      "https://payments.example.test/checkout",
      "_blank"
    );
    expect(workspaceRouterPush).toHaveBeenCalledWith(
      "https://payments.example.test/checkout"
    );
    expect(sessionStorage.getItem(statusOwnerKey)).toBeNull();
  });

  test("shows the server's error message, or the submit error without one", () => {
    const { hook, options, submitPayment } = renderSubmission();
    submitPayment();

    act(() => {
      options.onError({ error: { serverError: "Server refused." } });
    });
    expect(hook.result.current.errorMessage).toBe("Server refused.");

    act(() => {
      options.onError({ error: {} });
    });
    expect(hook.result.current.errorMessage).toBe(submitError);
  });

  test("submits the consent with the early-performance request when it is required", () => {
    const { execute, hook, options, submitPayment } = renderSubmission();
    submitPayment();

    act(() => {
      options.onTransportError();
    });
    expect(hook.result.current.errorMessage).toBe(submitError);

    submitPayment();

    expect(hook.result.current.errorMessage).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith({
      locale: "en-US",
      payStateToken: "signed-summary",
      legalConsent: true,
      earlyPerformanceConsent: true,
    });
  });

  test("submits without the early-performance consent when the request is not required", () => {
    const { execute, hook } = renderSubmission({
      earlyPerformanceRequestRequired: false,
    });

    act(() => {
      hook.result.current.setLegalConsent(true);
    });
    act(() => {
      hook.result.current.submit("card");
    });

    expect(execute).toHaveBeenCalledWith({
      locale: "en-US",
      payStateToken: "signed-summary",
      legalConsent: true,
    });
  });

  test("does not start payment before legal consent", () => {
    const { execute, hook } = renderSubmission();

    act(() => {
      hook.result.current.submit("card");
    });

    expect(execute).not.toHaveBeenCalled();
    expect(hook.result.current.errorMessage).toBeNull();
  });

  test("refuses to submit without a Pay state", () => {
    const { execute, hook } = renderSubmission({ payStateToken: "" });

    act(() => {
      hook.result.current.setLegalConsent(true);
    });
    act(() => {
      hook.result.current.submit("card");
    });

    expect(execute).not.toHaveBeenCalled();
    expect(hook.result.current.errorMessage).toBe(submitError);
  });

  test.each([
    ["while the action runs", { isExecuting: true, result: {} }],
    [
      "after a price change redirect",
      { isExecuting: false, result: { data: { status: "pricing_changed" } } },
    ],
    [
      "after a gateway redirect",
      { isExecuting: false, result: { data: { status: "redirect" } } },
    ],
  ] as const)(
    "stays pending and ignores another submit %s",
    (_name, actionState) => {
      const { execute, hook } = renderSubmission({ actionState });

      expect(hook.result.current.isSubmitPending).toBe(true);
      act(() => {
        hook.result.current.setLegalConsent(true);
      });
      act(() => {
        hook.result.current.submit("card");
      });
      expect(execute).not.toHaveBeenCalled();
    }
  );

  test("is not pending after a checkout already in progress", () => {
    const { hook } = renderSubmission({
      actionState: {
        isExecuting: false,
        result: { data: { status: "in_progress" } },
      },
    });

    expect(hook.result.current.isSubmitPending).toBe(false);
  });
});
