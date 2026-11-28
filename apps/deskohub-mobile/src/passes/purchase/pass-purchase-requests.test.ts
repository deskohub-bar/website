import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import type {
  BeginCustomerPassPurchase,
  CustomerPassPurchase,
} from "@deskohub/workspace-customer-api";
import {
  makeCustomerDataRegistry,
  makeFakeCustomerData,
  settle,
} from "../../customer-api/testing/customer-data-test-registry";
import {
  fakeCustomerDataLayer,
  makeFakeDevice,
} from "../../customer-api/testing/fake-customer-data";
import { FakeWorkspace } from "../../customer-api/testing/fake-workspace";
import { passCatalogAtom } from "../pass-reads";
import {
  beginPassPurchaseAtom,
  passPaymentPayload,
  passPaymentReturnUrl,
  passPurchaseStatusHref,
  submitPassPurchaseAtom,
} from "./pass-purchase-requests";

const orderId = "01942447-f9dc-7000-8000-000000000001";
const initial: BeginCustomerPassPurchase = {
  orderId,
  locale: "en-US",
  product: { kind: "entry-pack", tier: "open-space", size: 5 },
  holderEmail: testEmailAddress("gift"),
};

describe("pass purchase requests", () => {
  test("honors a closed release gate on the typed customer route", async () => {
    const { registry, workspace } = makeFakeCustomerData();
    expect(await settle(registry, passCatalogAtom)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerPassesUnavailable" },
    });
    expect(workspace.calls.map(String)).toEqual(["listPassOffers"]);
  });

  test("does not send protected details under a different account", async () => {
    const device = makeFakeDevice();
    const workspace = FakeWorkspace.forKind("linked");
    const registry = makeCustomerDataRegistry(
      fakeCustomerDataLayer({
        workspace,
        device,
        session: { accountId: "different-account" },
      })
    );
    const unmount = registry.mount(beginPassPurchaseAtom);

    registry.set(beginPassPurchaseAtom, { payload: initial });
    const outcome = await settle(registry, beginPassPurchaseAtom);
    unmount();

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerSessionRequired" },
    });
    expect(workspace.calls.map(String)).toEqual(["getSession"]);
    expect(device.sessionChecks).toBe(1);
  });

  test("an expired session cannot replay its pending purchase", async () => {
    const { registry, workspace } = makeFakeCustomerData();
    const unmount = registry.mount(beginPassPurchaseAtom);
    workspace.signedIn = false;

    registry.set(beginPassPurchaseAtom, { payload: initial });
    const outcome = await settle(registry, beginPassPurchaseAtom);
    unmount();

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerSessionRequired" },
    });
    expect(workspace.calls.map(String)).toEqual(["getSession"]);
  });

  test("the current account reaches the typed purchase endpoint after auth recheck", async () => {
    const { registry, workspace } = makeFakeCustomerData();
    const unmount = registry.mount(beginPassPurchaseAtom);

    registry.set(beginPassPurchaseAtom, { payload: initial });
    const outcome = await settle(registry, beginPassPurchaseAtom);
    unmount();

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerPassesUnavailable" },
    });
    expect(workspace.calls.map(String)).toEqual([
      "getSession",
      "beginPassPurchase",
    ]);
  });

  test("rechecks ownership after auth and leaves when the buyer dismisses payment", async () => {
    const { registry, workspace } = makeFakeCustomerData();
    const unmount = registry.mount(submitPassPurchaseAtom);
    registry.set(submitPassPurchaseAtom, {
      orderId,
      owns: () => false,
      payload: {
        productKind: "entry-pack",
        accepted: true,
        acceptedDocuments: [],
        displayedPriceFingerprint: "a".repeat(64),
      },
    });
    expect(await settle(registry, submitPassPurchaseAtom)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "PassPurchaseViewChanged" },
    });
    expect(workspace.calls.map(String)).toEqual(["getSession"]);
    unmount();
  });

  test("a hosted return resumes the buyer's pass order in the app", () => {
    const href = passPurchaseStatusHref(orderId);
    expect(passPaymentReturnUrl(orderId)).toBe(
      `deskohub://passes/purchases/${orderId}?after=payment`
    );
    expect(href.params).toEqual({ orderId, after: "payment" });
    expect(href.pathname).toBe("/passes/purchases/[orderId]");
  });
});

describe("pass Pay approval", () => {
  const money = { value: 1_000_00, exponent: 2, currency: "CZK" };
  const quote: CustomerPassPurchase = {
    orderId,
    product: {
      kind: "unlimited",
      selection: { tier: "open-space", startDate: "2026-12-01", coffee: false },
    },
    payPath: "/pay",
    statusPath: "/status",
    validFrom: "2026-12-01",
    lastUsableDate: "2026-12-30",
    price: {
      subtotal: money,
      total: money,
      fingerprint: "a".repeat(64),
      discounts: [],
    },
    disclosure: {
      documents: [
        {
          key: "terms-and-conditions",
          hash: "terms-hash",
          hashAlgorithm: "sha256",
          path: "/en-US/terms-and-conditions",
        },
        {
          key: "operating-rules",
          hash: "rules-hash",
          hashAlgorithm: "sha256",
          path: "/en-US/operating-rules",
        },
      ],
      earlyStartRequest: "The dated disclosure from the Workspace.",
    },
  };

  test("sends the approved documents and exact price with business billing", () => {
    const billing = {
      purpose: "business" as const,
      invoice: "required" as const,
      buyer: {
        kind: "business" as const,
        legalName: "Test Company",
        companyId: "01234567",
        address: {
          line1: "Test Street 1",
          city: "Praha",
          postalCode: "18000",
          country: "CZ",
        },
      },
    };
    expect(passPaymentPayload(quote, billing, "native-app")).toEqual({
      productKind: "unlimited",
      accepted: true,
      acceptedDocuments: [
        { key: "terms-and-conditions", hash: "terms-hash" },
        { key: "operating-rules", hash: "rules-hash" },
      ],
      unlimitedEarlyStartAccepted: true,
      displayedPriceFingerprint: "a".repeat(64),
      billing,
      returnTarget: "native-app",
    });
  });

  test("only affirms early Unlimited start when the server disclosed it", () => {
    const billing = { purpose: "personal" as const, invoice: "none" as const };
    expect(
      passPaymentPayload(
        { ...quote, disclosure: { documents: quote.disclosure.documents } },
        billing,
        "web-app"
      )
    ).not.toHaveProperty("unlimitedEarlyStartAccepted");
  });
});
