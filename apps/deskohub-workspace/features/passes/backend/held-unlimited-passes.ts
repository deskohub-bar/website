import "server-only";

import { and, asc, eq, isNotNull, ne, notInArray, or } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases, workspaceReservations } from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { hasUnlimitedRenewalOverlap } from "./unlimited-pass-window";

export const listHeldUnlimitedPasses = Effect.fn("listHeldUnlimitedPasses")(
  function* (accountId: CustomerAccountId) {
    const { db } = yield* WorkspaceDatabase;
    return yield* db
      .select({
        orderId: passPurchases.id,
        tier: passPurchases.tier,
        buyerAccountId: passPurchases.buyerAccountId,
        validFrom: passPurchases.validFrom,
        validUntil: passPurchases.validUntil,
        accessEndsOn: passPurchases.accessEndsOn,
        status: passPurchases.status,
        paidAt: orders.paidAt,
        grantedAt: orders.fulfilledAt,
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
        giftClaimedAt: passPurchases.giftClaimedAt,
        renewalOverlaps: hasUnlimitedRenewalOverlap,
        deskId: workspaceReservations.passDayTableId,
      })
      .from(passPurchases)
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .leftJoin(
        workspaceReservations,
        and(
          ne(passPurchases.tier, "open-space"),
          eq(workspaceReservations.passId, passPurchases.id),
          eq(workspaceReservations.serviceDate, passPurchases.validFrom)
        )
      )
      .where(
        and(
          eq(passPurchases.product, "unlimited"),
          eq(passPurchases.holderAccountId, accountId),
          or(
            eq(passPurchases.buyerAccountId, accountId),
            isNotNull(passPurchases.giftClaimedAt)
          ),
          eq(orders.kind, "pass-purchase"),
          or(
            isNotNull(orders.paidAt),
            and(
              eq(orders.paymentState, "complimentary"),
              eq(orders.fulfillmentState, "fulfilled")
            )
          ),
          notInArray(passPurchases.status, ["pending_payment", "void"])
        )
      )
      .orderBy(asc(passPurchases.validFrom), asc(passPurchases.id));
  }
);
