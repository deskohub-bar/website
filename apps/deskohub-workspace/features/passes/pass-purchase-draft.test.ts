import { describe, expect, test } from "bun:test";
import { getAccountSignInPath } from "@/features/account/routes";
import { getPricingPath } from "@/features/pricing/pricing-path";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { getEntryPackPurchasePath } from "./entry-pack-discovery";
import {
  getCoworkPassPurchaseDraft,
  getPassPurchaseDraftQuery,
  readPassPurchaseDraft,
} from "./pass-purchase-draft";
import {
  getUnlimitedPassDetailsPath,
  readUnlimitedPassSelection,
} from "./unlimited-pass-checkout";
import { getUnlimitedPassPurchasePath } from "./unlimited-pass-discovery";

const startDate = plainDateStringSchema.make("2099-07-30");
const queryOf = (path: string) =>
  Object.fromEntries(new URL(path, "https://workspace.example").searchParams);

describe("getCoworkPassPurchaseDraft", () => {
  test("keeps Open Space coffee only while it's chosen", () => {
    expect(
      getCoworkPassPurchaseDraft({
        entryTier: "open-space",
        date: startDate,
        coffee: true,
      })
    ).toEqual({ tier: "open-space", coffee: true, startDate });
    expect(
      getCoworkPassPurchaseDraft({
        entryTier: "open-space",
        date: startDate,
        coffee: false,
      })
    ).toEqual({ tier: "open-space", startDate });
  });

  test("names a Reserved Desk with a monitor option as the workstation tier", () => {
    expect(
      getCoworkPassPurchaseDraft({
        entryTier: "reserved-desk",
        date: startDate,
        coffee: true,
        monitorOption: "2x27-4k",
      })
    ).toEqual({
      tier: "reserved-desk-workstation",
      monitorOption: "2x27-4k",
      startDate,
    });
    expect(
      getCoworkPassPurchaseDraft({
        entryTier: "reserved-desk",
        date: startDate,
        coffee: true,
      })
    ).toEqual({ tier: "reserved-desk", startDate });
    // The form holds an empty monitor choice once the workstation is off.
    expect(
      getCoworkPassPurchaseDraft({
        entryTier: "reserved-desk",
        date: startDate,
        monitorOption: "",
      })
    ).toEqual({ tier: "reserved-desk", startDate });
  });

  test("leaves the start date open when the draft has no valid day", () => {
    for (const date of ["", undefined, "30.07.2099"]) {
      expect(
        getCoworkPassPurchaseDraft({ entryTier: "reserved-desk", date })
      ).toEqual({ tier: "reserved-desk" });
    }
  });

  test("gives no draft for a tier no pass covers", () => {
    expect(
      getCoworkPassPurchaseDraft({ entryTier: "profi", date: startDate })
    ).toBeUndefined();
  });
});

describe("purchase links", () => {
  test("an Entry pack link names the tier and never a reservation date", () => {
    const draft = getCoworkPassPurchaseDraft({
      entryTier: "reserved-desk",
      date: startDate,
      monitorOption: "2x32-qhd",
    });
    if (!draft) throw new Error("Expected a draft");
    const path = getEntryPackPurchasePath("en-US", draft.tier);
    expect(path).toBe(
      "/en-US/passes/entry-pack?tier=reserved-desk-workstation"
    );
  });

  test("an Unlimited link keeps only the add-ons its tier sells", () => {
    const draft = {
      coffee: true,
      monitorOption: "2x32-qhd",
      startDate,
    } as const;
    expect(
      queryOf(
        getUnlimitedPassPurchasePath("en-US", { ...draft, tier: "open-space" })
      )
    ).toEqual({ tier: "open-space", startDate, coffee: "true" });
    expect(
      queryOf(
        getUnlimitedPassPurchasePath("en-US", {
          ...draft,
          tier: "reserved-desk-workstation",
        })
      )
    ).toEqual({
      tier: "reserved-desk-workstation",
      startDate,
      monitorOption: "2x32-qhd",
    });
    expect(
      getUnlimitedPassPurchasePath("cs-CZ", { tier: "reserved-desk" })
    ).toBe("/cs-CZ/passes/unlimited?tier=reserved-desk");
  });

  test("Pricing carries a draft in the purchase pages' parameter names", () => {
    const draft = {
      tier: "reserved-desk-workstation",
      monitorOption: "2x27-qhd",
      startDate,
    } as const;
    const path = getPricingPath("de-DE", draft);
    expect(path.startsWith("/de-DE/pricing?")).toBe(true);
    expect(readPassPurchaseDraft(queryOf(path))).toEqual(draft);
    expect(getPricingPath("de-DE")).toBe("/de-DE/pricing");
    expect(getPricingPath("de-DE", {})).toBe("/de-DE/pricing");
  });
});

describe("readPassPurchaseDraft", () => {
  test("round-trips a written draft", () => {
    const draft = {
      tier: "open-space",
      coffee: true,
      startDate,
    } as const;
    expect(
      readPassPurchaseDraft(
        Object.fromEntries(getPassPurchaseDraftQuery(draft))
      )
    ).toEqual(draft);
  });

  test("drops values no purchase page accepts and every contact field", () => {
    expect(
      readPassPurchaseDraft({
        tier: "hot-desk",
        coffee: "yes",
        monitorOption: "1x24",
        startDate: "tomorrow",
        name: "Ada",
        phone: "+420777777777",
      })
    ).toEqual({});
  });
});

test("a draft carried through Pricing reaches the sign-in return path of Unlimited checkout", () => {
  const pricingPath = getPricingPath("en-US", {
    tier: "open-space",
    coffee: true,
    startDate,
  });
  // Pricing's Open Space row links the draft on to the purchase page.
  const purchasePath = getUnlimitedPassPurchasePath("en-US", {
    ...readPassPurchaseDraft(queryOf(pricingPath)),
    tier: "open-space",
  });
  // The purchase page reads it and its Details step sends a signed-out
  // buyer to sign in with a return path to the same selection.
  const { options, startDate: chosenStart } = readUnlimitedPassSelection(
    queryOf(purchasePath)
  );
  const signIn = new URL(
    getAccountSignInPath(
      "en-US",
      getUnlimitedPassDetailsPath("en-US", {
        ...options,
        startDate: chosenStart,
      })
    ),
    "https://workspace.example"
  );
  const [returnTo] = [...signIn.searchParams.values()];
  if (!returnTo) throw new Error("Expected a sign-in return path");
  const returned = new URL(returnTo, "https://workspace.example");
  expect(returned.pathname).toBe("/en-US/passes/unlimited");
  expect(
    readPassPurchaseDraft(Object.fromEntries(returned.searchParams))
  ).toEqual({
    tier: "open-space",
    coffee: true,
    startDate,
  });
  // Contact and billing details never travel in these public links.
  for (const url of [pricingPath, purchasePath, signIn.toString(), returnTo]) {
    const params = [
      ...new URL(url, "https://workspace.example").searchParams.keys(),
    ];
    for (const protectedParam of [
      "name",
      "email",
      "phone",
      "customer",
      "contact",
      "billing",
    ]) {
      expect(params).not.toContain(protectedParam);
    }
  }
});
