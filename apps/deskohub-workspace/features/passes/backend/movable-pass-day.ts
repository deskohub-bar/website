import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import {
  orders,
  passAdministrationChanges,
  passPurchases,
  workspaceReservations,
} from "@/db/schema";
import { pendingPassChange } from "./pass-administration-pending";

/** Standing shared by availability and the transactional attachment fence. */
export const movablePassDay = and(
  eq(passPurchases.product, "unlimited"),
  eq(passPurchases.tier, "open-space"),
  eq(passPurchases.status, "active"),
  or(
    and(
      eq(orders.paymentState, "paid"),
      eq(workspaceReservations.paymentState, "paid")
    ),
    eq(orders.paymentState, "complimentary")
  ),
  sql`not exists (select 1 from ${passAdministrationChanges}
    where ${passAdministrationChanges.passId} = ${passPurchases.id}
      and ${pendingPassChange} and ${passAdministrationChanges.change}->>'_tag' = 'reassign')`,
  eq(workspaceReservations.reservationState, "confirmed"),
  eq(workspaceReservations.fulfillmentState, "fulfilled"),
  eq(workspaceReservations.authorAccountId, passPurchases.buyerAccountId),
  gte(workspaceReservations.serviceDate, passPurchases.validFrom),
  lt(workspaceReservations.serviceDate, passPurchases.validUntil),
  or(
    isNull(passPurchases.accessEndsOn),
    lt(workspaceReservations.serviceDate, passPurchases.accessEndsOn)
  )
);
