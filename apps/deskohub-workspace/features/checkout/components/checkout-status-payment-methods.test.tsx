import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { RouteAutoRefresh } from "@/shared/components/route-auto-refresh";
import {
  type WorkspaceActionExecute,
  workspaceRouterRefresh,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { checkoutPaymentActionCallbacks } from "./checkout-payment.test-utils";
import {
  CheckoutStatusPaymentMethods,
  type ContinueCheckoutPaymentAction,
} from "./checkout-status-payment-methods";
import { openTestPaymentWindow } from "./payment-window-fixture";

type PaymentActionData = Awaited<
  ReturnType<ContinueCheckoutPaymentAction>
>["data"];

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  sessionStorage.clear();
  workspaceRouterRefresh.mockClear();
});

test("switches from card to QR and reopens card on the same reservation", () => {
  jest.useFakeTimers({ now: new Date("2026-11-19T14:29:59Z") });
  const execute = mock<WorkspaceActionExecute>();
  workspaceUseAction.mockReturnValue({ execute, isExecuting: false });
  const continuePaymentAction = mock(async () => ({}));
  const orderId = workspaceReservationIdSchema.make(
    "658d5a17-1ccc-4d97-baab-6cbb015125ca"
  );
  const checkout = {
    continuePaymentAction,
    expiresAt: "2026-11-19T14:30:00Z",
    headline: null,
    locale: "en-US",
    orderId,
  } as const;
  const view = render(<CheckoutStatusPaymentMethods {...checkout} />);

  expect(view.queryByRole("img")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show QR payment" }));
  expect(execute).toHaveBeenLastCalledWith({
    locale: "en-US",
    method: "qr",
    orderId,
  });

  const actionOptions =
    checkoutPaymentActionCallbacks<PaymentActionData>(execute);
  act(() => actionOptions.onSuccess({ data: { status: "qr_pending" } }));
  expect(workspaceRouterRefresh).toHaveBeenCalled();

  view.rerender(
    <CheckoutStatusPaymentMethods
      {...checkout}
      qrWait={{
        supportHref: "/en-US/contact",
        payment: {
          accountNumber: "19-2000145399/0800",
          amount: "CZK 450.50",
          deadline: "Nov 19, 2026, 3:30 PM",
          expiresAt: checkout.expiresAt,
          qrCodeSource: "data:image/png;base64,iVBORw0KGgo=",
          variableSymbol: "0012345678",
        },
      }}
    />
  );
  expect(view.getByRole("img", { name: "Bank transfer QR code" })).toBeTruthy();
  expect(document.activeElement).toBe(
    view.getByRole("region", { name: "QR bank transfer" })
  );
  expect(view.queryByRole("button", { name: "Show QR payment" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Switch to card payment" }));
  expect(execute).toHaveBeenLastCalledWith({
    locale: "en-US",
    method: "card",
    orderId,
  });
  const paymentWindow = openTestPaymentWindow();
  const open = spyOn(window, "open").mockReturnValue(paymentWindow);
  const redirectUrl = "https://payments.example.test/same-hosted-session";
  act(() =>
    actionOptions.onSuccess({ data: { status: "redirect", redirectUrl } })
  );
  expect(open).toHaveBeenCalledWith(redirectUrl, "_blank");
  open.mockRestore();
});

test("stops showing payment instructions and both methods at expiry while the status refresh is pending", () => {
  const expiresAt = "2026-11-20T14:30:00.000Z";
  jest.useFakeTimers({ now: new Date("2026-11-20T14:29:59.000Z") });
  const checkout = {
    continuePaymentAction: mock(async () => ({})),
    expiresAt,
    headline: null,
    locale: "en-US",
    orderId: workspaceReservationIdSchema.make(
      "658d5a17-1ccc-4d97-baab-6cbb015125ca"
    ),
  } as const;
  // The mock router never delivers replacement server props.
  const view = render(
    <>
      <RouteAutoRefresh enabled={false} refreshAt={expiresAt} />
      <CheckoutStatusPaymentMethods {...checkout} />
      <CheckoutStatusPaymentMethods
        {...checkout}
        qrWait={{
          supportHref: "/en-US/contact",
          payment: {
            accountNumber: "19-2000145399/0800",
            amount: "CZK 450.50",
            deadline: "Nov 20, 2026, 3:30 PM",
            expiresAt,
            qrCodeSource: "data:image/png;base64,iVBORw0KGgo=",
            variableSymbol: "0012345678",
          },
        }}
      />
    </>
  );

  expect(view.getByRole("img", { name: "Bank transfer QR code" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Show QR payment" })).toBeTruthy();
  act(() => jest.advanceTimersByTime(1000));

  expect(workspaceRouterRefresh).toHaveBeenCalled();
  expect(view.queryByRole("img")).toBeNull();
  expect(view.queryByText("0012345678")).toBeNull();
  expect(view.queryByRole("button", { name: "Show QR payment" })).toBeNull();
  expect(
    view.queryAllByRole("button", { name: "Continue to card payment" })
  ).toHaveLength(0);
  expect(
    view.queryByRole("button", { name: "Switch to card payment" })
  ).toBeNull();
});

test("restores a sent transfer for only its order and payment window", () => {
  const start = new Date("2026-11-20T14:00:00Z");
  jest.useFakeTimers({ now: start });
  const execute = mock<WorkspaceActionExecute>();
  workspaceUseAction.mockReturnValue({ execute, isExecuting: false });
  const checkout = {
    continuePaymentAction: mock(async () => ({})),
    expiresAt: "2026-11-20T14:30:00Z",
    headline: <h1>Waiting for payment</h1>,
    locale: "en-US",
    orderId: workspaceReservationIdSchema.make(
      "658d5a17-1ccc-4d97-baab-6cbb015125ca"
    ),
    qrWait: {
      supportHref: "/en-US/contact",
      payment: {
        accountNumber: "19-2000145399/0800",
        amount: "CZK 450.50",
        deadline: "Nov 20, 2026, 3:30 PM",
        expiresAt: "2026-11-20T14:30:00Z",
        qrCodeSource: "data:image/png;base64,iVBORw0KGgo=",
        variableSymbol: "0012345678",
      },
    },
  } as const;

  const view = render(<CheckoutStatusPaymentMethods {...checkout} />);
  fireEvent.click(view.getByRole("button", { name: "Payment sent" }));
  expect(execute).not.toHaveBeenCalled();
  expect(workspaceRouterRefresh).not.toHaveBeenCalled();
  expect(
    view.queryByRole("button", { name: "Switch to card payment" })
  ).toBeNull();
  expect(document.activeElement).toBe(
    view.getByRole("heading", { name: "Waiting for payment to arrive." })
  );
  expect(view.getByRole("timer").textContent).toBe("1:00");
  view.unmount();

  jest.setSystemTime(new Date(start.getTime() + 60_000));
  const restored = render(<CheckoutStatusPaymentMethods {...checkout} />);
  expect(restored.getByRole("timer").textContent).toBe("5:00");
  expect(
    restored.getByText("Please check that the payment left your account.")
  ).toBeTruthy();

  restored.rerender(
    <CheckoutStatusPaymentMethods
      {...checkout}
      orderId={workspaceReservationIdSchema.make(
        "4e94cfaa-950d-441c-bc6d-5d4abc74a5b2"
      )}
    />
  );
  expect(restored.getByRole("button", { name: "Payment sent" })).toBeTruthy();

  restored.rerender(
    <CheckoutStatusPaymentMethods
      {...checkout}
      expiresAt="2026-11-20T14:31:00Z"
    />
  );
  expect(restored.getByRole("button", { name: "Payment sent" })).toBeTruthy();

  restored.rerender(
    <CheckoutStatusPaymentMethods {...checkout} qrWait={undefined} />
  );
  expect(
    restored.getByRole("button", { name: "Show QR payment" })
  ).toBeTruthy();
  expect(restored.queryByRole("timer")).toBeNull();
});
