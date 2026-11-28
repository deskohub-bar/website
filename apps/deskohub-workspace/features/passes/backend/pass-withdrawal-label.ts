import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { passPurchases } from "@/db/schema";
import { type Locale, m } from "@/features/i18n";
import type { WithdrawableContractKind } from "@/features/withdrawal/withdrawal-identifiers";
import { formatPlainDateRange } from "@/shared/utils/date-time-format";
import type { PlainDate } from "@/shared/utils/temporal";
import {
  type EntryPackSize,
  type PassTier,
  unlimitedPassDays,
} from "../pass-offer";
import { getPassTierName } from "../pass-offer.i18n";
import { decodePassWithdrawalOrderId } from "./pass-withdrawal-payment";

export const getPassWithdrawalLabel = (
  pass: {
    readonly entryCount: EntryPackSize | null;
    readonly tier: PassTier;
    readonly validFrom: PlainDate;
  },
  locale: Locale
) => {
  const tier = getPassTierName(pass.tier, locale);
  if (pass.entryCount !== null) {
    return [
      m.passEntryPack({}, { locale }),
      m.passEntryCount({ count: pass.entryCount }, { locale }),
      tier,
    ].join(" · ");
  }
  const start = Temporal.PlainDate.from(pass.validFrom);
  const dates = formatPlainDateRange({
    locale,
    start,
    end: start.add({ days: unlimitedPassDays - 1 }),
  });
  return [m.passUnlimited({}, { locale }), tier, dates].join(" · ");
};

export const readPassWithdrawalLabel = Effect.fn("readPassWithdrawalLabel")(
  function* (
    db: WorkspaceDatabaseClient,
    input: {
      readonly kind: Exclude<WithdrawableContractKind, "reservation">;
      readonly id: string;
      readonly locale: Locale;
    }
  ) {
    const id = decodePassWithdrawalOrderId(input.id);
    const product = input.kind === "entry-pack" ? "entry-pack" : "unlimited";
    if (Option.isSome(id)) {
      const [pass] = yield* db
        .select({
          entryCount: passPurchases.entryCount,
          tier: passPurchases.tier,
          validFrom: passPurchases.validFrom,
        })
        .from(passPurchases)
        .where(
          and(
            eq(passPurchases.id, id.value),
            eq(passPurchases.product, product)
          )
        );
      if (pass) return getPassWithdrawalLabel(pass, input.locale);
    }
    return (product === "entry-pack" ? m.passEntryPack : m.passUnlimited)(
      {},
      { locale: input.locale }
    );
  }
);
