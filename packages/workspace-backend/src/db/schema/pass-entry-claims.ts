import type { OrderId } from "@deskohub/workspace-domain/features/order/order";
import {
  type PassEntryClaimStatus,
  passEntryClaimStatuses,
} from "@deskohub/workspace-domain/features/passes/pass";
import type { WorkspaceReservationId } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import type { PlainDate } from "@deskohub/workspace-domain/shared/utils/temporal";
import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text } from "drizzle-orm/pg-core";
import { passPurchases } from "./pass-purchases";
import { quotedSqlList } from "./sql-list";
import { workspaceReservations } from "./workspace-reservations";

export const passEntryClaims = pgTable(
  "pass_entry_claims",
  {
    reservationId: text("reservation_id")
      .primaryKey()
      .$type<WorkspaceReservationId>()
      .references(() => workspaceReservations.id),
    passId: text("pass_id")
      .notNull()
      .$type<OrderId>()
      .references(() => passPurchases.id),
    date: date("date", { mode: "string" }).notNull().$type<PlainDate>(),
    status: text("status").notNull().$type<PassEntryClaimStatus>(),
  },
  (t) => [
    check(
      "pass_entry_claims_status_check",
      sql`${t.status} in (${quotedSqlList(passEntryClaimStatuses)})`
    ),
    index("pass_entry_claims_pass_date_idx").on(t.passId, t.date),
  ]
);
