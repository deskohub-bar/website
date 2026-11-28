import { and, eq, inArray, not, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { passPurchases } from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { PlainDate } from "@/shared/utils/temporal";
import { type PassTier, unlimitedPassDays } from "../pass-offer";
import { hasPendingPassChange } from "./pass-administration-pending";

export const keepsUnlimitedRenewalSource = Effect.fn(
  "keepsUnlimitedRenewalSource"
)(function* (
  db: WorkspaceDatabaseClient,
  purchase: Pick<
    typeof passPurchases.$inferSelect,
    "renewsPassId" | "holderAccountId" | "validFrom"
  >
) {
  if (!purchase.renewsPassId) return true;
  const [source] = yield* db
    .select({ id: passPurchases.id })
    .from(passPurchases)
    .where(
      and(
        eq(passPurchases.id, purchase.renewsPassId),
        eq(passPurchases.product, "unlimited"),
        eq(passPurchases.holderAccountId, purchase.holderAccountId),
        eq(passPurchases.validUntil, purchase.validFrom),
        inArray(passPurchases.status, [
          "active",
          "expired",
          "withdrawn",
          "cancelled",
        ]),
        not(hasPendingPassChange(db, passPurchases.id, "reassign"))
      )
    );
  return source !== undefined;
});

export const overlapsUnlimitedPassWindow = (
  pass: {
    readonly product: SQLWrapper;
    readonly status: SQLWrapper;
    readonly validFrom: SQLWrapper;
    readonly validUntil: SQLWrapper;
    readonly accessEndsOn: SQLWrapper;
  },
  window: {
    readonly validFrom: PlainDate | SQLWrapper;
    readonly validUntil: PlainDate | SQLWrapper;
  },
  includePending: boolean
) => sql<boolean>`(
  ${pass.product} = 'unlimited'
  and ${pass.validFrom} < ${window.validUntil}
  and coalesce(${pass.accessEndsOn}, ${pass.validUntil}) > ${window.validFrom}
  and (${pass.status} = 'active'
    or (${includePending} and ${pass.status} = 'pending_payment')
    or (${pass.status} in ('withdrawn', 'cancelled') and ${pass.accessEndsOn} > ${pass.validFrom}))
)`;

/** Booked coverage, including unclaimed gifts and days retained after an early end. */
export const getUnlimitedPassCoverageTiers = Effect.fn(
  "getUnlimitedPassCoverageTiers"
)(function* (
  db: WorkspaceDatabaseClient,
  {
    holderAccountId,
    date,
  }: {
    readonly holderAccountId: CustomerAccountId;
    readonly date: PlainDate;
  }
) {
  const covered = yield* db
    .selectDistinct({ tier: passPurchases.tier })
    .from(passPurchases)
    .where(
      and(
        eq(passPurchases.holderAccountId, holderAccountId),
        overlapsUnlimitedPassWindow(
          passPurchases,
          { validFrom: date, validUntil: sql`${date}::date + 1` },
          false
        )
      )
    );
  return new Set(covered.map(({ tier }) => tier));
});

/** Read booked coverage for the holder's usable Entry pack windows in one query. */
export const listUnlimitedPassCoverageWindows = Effect.fn(
  "listUnlimitedPassCoverageWindows"
)(function* (
  db: WorkspaceDatabaseClient,
  holderAccountId: CustomerAccountId,
  window: {
    readonly validFrom: PlainDate;
    readonly validUntil: PlainDate;
    readonly tiers: readonly PassTier[];
  }
) {
  return yield* db
    .select({
      tier: passPurchases.tier,
      validFrom: passPurchases.validFrom,
      validUntil: sql<PlainDate>`coalesce(${passPurchases.accessEndsOn}, ${passPurchases.validUntil})::text`,
    })
    .from(passPurchases)
    .where(
      and(
        eq(passPurchases.holderAccountId, holderAccountId),
        inArray(passPurchases.tier, window.tiers),
        overlapsUnlimitedPassWindow(passPurchases, window, false)
      )
    );
});

const entitlement = alias(passPurchases, "entitlement");

/** Paid entitlement can block a renewal even if it came from a regular purchase. */
export const hasUnlimitedRenewalOverlap = sql<boolean>`exists (
  select 1 from ${passPurchases} as "entitlement"
  where ${entitlement.id} <> ${passPurchases.id}
    and ${entitlement.holderAccountId} = ${passPurchases.holderAccountId}
    and ${overlapsUnlimitedPassWindow(
      entitlement,
      {
        validFrom: passPurchases.validUntil,
        validUntil: sql`${passPurchases.validUntil} + ${unlimitedPassDays}::integer`,
      },
      false
    )}
)`;
