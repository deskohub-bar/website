import { describe, expect, test } from "bun:test";
import { currencyCZK } from "@/shared/money/currencies";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  getPassCancellationRefund,
  getPassShorteningRefund,
  remainingPassRefundValue,
} from "./pass-adjustments";

const date = plainDateStringSchema.make;

describe("pass adjustment refunds", () => {
  test("uses the current validity length for pack shortening and 30 days for Unlimited", () => {
    const period = {
      validFrom: date("2026-11-01"),
      validUntil: date("2027-01-01"),
      newValidUntil: date("2026-12-27"),
      paid: currencyCZK(100_000),
    };
    expect(getPassShorteningRefund({ ...period, product: "entry-pack" })).toBe(
      8_100
    );
    expect(getPassShorteningRefund({ ...period, product: "unlimited" })).toBe(
      16_600
    );
  });

  test("uses unused entries for a pack and excludes today from the Unlimited refund", () => {
    const terms = { paid: currencyCZK(100_000), today: date("2026-11-21") };
    expect(
      getPassCancellationRefund({
        ...terms,
        product: "entry-pack",
        entryCount: 5,
        unusedEntries: 2,
      })
    ).toBe(40_000);
    expect(
      getPassCancellationRefund({
        ...terms,
        product: "unlimited",
        validFrom: date("2026-11-20"),
      })
    ).toBe(93_300);
  });

  test("reserves both a pending obligation and already observed provider refunds", () => {
    expect(remainingPassRefundValue(100_000, 60_000, 10_000)).toBe(40_000);
    expect(remainingPassRefundValue(100_000, 25_000, 60_000)).toBe(40_000);
    expect(remainingPassRefundValue(100_000, 100_000, 0)).toBe(0);
  });

  test("credits an earlier refund when the same Unlimited days are removed again", () => {
    expect(
      getPassShorteningRefund({
        product: "unlimited",
        paid: currencyCZK(3_000_00),
        validFrom: date("2026-11-01"),
        validUntil: date("2026-12-01"),
        newValidUntil: date("2026-11-26"),
        credits: [
          {
            from: date("2026-11-27"),
            until: date("2026-12-01"),
            value: 40_000,
          },
        ],
      })
    ).toBe(10_000);
  });
});
