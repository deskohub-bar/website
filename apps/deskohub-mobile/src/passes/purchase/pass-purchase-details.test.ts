import { describe, expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Option } from "effect";
import {
  type DetailsProfile,
  initialDetailsDraft,
} from "../../booking/checkout-screen/details-form";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import type { PurchaseDetails } from "./pass-purchase-details";

mock.module("expo-router", () => expoRouterStandIn());
const { validatePurchaseDetails } = await import("./pass-purchase-details");

const profile: DetailsProfile = {
  self: {
    email: testEmailAddress("buyer"),
    name: Option.some("Test Buyer"),
    phone: Option.none(),
  },
  saved: {
    address: Option.none(),
    company: Option.some({
      legalName: "Test Company",
      companyId: "01234567",
      vatId: "",
      address: {
        line1: "Test Street 1",
        city: "Praha",
        postalCode: "18000",
        country: "CZ",
      },
    }),
  },
};

const initial: PurchaseDetails = {
  invoice: initialDetailsDraft(profile.saved, "CZ"),
  buyer: { firstName: "", lastName: "", phone: "" },
  gift: false,
  holderEmail: testEmailAddress("unused"),
  recipientName: "Unused",
};

describe("pass purchase Details", () => {
  test("uses the existing company invoice profile and keeps this a self-purchase", () => {
    const details = {
      ...initial,
      invoice: { ...initial.invoice, billing: "business" as const },
    };

    expect(
      validatePurchaseDetails("entry-pack", details, profile, false)
    ).toEqual({
      ok: true,
      billing: {
        purpose: "business",
        invoice: "required",
        buyer: {
          kind: "business",
          legalName: "Test Company",
          companyId: "01234567",
          address: {
            line1: "Test Street 1",
            city: "Praha",
            postalCode: "18000",
            country: "CZ",
          },
        },
      },
      input: {},
    });
  });

  test("uses one recipient email for a gift and requires the Unlimited recipient name", () => {
    const details = { ...initial, gift: true, recipientName: "" };

    expect(
      validatePurchaseDetails("entry-pack", details, profile, false)
    ).toMatchObject({
      ok: true,
      input: { holderEmail: testEmailAddress("unused") },
    });
    expect(
      validatePurchaseDetails("unlimited", details, profile, false)
    ).toEqual({
      ok: false,
      problems: { recipientName: true },
    });
    expect(
      validatePurchaseDetails(
        "unlimited",
        { ...details, recipientName: "Test Holder" },
        profile,
        false
      )
    ).toMatchObject({
      ok: true,
      input: {
        holderEmail: testEmailAddress("unused"),
        recipientName: "Test Holder",
      },
    });
  });

  test("rejects using the same email for the buyer and a gift holder", () => {
    expect(
      validatePurchaseDetails(
        "entry-pack",
        { ...initial, gift: true, holderEmail: testEmailAddress("BUYER") },
        profile,
        false
      )
    ).toEqual({ ok: false, problems: { holderEmail: true } });
  });
});

const { elementTree, findAll, hostTree } = await import(
  "../../ui/testing/element-tree"
);
const siteNavigation = { ...(await import("../../routing/open-site-page")) };
const openDocument = mock(async (_url: string) => undefined);
mock.module("../../routing/open-site-page", () => ({
  ...siteNavigation,
  openSitePage: openDocument,
}));
const { PassPurchaseAgreement } = await import("./pass-purchase-agreement");

test("uses one agreement for both policy documents and the actual early-start request", () => {
  const earlyStartRequest = "The service starts on the selected date.";
  const toggle = mock(() => undefined);
  const tree = hostTree(
    elementTree(PassPurchaseAgreement, {
      disclosure: {
        documents: [
          {
            key: "terms-and-conditions",
            hash: "terms",
            hashAlgorithm: "sha256",
            path: "/en-US/terms-and-conditions",
          },
          {
            key: "operating-rules",
            hash: "rules",
            hashAlgorithm: "sha256",
            path: "/en-US/operating-rules",
          },
        ],
        earlyStartRequest,
      },
      checked: false,
      disabled: false,
      onToggle: toggle,
      locale: "en-US",
    })
  );

  const checkboxes = findAll(tree, "Pressable").filter(
    ({ props }) => props.role === "checkbox"
  );
  expect(checkboxes).toHaveLength(1);
  expect(checkboxes[0]?.props).toMatchObject({
    "aria-checked": false,
    "aria-label": expect.stringContaining(earlyStartRequest),
  });
  const links = findAll(tree, "Text").filter(
    ({ props }) => props.role === "link"
  );
  expect(links).toHaveLength(2);
  const pressLink = links[0]?.props.onPress;
  if (typeof pressLink !== "function") throw new Error("Missing legal link");
  const stopPropagation = mock(() => undefined);

  pressLink({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(openDocument).toHaveBeenCalledTimes(1);
  expect(toggle).toHaveBeenCalledTimes(0);
});
