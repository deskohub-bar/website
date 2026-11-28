import type { DotyposReservationId, DotyposTableId } from "@deskohub/dotypos";
import type { PaymentAttemptId } from "@deskohub/workspace-domain/features/checkout/checkout-identifiers";
import type { WorkspaceReservationId } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { instant } from "../instant";
import { workspaceReservations } from "./workspace-reservations";

/** Exclusive capacity reserved before the one-attempt Dotypos create. */
export const teamTableHoldClaims = pgTable(
  "team_table_hold_claims",
  {
    reservationId: text("reservation_id")
      .$type<WorkspaceReservationId>()
      .primaryKey()
      .references(() => workspaceReservations.id, { onDelete: "cascade" }),
    tableId: text("table_id").$type<DotyposTableId>().notNull(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    seats: integer("seats").notNull(),
    providerReservationIds: text("provider_reservation_ids")
      .$type<DotyposReservationId>()
      .array(),
    checkedAt: instant("checked_at"),
    generation: uuid("generation"),
    purpose: text("purpose")
      .$type<"checkout" | "payment_retry" | "late_payment">()
      .notNull()
      .default("checkout"),
    paymentAttemptId: text("payment_attempt_id").$type<PaymentAttemptId>(),
    /** A payment retry's fixed deadline, recorded before creating its hold. */
    retryExpiresAt: instant("retry_expires_at"),
    attachedAt: instant("attached_at"),
    cancelRequestedAt: instant("cancel_requested_at"),
    retiredAt: instant("retired_at"),
  },
  (claim) => [
    check(
      "team_table_hold_claims_interval",
      sql`${claim.startsAt} < ${claim.endsAt}`
    ),
    check("team_table_hold_claims_seats", sql`${claim.seats} > 0`),
    check(
      "team_table_hold_claims_owner",
      sql`
      (${claim.purpose} = 'checkout' and ${claim.paymentAttemptId} is null)
      or (${claim.purpose} in ('payment_retry', 'late_payment') and
        ${claim.paymentAttemptId} is not null and ${claim.generation} is not null)
    `
    ),
    index("team_table_hold_claims_interval_idx").on(
      claim.endsAt,
      claim.startsAt
    ),
  ]
);
