import "server-only";

import { and, asc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  orders,
  passEntryClaims,
  passPurchases,
  workspaceReservations,
} from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import { supersedableReservationPaymentStates } from "@/features/reservation/backend/reservation-supersession";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { PlainDate } from "@/shared/utils/temporal";
import type { PassStatus } from "../pass";
import type { EntryPackSize, PassTier } from "../pass-offer";
import { hasClaimablePassOrder } from "./entry-pack-payment-eligibility";
import { canHolderViewPassOrderStatus } from "./pass-order-status-access";

export type HeldEntryPack = {
  readonly id: OrderId;
  readonly tier: PassTier;
  readonly entryCount: EntryPackSize;
  readonly entriesLeft: number;
  readonly paidAt: Temporal.Instant;
  readonly complimentary?: true;
  readonly canViewOrderStatus?: true;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
  readonly status: PassStatus;
  readonly giftIssuedAt: Temporal.Instant | null;
  readonly giftClaimedAt: Temporal.Instant | null;
  readonly giftPaymentIsUsable: boolean;
  readonly claimedDates: readonly PlainDate[];
  /** Confirmed dates booked by this holder, excluding a previous holder's usage. */
  readonly bookedDates: readonly PlainDate[];
  /** Server-only lookup for editing a signed draft that already holds an entry. */
  readonly reservedEntryDates: Readonly<
    Partial<Record<WorkspaceReservationId, PlainDate>>
  >;
};

export const getHeldEntryPackStatus = (
  pack: HeldEntryPack,
  today: PlainDate
) => {
  switch (pack.status) {
    case "active":
      return Temporal.PlainDate.compare(today, pack.validUntil) >= 0
        ? "expired"
        : "active";
    case "depleted":
    case "expired":
      return pack.status;
    case "pending_payment":
    case "cancelled":
    case "withdrawn":
    case "void":
      return "ended";
  }
};

/** Payment and claim state from one snapshot, scoped to the verified holder. */
export const listHeldEntryPacks = Effect.fn("listHeldEntryPacks")(function* (
  accountId: CustomerAccountId
) {
  const { db } = yield* WorkspaceDatabase;
  const liveEditableClaim = and(
    eq(passEntryClaims.status, "reserved"),
    eq(workspaceReservations.authorAccountId, accountId),
    eq(workspaceReservations.reservationState, "held"),
    inArray(
      workspaceReservations.paymentState,
      supersedableReservationPaymentStates
    ),
    isNotNull(workspaceReservations.dotyposReservationId),
    sql`${workspaceReservations.reservationHoldExpiresAt} > now()`
  );
  const rows = yield* db
    .select({
      id: passPurchases.id,
      buyerAccountId: passPurchases.buyerAccountId,
      tier: passPurchases.tier,
      entryCount: passPurchases.entryCount,
      paidAt: orders.paidAt,
      grantedAt: orders.fulfilledAt,
      paymentState: orders.paymentState,
      fulfillmentState: orders.fulfillmentState,
      validFrom: passPurchases.validFrom,
      validUntil: passPurchases.validUntil,
      status: passPurchases.status,
      giftIssuedAt: passPurchases.giftIssuedAt,
      giftClaimedAt: passPurchases.giftClaimedAt,
      giftPaymentIsUsable: sql<boolean>`${passPurchases.giftIssuedAt} is null or ${hasClaimablePassOrder(db)}`,
      claimedDates: sql<PlainDate[]>`coalesce(
        array_agg(${passEntryClaims.date}::text order by ${passEntryClaims.date})
          filter (where ${passEntryClaims.date} is not null),
        array[]::text[]
      )`,
      bookedDates: sql<PlainDate[]>`coalesce(
        array_agg(${passEntryClaims.date}::text order by ${passEntryClaims.date})
          filter (where ${workspaceReservations.authorAccountId} = ${accountId}
            and ${workspaceReservations.reservationState} = 'confirmed'
            and ${passEntryClaims.status} = 'consumed'),
        array[]::text[]
      )`,
      reservedEntryDates: sql<HeldEntryPack["reservedEntryDates"]>`coalesce(
        jsonb_object_agg(${passEntryClaims.reservationId}, ${passEntryClaims.date})
          filter (where ${liveEditableClaim}),
        '{}'::jsonb
      )`,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .leftJoin(
      passEntryClaims,
      and(
        eq(passEntryClaims.passId, passPurchases.id),
        ne(passEntryClaims.status, "released")
      )
    )
    .leftJoin(
      workspaceReservations,
      eq(workspaceReservations.id, passEntryClaims.reservationId)
    )
    .where(
      and(
        eq(passPurchases.holderAccountId, accountId),
        eq(passPurchases.product, "entry-pack"),
        or(isNotNull(orders.paidAt), eq(orders.paymentState, "complimentary")),
        ne(passPurchases.status, "void")
      )
    )
    .groupBy(passPurchases.id, orders.id)
    .orderBy(asc(passPurchases.validUntil), asc(passPurchases.id));

  return rows.flatMap(
    ({
      buyerAccountId,
      paidAt,
      grantedAt,
      paymentState,
      fulfillmentState,
      entryCount,
      ...pack
    }): HeldEntryPack[] => {
      const acquiredAt = paymentState === "complimentary" ? grantedAt : paidAt;
      return acquiredAt && entryCount !== null
        ? [
            {
              ...pack,
              entryCount,
              paidAt: acquiredAt,
              ...(paymentState === "complimentary" && { complimentary: true }),
              ...(canHolderViewPassOrderStatus(
                {
                  buyerAccountId,
                  paymentState,
                  fulfillmentState,
                  status: pack.status,
                  giftClaimedAt: pack.giftClaimedAt,
                },
                accountId
              ) && { canViewOrderStatus: true }),
              entriesLeft: Math.max(0, entryCount - pack.claimedDates.length),
            },
          ]
        : [];
    }
  );
});
