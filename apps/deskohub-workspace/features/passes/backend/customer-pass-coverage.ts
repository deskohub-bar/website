import "server-only";

import type { DotyposCustomerId } from "@deskohub/dotypos";
import { and, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";
import {
  WorkspaceDatabase,
  workspaceStatementConcurrency,
} from "@/db/database.service";
import { customerAccounts } from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { getCoworkBookingPasses } from "@/features/cowork/cowork-entry-packs";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { getUnlimitedPassAccessDay } from "../unlimited-pass-period";
import { getUnlimitedDisplayStatus } from "./customer-pass-reads";
import { listHeldEntryPacks } from "./held-entry-packs";
import { listHeldUnlimitedPasses } from "./held-unlimited-passes";

/**
 * Whether a held Unlimited pass covers its holder's cowork visits from
 * `date`: the account page shows it as active or upcoming.
 */
export const isCurrentUnlimitedPass = (
  pass: Parameters<typeof getUnlimitedDisplayStatus>[0],
  date: Temporal.PlainDate
) => {
  const issued =
    pass.paymentState === "paid" || pass.paymentState === "complimentary";
  const accessDay = getUnlimitedPassAccessDay({ ...pass, date });
  const status = getUnlimitedDisplayStatus(
    pass,
    plainDateStringSchema.make(date.toString()),
    issued,
    accessDay
  );
  return status === "active" || status === "upcoming";
};

/**
 * Whether the account holds a pass that covers its cowork visits at
 * `asOf`. Its two reads share `workspaceStatementConcurrency`, so they run
 * one at a time inside a transaction.
 */
const accountHoldsCoveringPass = Effect.fn("accountHoldsCoveringPass")(
  function* (accountId: CustomerAccountId, asOf: Temporal.Instant) {
    const date = getWorkspaceDate(asOf);
    const today = plainDateStringSchema.make(date.toString());
    const [packs, unlimitedPasses] = yield* Effect.all(
      [listHeldEntryPacks(accountId), listHeldUnlimitedPasses(accountId)],
      { concurrency: yield* workspaceStatementConcurrency }
    );
    if (getCoworkBookingPasses(packs, today).packs.length > 0) return true;
    return unlimitedPasses.some((pass) => isCurrentUnlimitedPass(pass, date));
  }
);

/**
 * The Dotypos customers whose live account holds a pass that covers their
 * cowork visits at `asOf`: an Entry pack they can book with now (the
 * account page's bookable rule), or an Unlimited pass the account page
 * shows as active or upcoming. A customer without a live account holds no
 * pass. One read finds the accounts; each account's passes are read in
 * turn.
 */
export const customersHoldingCoveringPass = Effect.fn(
  "customersHoldingCoveringPass"
)(function* (
  dotyposCustomerIds: readonly DotyposCustomerId[],
  asOf: Temporal.Instant
) {
  const holders = new Set<DotyposCustomerId>();
  if (dotyposCustomerIds.length === 0) return holders;
  const { db } = yield* WorkspaceDatabase;
  const accounts = yield* db
    .select({
      id: customerAccounts.id,
      dotyposCustomerId: customerAccounts.dotyposCustomerId,
    })
    .from(customerAccounts)
    .where(
      and(
        inArray(customerAccounts.dotyposCustomerId, [...dotyposCustomerIds]),
        isNull(customerAccounts.deletedAt)
      )
    );
  for (const account of accounts) {
    if (
      account.dotyposCustomerId !== null &&
      !holders.has(account.dotyposCustomerId) &&
      (yield* accountHoldsCoveringPass(account.id, asOf))
    )
      holders.add(account.dotyposCustomerId);
  }
  return holders;
});

/** Whether one Dotypos customer holds a covering pass at `asOf`. */
export const customerHoldsCoveringPass = (
  dotyposCustomerId: DotyposCustomerId,
  asOf: Temporal.Instant
) =>
  customersHoldingCoveringPass([dotyposCustomerId], asOf).pipe(
    Effect.map((holders) => holders.has(dotyposCustomerId))
  );
