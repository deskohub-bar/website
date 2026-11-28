import type { Money } from "@/shared/money/money";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { getEntryPackWithdrawalRefund } from "../pass";
import { type EntryPackSize, unlimitedPassDays } from "../pass-offer";
import { getUnlimitedPassWithdrawal } from "../unlimited-pass";

const daysBetween = (start: PlainDate, end: PlainDate) =>
  Temporal.PlainDate.from(start).until(end).days;

/** Operator forms show the final service date. Pass periods use an exclusive end. */
export const passValidityEnd = (lastDay: PlainDate) =>
  plainDateStringSchema.make(
    Temporal.PlainDate.from(lastDay).add({ days: 1 }).toString()
  );

export const remainingPassRefundValue = (
  paid: number,
  target: number,
  refunded: number
) => Math.max(0, paid - Math.max(target, refunded));

export type PassRefundCredit = {
  readonly from: PlainDate;
  readonly until: PlainDate;
  readonly value: number;
};

export function getPassShorteningRefund(input: {
  readonly product: "entry-pack" | "unlimited";
  readonly paid: Money;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
  readonly newValidUntil: PlainDate;
  readonly credits?: readonly PassRefundCredit[];
}): number {
  const removedDays = daysBetween(input.newValidUntil, input.validUntil);
  const totalDays =
    input.product === "unlimited"
      ? unlimitedPassDays
      : daysBetween(input.validFrom, input.validUntil);
  if (removedDays <= 0 || totalDays <= 0) return 0;
  const wholeKoruna =
    (BigInt(input.paid.value) * BigInt(Math.min(removedDays, totalDays))) /
    (BigInt(totalDays) * 100n);
  const prior = (input.credits ?? []).reduce((total, credit) => {
    const from =
      credit.from > input.newValidUntil ? credit.from : input.newValidUntil;
    const until =
      credit.until < input.validUntil ? credit.until : input.validUntil;
    if (from >= until) return total;
    return (
      total +
      Math.floor(
        (credit.value * daysBetween(from, until)) /
          daysBetween(credit.from, credit.until)
      )
    );
  }, 0);
  return Math.max(0, Number(wholeKoruna * 100n) - prior);
}

type PassCancellationTerms = {
  readonly paid: Money;
  readonly today: PlainDate;
} & (
  | {
      readonly product: "entry-pack";
      readonly entryCount: EntryPackSize;
      readonly unusedEntries: number;
    }
  | { readonly product: "unlimited"; readonly validFrom: PlainDate }
);

export function getPassCancellationRefund(
  terms: PassCancellationTerms
): number {
  if (terms.product === "entry-pack") {
    return getEntryPackWithdrawalRefund({
      paid: terms.paid,
      size: terms.entryCount,
      unusedEntries: terms.unusedEntries,
    }).value;
  }
  return getUnlimitedPassWithdrawal({
    startDate: terms.validFrom,
    withdrawalDate: terms.today,
    paid: terms.paid,
  }).refund.value;
}
