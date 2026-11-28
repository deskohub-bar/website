import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { testEmailAddress } from "@deskohub/test-email";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { m } from "@/features/i18n";
import { getPaymentSubmitLegalDocuments } from "@/features/legal/payment-submit-evidence";
import { orderIdSchema } from "@/features/order";
import { currencyCZK } from "@/shared/money/currencies";
import { elementOf } from "@/shared/testing/dom-element.test-utils";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

const locale = "en-US";
const product = { kind: "entry-pack", tier: "open-space", size: 5 } as const;
const begin = Promise.withResolvers<unknown>();
type BeginInput = Parameters<
  typeof import("../entry-pack-checkout-actions").beginEntryPackCheckout
>[0];
const beginCheckout = mock((_input: BeginInput) => begin.promise);
type PayInput = Parameters<
  typeof import("../entry-pack-checkout-actions").payEntryPackCheckout
>[0];
type PayResult = Awaited<
  ReturnType<
    typeof import("../entry-pack-checkout-actions").payEntryPackCheckout
  >
>;
const payCheckout = mock(
  async (_input: PayInput): Promise<PayResult> => ({
    data: { status: "purchase_error", reason: "unavailable" },
  })
);
mock.module("../entry-pack-checkout-actions", () => ({
  beginEntryPackCheckout: beginCheckout,
  payEntryPackCheckout: payCheckout,
  repriceEntryPackCheckout: mock(),
}));
mock.module("next/image", () => ({ default: () => null }));

registerWorkspaceComponentTestEnv();
const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { EntryPackCheckout } = await import("./entry-pack-checkout");
const { EntryPackPay } = await import("./entry-pack-pay");
afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("an earlier Details response cannot open Pay after the buyer changes packs", async () => {
  const buyerEmail = testEmailAddress("pack-superseded-buyer");
  const replaceState = spyOn(window.history, "replaceState");
  const view = render(
    <EntryPackCheckout
      discountCodeEntryEnabled={false}
      locale={locale}
      buyer={{ kind: "linked", email: buyerEmail, name: "Fixture Buyer" }}
      initialProduct={product}
      initialStep="details"
      validity={{ 5: "2027-01-18", 10: "2027-02-18" }}
    />
  );
  fireEvent.click(
    view.getByRole("button", { name: m.checkoutContinueButton({}, { locale }) })
  );
  await waitFor(() => expect(beginCheckout).toHaveBeenCalledTimes(1));
  expect(beginCheckout.mock.calls[0]?.[0].orderId).toMatch(/^[0-9a-f-]{36}$/);
  expect(replaceState).not.toHaveBeenCalled();
  replaceState.mockRestore();

  fireEvent.click(view.getByRole("button", { name: /choose your pack/i }));
  fireEvent.click(view.getByRole("radio", { name: /10 entries/i }));
  await act(async () => {
    begin.resolve({
      data: {
        status: "ready",
        product,
        price: {
          fingerprint: "0".repeat(64),
          subtotal: currencyCZK(115_000),
          total: currencyCZK(115_000),
          discounts: [],
        },
        validFrom: "2026-11-19",
        lastUsableDate: "2027-01-18",
        disclosure: { documents: [], earlyStartRequest: "" },
      },
    });
  });

  expect(
    view.queryByRole("heading", { name: m.checkoutPayTitle({}, { locale }) })
  ).toBeNull();
  expect(
    elementOf(
      view.getByRole("radio", { name: /10 entries/i }),
      HTMLInputElement
    ).checked
  ).toBe(true);
});

test("sign-in after selecting a new pack drops the previous draft order", () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const view = render(
    <EntryPackCheckout
      discountCodeEntryEnabled={false}
      locale={locale}
      buyer={{ kind: "signed-out" }}
      initialProduct={product}
      initialStep="details"
      continuation={{ orderId }}
      validity={{}}
    />
  );
  const signInReturn = () => {
    const href = view
      .getByRole("link", {
        name: m.accountSignInTitle({}, { locale }),
      })
      .getAttribute("href");
    assert(href);
    const returnTo = new URL(href, "https://deskohub.example").searchParams.get(
      "returnTo"
    );
    assert(returnTo);
    return new URL(returnTo, "https://deskohub.example").searchParams;
  };
  expect(signInReturn().get("order")).toBe(orderId);
  fireEvent.click(view.getByRole("button", { name: /choose your pack/i }));
  fireEvent.click(view.getByRole("radio", { name: /10 entries/i }));
  fireEvent.click(
    view.getByRole("button", { name: m.checkoutContinueButton({}, { locale }) })
  );
  expect(signInReturn().get("size")).toBe("10");
  expect(signInReturn().has("order")).toBe(false);
});

