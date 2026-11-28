import { expect, test } from "bun:test";
import type {
  CustomerHeldEntryPack,
  CustomerHeldUnlimitedPass,
  CustomerPassCatalog,
  CustomerPassList,
} from "@deskohub/workspace-customer-api";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { CoworkDraft } from "../booking/selection/cowork-selection";
import { CustomerViewError } from "../customer-api/customer-view-error";
import {
  coworkPassOfferCatalog,
  entryPackOfferSizes,
  unlimitedOffer,
  unlimitedOfferExpiry,
} from "./pass-offers";

const prices = (value: number) => ({ value, exponent: 2, currency: "CZK" });
const pack = (
  tier: "open-space" | "reserved-desk" | "reserved-desk-workstation",
  size: 5 | 10
) => ({
  product: { kind: "entry-pack" as const, tier, size },
  price: prices(size * 30000),
  validityMonths: 3,
});
const catalog: CustomerPassCatalog = {
  entryPacks: [
    pack("open-space", 10),
    pack("open-space", 5),
    pack("reserved-desk", 10),
  ],
  unlimited: [
    {
      product: { kind: "unlimited", tier: "reserved-desk" },
      price: prices(549000),
      validityDays: 30,
    },
    {
      product: { kind: "unlimited", tier: "open-space" },
      price: prices(349000),
      validityDays: 28,
    },
  ],
  unlimitedCoffeePrice: prices(49000),
};

test("the stub lists the tier's pack sizes, else every size on sale", () => {
  expect(entryPackOfferSizes(catalog, "open-space")).toEqual([5, 10]);
  expect(entryPackOfferSizes(catalog, "reserved-desk")).toEqual([10]);
  expect(entryPackOfferSizes(catalog, "reserved-desk-workstation")).toEqual([
    5, 10,
  ]);
  expect(
    entryPackOfferSizes({ ...catalog, entryPacks: [] }, "open-space")
  ).toEqual([]);
});

test("the Unlimited offer is the tier's, else the first on sale", () => {
  expect(unlimitedOffer(catalog, "open-space")?.validityDays).toBe(28);
  expect(
    unlimitedOffer(catalog, "reserved-desk-workstation")?.product.tier
  ).toBe("reserved-desk");
  expect(unlimitedOffer({ ...catalog, unlimited: [] }, "open-space")).toBe(
    undefined
  );
});

test("the expiry counts the validity from the draft's date, else today", () => {
  const draft: CoworkDraft = {
    tier: "open-space",
    stay: "day",
    date: Option.none(),
    coffee: false,
    workstation: Option.none(),
  };
  expect(unlimitedOfferExpiry(draft, "2026-11-22", 30)).toBe("2026-12-22");
  expect(
    unlimitedOfferExpiry(
      { ...draft, date: Option.some("2027-01-10") },
      "2026-11-22",
      30
    )
  ).toBe("2027-02-09");
});

const heldPack = (bookFrom?: string): CustomerHeldEntryPack => ({
  kind: "entry-pack",
  tier: "open-space",
  status: "active",
  size: 5,
  passId: "642ef6b9-48aa-495f-83a8-9a53f4791692",
  boughtOn: "2026-11-20",
  validFrom: "2026-11-21",
  lastUsableDate: "2027-01-31",
  ...(bookFrom === undefined ? {} : { bookFrom }),
  bookedDates: [],
  entriesLeft: 5,
});
const held = (
  ...passes: CustomerPassList["held"]
): AsyncResult.AsyncResult<Pick<CustomerPassList, "held">, unknown> =>
  AsyncResult.success({ held: passes });
const offered = AsyncResult.success(catalog);

test("the offers show only while both pass reads succeed and no pack is applied or usable", () => {
  expect(
    coworkPassOfferCatalog({
      appliedPackId: undefined,
      catalog: offered,
      heldPasses: held(heldPack()),
    })
  ).toBe(catalog);
  // The passes rollout switched off: the catalog read fails as unavailable.
  expect(
    coworkPassOfferCatalog({
      appliedPackId: undefined,
      catalog: AsyncResult.failure(
        Cause.fail(CustomerViewError.FeatureUnavailable({ feature: "passes" }))
      ),
      heldPasses: held(),
    })
  ).toBe(undefined);
  expect(
    coworkPassOfferCatalog({
      appliedPackId: undefined,
      catalog: AsyncResult.initial(true),
      heldPasses: held(),
    })
  ).toBe(undefined);
  expect(
    coworkPassOfferCatalog({
      appliedPackId: undefined,
      catalog: offered,
      heldPasses: AsyncResult.initial(true),
    })
  ).toBe(undefined);
  // An applied pack, or a held one the banner offers instead.
  expect(
    coworkPassOfferCatalog({
      appliedPackId: "642ef6b9-48aa-495f-83a8-9a53f4791692",
      catalog: offered,
      heldPasses: held(),
    })
  ).toBe(undefined);
  expect(
    coworkPassOfferCatalog({
      appliedPackId: "642ef6b9-48aa-495f-83a8-9a53f4791692",
      catalog: offered,
      heldPasses: held(heldPack("2026-11-21")),
    })
  ).toBe(undefined);
  expect(
    coworkPassOfferCatalog({
      appliedPackId: undefined,
      catalog: offered,
      heldPasses: held(heldPack("2026-11-21")),
    })
  ).toBe(undefined);
});

const heldUnlimited = (
  status: CustomerHeldUnlimitedPass["status"]
): CustomerHeldUnlimitedPass => ({
  kind: "unlimited",
  tier: "open-space",
  status,
  passId: "0b3f8c1e-6f43-4c62-9a43-7f1d2b9e8a10",
  boughtOn: "2026-11-20",
  validFrom: "2026-11-21",
  lastUsableDate: "2026-12-20",
});

test("the offers hide while the customer holds an active or upcoming Unlimited pass", () => {
  for (const status of ["active", "upcoming"] as const) {
    expect(
      coworkPassOfferCatalog({
        appliedPackId: undefined,
        catalog: offered,
        heldPasses: held(heldUnlimited(status)),
      })
    ).toBe(undefined);
  }
  for (const status of ["expired", "ended"] as const) {
    expect(
      coworkPassOfferCatalog({
        appliedPackId: undefined,
        catalog: offered,
        heldPasses: held(heldUnlimited(status), heldPack()),
      })
    ).toBe(catalog);
  }
});
