import "server-only";

import type { ReservationPayment } from "@deskohub/workspace-admin-api";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { Match } from "effect";
import {
  passEntryClaims,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";

/**
 * Whether the active payment attempt keeps part of its amount: more than
 * it refunded, and, while it owes a refund, more than it owes (an unknown
 * target owes the whole amount). Matches the account page's individually
 * paid reservations.
 */
const keepsPaidAmount = sql`${paymentAttempts.amountValue} > greatest(
  coalesce(${paymentAttempts.refundedAmountValue}, 0),
  case when ${paymentAttempts.refundState} = 'required'
    then coalesce(${paymentAttempts.refundTargetValue}, ${paymentAttempts.amountValue})
    else 0 end)`;

/**
 * Selects `workspace_reservations` rows paid by their own order: no
 * Unlimited pass covers them, the reservation is paid, its active payment
 * attempt is paid and keeps part of its amount after refunds, and no Entry
 * pack entry was consumed for it. Entry-pack-funded and fully discounted
 * bookings also end paid, through a zero-amount attempt, so the amount
 * decides. A Dotypos reservation Workspace didn't book has no row and never
 * matches.
 */
const individuallyPaidReservation: SQL =
  and(
    isNull(workspaceReservations.passId),
    eq(workspaceReservations.paymentState, "paid"),
    sql`exists (select 1 from ${paymentAttempts} where ${and(
      eq(paymentAttempts.id, workspaceReservations.activePaymentAttemptId),
      eq(paymentAttempts.state, "paid"),
      keepsPaidAmount
    )})`,
    sql`not exists (select 1 from ${passEntryClaims} where ${and(
      eq(passEntryClaims.reservationId, workspaceReservations.id),
      eq(passEntryClaims.status, "consumed")
    )})`
  ) ?? sql`false`;

/** Selects `workspace_reservations` rows paid the way `payment` names. */
export const reservationPaymentCondition = (payment: ReservationPayment): SQL =>
  Match.value(payment).pipe(
    Match.when("individual", () => individuallyPaidReservation),
    Match.exhaustive
  );
