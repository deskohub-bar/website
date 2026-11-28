import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { preparePaymentRetry } from "@/features/checkout/actions/prepare-payment-retry";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  type WorkspaceActionExecute,
  workspaceRouterPush,
  workspaceRouterRefresh,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { checkoutPaymentActionCallbacks } from "./checkout-payment.test-utils";

mock.module("@/features/checkout/actions/prepare-payment-retry", () => ({
  preparePaymentRetry: mock(),
}));
const leaveDocument = mock((_url: string) => true);
mock.module("@/shared/browser/document-navigation", () => ({
  leaveDocument,
}));

const { CheckoutStatusPaymentRetry } = await import(
  "./checkout-status-payment-retry"
);

type PaymentActionData = NonNullable<
  Awaited<ReturnType<typeof preparePaymentRetry>>
>["data"];

const orderId = workspaceReservationIdSchema.make("reservation-retry");

const renderRetry = ({ isExecuting = false } = {}) => {
  const execute = mock<WorkspaceActionExecute>();
  workspaceUseAction.mockReturnValue({ execute, isExecuting });
  const view = render(
    <CheckoutStatusPaymentRetry
      className="actions"
      fallback={
        <a href="/en-US/reservation/cowork" id="checkout-status-reserve-again">
          again
        </a>
      }
      locale="en-US"
      orderId={orderId}
    >
      <a href="/en-US">home</a>
    </CheckoutStatusPaymentRetry>
  );
  const options = checkoutPaymentActionCallbacks<PaymentActionData>(execute);
  const button = () =>
    view.container.querySelector("#checkout-status-try-payment-again");
  const fallback = () =>
    view.container.querySelector("#checkout-status-reserve-again");
  const requiredButton = () => {
    const element = button();
    assert(
      element instanceof HTMLButtonElement,
      "Payment retry button missing"
    );
    return element;
  };
  return { button, execute, fallback, options, requiredButton, view };
};

describe("CheckoutStatusPaymentRetry", () => {
  beforeAll(() => {
    registerWorkspaceComponentTestEnv();
  });

  beforeEach(() => {
    workspaceRouterPush.mockClear();
    workspaceRouterRefresh.mockClear();
    workspaceUseAction.mockClear();
    leaveDocument.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    await unregisterWorkspaceComponentTestEnv();
  });

  test("leads the action row with its button, keeping the fallback back", () => {
    const { button, fallback, view } = renderRetry();

    const row = view.container.querySelector(".actions");
    expect(row?.firstElementChild).toBe(button());
    expect(fallback()).toBeNull();
    expect(view.getByRole("alert").textContent).toBe("");
  });

  test("asks to retry the order with only the order and locale", () => {
    const { requiredButton, execute } = renderRetry();

    fireEvent.click(requiredButton());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ locale: "en-US", orderId });
  });

  test("is disabled while the request runs", () => {
    const { requiredButton, execute } = renderRetry({ isExecuting: true });

    expect(requiredButton().disabled).toBe(true);
    fireEvent.click(requiredButton());
    expect(execute).not.toHaveBeenCalled();
  });

  test("opens the retry's Pay page as a new document", () => {
    const { options, requiredButton } = renderRetry();
    fireEvent.click(requiredButton());

    act(() => {
      options.onSuccess({
        data: { state: "ready", payUrl: "/en-US/checkout/pay?orderId=x" },
      });
    });

    expect(leaveDocument).toHaveBeenCalledWith("/en-US/checkout/pay?orderId=x");
    expect(workspaceRouterPush).not.toHaveBeenCalled();
  });

  test.each(["refused", "spot_unavailable"] as const)(
    "puts the new reservation in the button's place when the retry is %s",
    (state) => {
      const { button, fallback, options, requiredButton, view } = renderRetry();
      fireEvent.click(requiredButton());

      act(() => {
        options.onSuccess({ data: { state } });
      });

      expect(button()).toBeNull();
      expect(fallback()).not.toBeNull();
      expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
      expect(
        view.container.querySelector("#checkout-status-payment-retry-refusal")
      ).toEqual(state === "spot_unavailable" ? expect.anything() : null);
    }
  );

  test("only refreshes the status while the earlier payment may settle", () => {
    const { button, fallback, options, requiredButton } = renderRetry();
    fireEvent.click(requiredButton());

    act(() => {
      options.onSuccess({ data: { state: "payment_settling" } });
    });

    expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    expect(button()).not.toBeNull();
    expect(fallback()).toBeNull();
  });

  test("shows a failure in its alert region", () => {
    const { options, requiredButton, view } = renderRetry();
    fireEvent.click(requiredButton());

    act(() => {
      options.onTransportError();
    });

    expect(view.getByRole("alert").textContent).not.toBe("");
  });
});
