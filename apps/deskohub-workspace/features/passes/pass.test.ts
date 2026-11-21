import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  getWorkspaceProductTargetsCovering,
  workspaceProductTargetMatches,
  workspaceProductTargetSchema,
} from "@/features/discounts/product-target";
import { currencyCZK } from "@/shared/money/currencies";
import { getEntryPackWithdrawalRefund } from "./pass";
import {
  entryPackOffers,
  getEntryPackValidity,
  unlimitedPassOffers,
} from "./pass-offer";

describe("pass catalog", () => {
  test("prices all nine offers in CZK", () => {
    expect(entryPackOffers.map(({ price }) => price)).toEqual(
      [1150, 2190, 1590, 3090, 2050, 3990].map((amount) =>
        currencyCZK(amount * 100)
      )
    );
    expect(unlimitedPassOffers.map(({ price }) => price)).toEqual(
      [3490, 5990, 8490].map((amount) => currencyCZK(amount * 100))
    );
  });

  test("adds calendar months to the Prague date, with an exclusive expiry", () => {
    const purchasedAt = Temporal.Instant.from("2027-07-30T22:30:00Z");
    expect(getEntryPackValidity(purchasedAt, 5)).toEqual({
      validFrom: "2027-07-31",
      validUntil: "2027-09-30",
    });
    expect(getEntryPackValidity(purchasedAt, 10)).toEqual({
      validFrom: "2027-07-31",
      validUntil: "2027-10-31",
    });
  });

  test("discount targets cover the pass family or exact offer", () => {
    const product = {
      kind: "entry-pack",
      size: 5,
      tier: "open-space",
    } as const;
    expect(getWorkspaceProductTargetsCovering(product)).toEqual([
      { kind: "entry-pack" },
      product,
    ]);
    expect(workspaceProductTargetMatches(product, product)).toBe(true);
    expect(
      workspaceProductTargetMatches({ ...product, size: 10 }, product)
    ).toBe(false);
    expect(workspaceProductTargetMatches({ kind: "cowork" }, product)).toBe(
      false
    );
    expect(
      Schema.decodeUnknownSync(workspaceProductTargetSchema)(product)
    ).toEqual(product);
    expect(() =>
      Schema.decodeUnknownSync(workspaceProductTargetSchema)({
        ...product,
        size: 6,
      })
    ).toThrow();
  });
});

describe("Entry pack withdrawal", () => {
  test("uses the paid price and rounds down to a whole koruna", () => {
    expect(
      getEntryPackWithdrawalRefund({
        paid: currencyCZK(97_749),
        size: 5,
        unusedEntries: 3,
      })
    ).toEqual(currencyCZK(58_600));
  });

  test("refunds nothing when no entry is unused", () => {
    expect(
      getEntryPackWithdrawalRefund({
        paid: currencyCZK(115_000),
        size: 5,
        unusedEntries: 0,
      })
    ).toEqual(currencyCZK(0));
  });

  test("rejects an unused count greater than the pack size", () => {
    expect(() =>
      getEntryPackWithdrawalRefund({
        paid: currencyCZK(115_000),
        size: 5,
        unusedEntries: 6,
      })
    ).toThrow(RangeError);
  });
});
