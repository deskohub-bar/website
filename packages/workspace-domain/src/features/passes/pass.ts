import { currencyCZK } from "../../shared/money/currencies";
import { type Money, sameMoneyUnit } from "../../shared/money/money";
import type { EntryPackSize } from "./pass-offer";

export const passStatuses = [
  "pending_payment",
  "active",
  "depleted",
  "expired",
  "cancelled",
  "withdrawn",
  "void",
] as const;
export type PassStatus = (typeof passStatuses)[number];

export const passEntryClaimStatuses = [
  "reserved",
  "consumed",
  "released",
] as const;
export type PassEntryClaimStatus = (typeof passEntryClaimStatuses)[number];

/** The refund is based on the accepted CZK price after discounts. */
export const getEntryPackWithdrawalRefund = (input: {
  readonly paid: Money;
  readonly size: EntryPackSize;
  readonly unusedEntries: number;
}): Money => {
  const { paid, size, unusedEntries } = input;
  if (
    !sameMoneyUnit(paid, currencyCZK(0)) ||
    !Number.isSafeInteger(paid.value) ||
    paid.value < 0 ||
    !Number.isInteger(unusedEntries) ||
    unusedEntries < 0 ||
    unusedEntries > size
  ) {
    throw new RangeError(
      "Invalid Entry pack withdrawal amount or entry count."
    );
  }
  const wholeKoruna =
    (BigInt(paid.value) * BigInt(unusedEntries)) / (BigInt(size) * 100n);
  return currencyCZK(Number(wholeKoruna * 100n));
};