test("Details retries the same request without exposing a failed draft in the URL", async () => {
  beginCheckout.mockClear();
  beginCheckout.mockResolvedValueOnce({ serverError: "Try again" });
  beginCheckout.mockResolvedValueOnce({ serverError: "Try again" });
  const replaceState = spyOn(window.history, "replaceState");
  try {
    const view = render(
      <EntryPackCheckout
        discountCodeEntryEnabled={false}
        locale={locale}
        buyer={{
          kind: "linked",
          email: testEmailAddress("pack-retry-buyer"),
          name: "Fixture Buyer",
        }}
        initialProduct={product}
        initialStep="details"
        validity={{}}
      />
    );
    const submit = view.getByRole("button", {
      name: m.checkoutContinueButton({}, { locale }),
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe("Try again")
    );
    expect(replaceState).not.toHaveBeenCalled();
    fireEvent.click(submit);
    await waitFor(() => expect(beginCheckout).toHaveBeenCalledTimes(2));
    expect(beginCheckout.mock.calls[1]?.[0].orderId).toBe(
      beginCheckout.mock.calls[0]?.[0].orderId
    );
    expect(replaceState).not.toHaveBeenCalled();
  } finally {
    replaceState.mockRestore();
  }
});

test("Choose and Details keep an owned draft's date until the selected pack changes", () => {
  const view = render(
    <EntryPackCheckout
      discountCodeEntryEnabled={false}
      locale={locale}
      buyer={{
        kind: "linked",
        email: testEmailAddress("pack-resume-buyer"),
        name: "Fixture Buyer",
      }}
      initialProduct={product}
      initialStep="details"
      continuation={{
        orderId: orderIdSchema.make(crypto.randomUUID()),
        validUntil: "2027-01-18",
      }}
      validity={{ 5: "2027-01-19", 10: "2027-02-19" }}
    />
  );
  expect(view.getByText("Jan 18, 2027")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: /choose your pack/i }));
  expect(view.getByText(/until Jan 18, 2027/)).toBeDefined();
  fireEvent.click(view.getByRole("radio", { name: /^Reserved Desk from/ }));
  expect(view.getByText(/until Jan 19, 2027/)).toBeDefined();
  fireEvent.click(
    view.getByRole("button", { name: m.checkoutContinueButton({}, { locale }) })
  );
  expect(view.getByText("Jan 19, 2027")).toBeDefined();
  expect(view.queryByText("Jan 18, 2027")).toBeNull();
});

test("Pay removes the applied-code label after repricing keeps a different discount", async () => {
  const code = "PACK-EXAMPLE";
  const appliedCodeLabel = m.entryPackCheckoutCodeApplied({ code }, { locale });
  const customerDiscount = {
    id: "customer-discount",
    label: "Customer discount",
    amount: currencyCZK(1_000),
  };
  const refreshedPrice = {
    fingerprint: "1".repeat(64),
    subtotal: currencyCZK(115_000),
    total: currencyCZK(114_000),
    discounts: [customerDiscount],
  };
  payCheckout.mockImplementationOnce(async () => ({
    data: { status: "pricing_changed", price: refreshedPrice },
  }));
  const view = render(
    <EntryPackPay
      discountCodeEntryEnabled
      locale={locale}
      orderId={orderIdSchema.make(crypto.randomUUID())}
      state={{
        status: "ready",
        product,
        price: {
          ...refreshedPrice,
          fingerprint: "0".repeat(64),
          total: currencyCZK(112_000),
          appliedDiscountCode: code,
          discounts: [
            customerDiscount,
            { id: "voucher", label: "Voucher", amount: currencyCZK(2_000) },
          ],
        },
        validFrom: "2026-11-19",
        lastUsableDate: "2027-01-18",
        disclosure: {
          documents: getPaymentSubmitLegalDocuments(locale),
          earlyStartRequest: m.passEarlyStartConsent({}, { locale }),
        },
        billing: { purpose: "personal", invoice: "none" },
      }}
      headingRef={null}
      onExpire={() => {}}
      onRequestPayment={() => {}}
    />
  );
  expect(view.getByText(appliedCodeLabel)).toBeDefined();
  expect(view.getByText(/^Voucher ·/)).toBeDefined();
  fireEvent.click(view.getByRole("checkbox"));
  fireEvent.click(view.getByRole("button", { name: /order and pay/i }));

  const codeInput = await view.findByLabelText(
    m.checkoutDiscountCodeLabel({}, { locale })
  );
  expect(codeInput).toHaveProperty("value", "");
  expect(view.queryByText(appliedCodeLabel)).toBeNull();
  expect(view.getByText(/customer discount/i)).toBeDefined();
  expect(view.queryByText(/^Voucher ·/)).toBeNull();
});

test.each([true, false])(
  "Pay submits billing and legal evidence with code entry enabled: %s",
  async (discountCodeEntryEnabled) => {
    const orderId = orderIdSchema.make(crypto.randomUUID());
    const retryApproval = discountCodeEntryEnabled
      ? {}
      : {
          priorPaymentAttemptId: paymentAttemptIdSchema.make(
            crypto.randomUUID()
          ),
        };
    const documents = getPaymentSubmitLegalDocuments(locale);
    const billing = { purpose: "personal", invoice: "none" } as const;
    const fingerprint = "0".repeat(64);
    const view = render(
      <EntryPackPay
        discountCodeEntryEnabled={discountCodeEntryEnabled}
        locale={locale}
        orderId={orderId}
        state={{
          ...retryApproval,
          status: "ready",
          product,
          price: {
            fingerprint,
            subtotal: currencyCZK(115_000),
            total: currencyCZK(115_000),
            discounts: [],
          },
          validFrom: "2026-11-19",
          lastUsableDate: "2027-01-18",
          disclosure: {
            documents,
            earlyStartRequest: m.passEarlyStartConsent({}, { locale }),
          },
          billing,
        }}
        headingRef={null}
        onExpire={() => {}}
        onRequestPayment={() => {}}
      />
    );
    expect(
      Boolean(
        view.queryByLabelText(m.checkoutDiscountCodeLabel({}, { locale }))
      )
    ).toBe(discountCodeEntryEnabled);
    const pay = view.getByRole("button", { name: /order and pay/i });
    expect(pay).toHaveProperty("disabled", true);
    expect(view.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(pay);
    await waitFor(() =>
      expect(payCheckout).toHaveBeenCalledWith({
        ...retryApproval,
        orderId,
        locale,
        accepted: true,
        acceptedDocuments: documents.map(({ key, hash }) => ({ key, hash })),
        billing,
        displayedPriceFingerprint: fingerprint,
      })
    );
  }
);
