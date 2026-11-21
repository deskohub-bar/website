import { Schema } from "effect";
import { workspaceProductMonitorOptions } from "@/features/checkout/product-catalog";
import { currencyCZK } from "@/shared/money/currencies";
import { type Money, sameMoneyUnit } from "@/shared/money/money";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "./pass-offer";

const periodFields = { startDate: plainDateStringSchema };

export const unlimitedPassSelectionSchema = Schema.Union([
  Schema.Struct({
    ...periodFields,
    tier: Schema.Literal("open-space"),
    coffee: Schema.Boolean,
  }),
  Schema.Struct({ ...periodFields, tier: Schema.Literal("reserved-desk") }),
  Schema.Struct({
    ...periodFields,
    tier: Schema.Literal("reserved-desk-workstation"),
    monitorOption: Schema.Literals(workspaceProductMonitorOptions),
  }),
]);

export type UnlimitedPassSelection = typeof unlimitedPassSelectionSchema.Type;

export const getUnlimitedPassEndDate = (startDate: PlainDate): PlainDate =>
  plainDateStringSchema.make(
    Temporal.PlainDate.from(startDate)
      .add({ days: unlimitedPassDays })
      .toString()
  );

export function unlimitedPassRequiresEarlyStart(
  startDate: PlainDate,
  agreedOn: Temporal.PlainDate
) {
  return Temporal.PlainDate.compare(startDate, agreedOn.add({ days: 14 })) <= 0;
}

/** Withdrawal includes the current service date and releases later dates. */
export function getUnlimitedPassWithdrawal(input: {
  readonly startDate: PlainDate;
  readonly withdrawalDate: PlainDate;
  readonly paid: Money;
}) {
  const { startDate, withdrawalDate, paid } = input;
  if (
    !sameMoneyUnit(paid, currencyCZK(0)) ||
    !Number.isSafeInteger(paid.value) ||
    paid.value < 0
  ) {
    throw new RangeError("Invalid Unlimited pass payment amount.");
  }

  const start = Temporal.PlainDate.from(startDate);
  const withdrawnOn = Temporal.PlainDate.from(withdrawalDate);
  const elapsed = start.until(withdrawnOn).days + 1;
  if (elapsed <= 0) return { accessEndsOn: startDate, refund: paid };

  const usedDays = Math.min(elapsed, unlimitedPassDays);
  const wholeKoruna =
    (BigInt(paid.value) * BigInt(unlimitedPassDays - usedDays)) /
    (BigInt(unlimitedPassDays) * 100n);
  return {
    accessEndsOn: plainDateStringSchema.make(
      start.add({ days: usedDays }).toString()
    ),
    refund: currencyCZK(Number(wholeKoruna * 100n)),
  };
}
