import type {
  DotyposCustomerId,
  DotyposReservationId,
  DotyposTableId,
} from "@deskohub/dotypos";
import type { WorkspaceReservationId } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import type { PlainDate } from "@deskohub/workspace-domain/shared/utils/temporal";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { instant } from "../instant";
import { workspaceReservations } from "./workspace-reservations";

export const openSpaceTableMoveBatches = pgTable(
  "open_space_table_move_batches",
  {
    id: uuid("id").primaryKey(),
    firstDate: date("first_date", { mode: "string" })
      .notNull()
      .$type<PlainDate>(),
    lastDate: date("last_date", { mode: "string" })
      .notNull()
      .$type<PlainDate>(),
    requestedAt: instant("requested_at").notNull(),
  },
  (t) => [
    check(
      "open_space_table_move_batches_dates_check",
      sql`${t.lastDate} between ${t.firstDate} and ${t.firstDate} + 2`
    ),
  ]
);

/** Keeps the original hold's identity and the replacement's recovery marker. */
export const openSpaceTableMoves = pgTable(
  "open_space_table_moves",
  {
    generation: uuid("generation").primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => openSpaceTableMoveBatches.id),
    reservationId: text("reservation_id")
      .notNull()
      .$type<WorkspaceReservationId>()
      .references(() => workspaceReservations.id),
    serviceDate: date("service_date", { mode: "string" })
      .notNull()
      .$type<PlainDate>(),
    customerId: text("customer_id").notNull().$type<DotyposCustomerId>(),
    sourceReservationId: text("source_reservation_id")
      .notNull()
      .$type<DotyposReservationId>(),
    sourceTableId: text("source_table_id").notNull().$type<DotyposTableId>(),
    sourceNoteLine: text("source_note_line").notNull(),
    targetTableId: text("target_table_id").notNull().$type<DotyposTableId>(),
    targetReservationId: text(
      "target_reservation_id"
    ).$type<DotyposReservationId>(),
    status: text("status").notNull().$type<"NEW" | "CONFIRMED">(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    attemptedAt: instant("attempted_at"),
    attachedAt: instant("attached_at"),
    checkedAt: instant("checked_at").notNull(),
    settledAt: instant("settled_at"),
    ambiguousAt: instant("ambiguous_at"),
    ambiguousReservationIds: text("ambiguous_reservation_ids")
      .$type<DotyposReservationId>()
      .array(),
  },
  (t) => [
    uniqueIndex("open_space_table_moves_pending_reservation_idx")
      .on(t.reservationId)
      .where(sql`${t.settledAt} is null`),
    uniqueIndex("open_space_table_moves_pending_source_idx")
      .on(t.sourceReservationId)
      .where(sql`${t.settledAt} is null`),
    uniqueIndex("open_space_table_moves_target_idx").on(t.targetReservationId),
    index("open_space_table_moves_source_idx").on(t.sourceReservationId),
    index("open_space_table_moves_reservation_idx").on(t.reservationId),
    index("open_space_table_moves_pending_date_idx")
      .on(t.serviceDate)
      .where(sql`${t.settledAt} is null and ${t.attemptedAt} is not null`),
    index("open_space_table_moves_pending_checked_idx")
      .on(t.checkedAt, t.batchId)
      .where(sql`${t.settledAt} is null and ${t.ambiguousAt} is null`),
    index("open_space_table_moves_batch_idx").on(t.batchId),
    check(
      "open_space_table_moves_booking_check",
      sql`${t.startsAt} < ${t.endsAt}
        and ${t.status} in ('NEW', 'CONFIRMED')
        and ${t.targetTableId} <> ${t.sourceTableId}
        and ${t.targetReservationId} is distinct from ${t.sourceReservationId}
        and (${t.targetReservationId} is null or ${t.attemptedAt} is not null)
        and (${t.attachedAt} is null or ${t.targetReservationId} is not null)`
    ),
  ]
);
