import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import type {
  CustomerPassCatalog,
  CustomerUnlimitedStartDates,
} from "@deskohub/workspace-customer-api";
import {
  advertisedPassPrice,
  initializePassSelection,
  readPassPurchasePrefill,
  selectedPassProduct,
} from "./pass-purchase-selection";

const today = "2026-12-01";
const next = "2026-12-02";
const prices = (value: number) => ({ value, exponent: 2, currency: "CZK" });

const catalog: CustomerPassCatalog = {
  entryPacks: [
    {
      product: { kind: "entry-pack", tier: "open-space", size: 5 },
      price: prices(99900),
      validityMonths: 3,
    },
    {
      product: {
        kind: "entry-pack",
        tier: "reserved-desk-workstation",
        size: 10,
      },
      price: prices(399900),
      validityMonths: 6,
    },
  ],
  unlimited: [
    {
      product: { kind: "unlimited", tier: "open-space" },
      price: prices(349000),
      validityDays: 30,
    },
    {
      product: { kind: "unlimited", tier: "reserved-desk-workstation" },
      price: prices(699000),
      validityDays: 30,
    },
  ],
  unlimitedCoffeePrice: prices(99000),
};

const dates: CustomerUnlimitedStartDates = {
  today,
  lastStartDate: next,
  starts: {
    "open-space": [today, next],
    "reserved-desk": [today],
    "reserved-desk-workstation": {
      "2x27-4k": [today],
      "2x27-qhd": [next],
      "2x32-4k": [],
      "2x32-qhd": [],
    },
  },
};

describe("pass purchase prefill", () => {
  test("copies only public, compatible fields from a current reservation draft", () => {
    const input = {
      tier: "reserved-desk",
      size: "10",
      monitorOption: "2x27-4k",
      coffee: "1",
      startDate: today,
      email: testEmailAddress("example"),
    };
    expect(readPassPurchasePrefill("unlimited", input)).toEqual({
      tier: "reserved-desk-workstation",
      size: 10,
      monitorOption: "2x27-4k",
      coffee: false,
      startDate: today,
    });
    expect(readPassPurchasePrefill("entry-pack", input)).toEqual({
      tier: "reserved-desk-workstation",
      size: 10,
      monitorOption: "2x27-4k",
      coffee: false,
    });
  });

  test("ignores ambiguous parameters and impossible dates", () => {
    expect(
      readPassPurchasePrefill("unlimited", {
        tier: ["open-space", "reserved-desk"],
        startDate: "2026-02-31",
      })
    ).toEqual({ tier: "open-space", size: 5, coffee: false });
  });

  test("revalidates the prefilled date against the selected monitor's capacity", () => {
    const choice = readPassPurchasePrefill("unlimited", {
      tier: "reserved-desk",
      monitorOption: "2x27-qhd",
      startDate: today,
    });
    const initial = initializePassSelection(
      "unlimited",
      choice,
      catalog,
      dates
    );

    expect(initial.startDate).toBeUndefined();
    expect(
      selectedPassProduct("unlimited", choice, catalog, dates)
    ).toBeUndefined();
    expect(
      selectedPassProduct(
        "unlimited",
        { ...initial, startDate: next },
        catalog,
        dates
      )
    ).toEqual({
      kind: "unlimited",
      selection: {
        tier: "reserved-desk-workstation",
        monitorOption: "2x27-qhd",
        startDate: next,
      },
    });
  });

  test("uses the offered pack size and quotes the Open Space coffee choice", () => {
    const pack = readPassPurchasePrefill("entry-pack", {
      tier: "reserved-desk-workstation",
      size: "10",
    });
    expect(selectedPassProduct("entry-pack", pack, catalog)).toEqual({
      kind: "entry-pack",
      tier: "reserved-desk-workstation",
      size: 10,
    });
    expect(
      selectedPassProduct("entry-pack", { ...pack, size: 5 }, catalog)
    ).toBeUndefined();

    const unlimited = readPassPurchasePrefill("unlimited", {
      tier: "open-space",
      coffee: "1",
    });
    expect(advertisedPassPrice("unlimited", unlimited, catalog)).toEqual(
      prices(448000)
    );
  });
});
