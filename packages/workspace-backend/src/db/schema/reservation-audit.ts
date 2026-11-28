import type {
  reservationAuditReasons,
  reservationAuditStates,
} from "@deskohub/workspace-admin-api";
import type { CustomerAccountId } from "@deskohub/workspace-domain/features/account/customer-account";
import {
  type AdministrationSource,
  administrationSources,
} from "@deskohub/workspace-domain/features/administrators/administration-source";
import type { WorkspaceReservationId } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { instant } from "../instant";
import { quotedSqlList } from "./sql-list";

type ReservationAuditState = (typeof reservationAuditStates)[number];
type ReservationAuditReason = (typeof reservationAuditReasons)[number];

// Opaque identifiers survive deletion of the account, subject, or request log.
export const reservationAuditEvents = pgTable(
  "reservation_audit_events",
  {
    id: uuid("id").primaryKey(),
    reservationId: text("reservation_id")
      .$type<WorkspaceReservationId>()
      .notNull(),
    actorAccountId: text("actor_account_id")
      .$type<CustomerAccountId>()
      .notNull(),
    source: text("source").$type<AdministrationSource>().notNull(),
    beforeState: text("before_state").$type<ReservationAuditState>().notNull(),
    afterState: text("after_state").$type<ReservationAuditState>().notNull(),
    reason: text("reason").$type<ReservationAuditReason>().notNull(),
    occurredAt: instant("occurred_at").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    administrationActionId: uuid("administration_action_id"),
    causedByEventId: uuid("caused_by_event_id"),
    schemaVersion: integer("schema_version").$type<1>().notNull().default(1),
  },
  (t) => [
    index("reservation_audit_events_subject_order_idx").on(
      t.reservationId,
      t.occurredAt.desc(),
      t.id.desc()
    ),
    foreignKey({
      name: "reservation_audit_events_cause_fk",
      columns: [t.causedByEventId],
      foreignColumns: [t.id],
    }),
    check(
      "reservation_audit_events_source_check",
      sql`${t.source} in (${quotedSqlList(administrationSources)})`
    ),
    check(
      "reservation_audit_events_version_check",
      sql`${t.schemaVersion} = 1`
    ),
    check(
      "reservation_audit_events_transition_check",
      sql`case
        when ${t.reason} in ('operator_cancellation', 'forced_pending_payment_cancellation')
          then ${t.beforeState} in ('held', 'hold_expired', 'confirmed') and ${t.afterState} = 'cancelling' and ${t.causedByEventId} is null
        when ${t.reason} = 'cancellation_reclaimed'
          then ${t.beforeState} in ('cancelling', 'cancellation_failed') and ${t.afterState} = 'cancelling' and ${t.causedByEventId} is null
        when ${t.reason} in ('provider_cancellation_failed', 'local_cancellation_failed')
          then ${t.beforeState} = 'cancelling' and ${t.afterState} = 'cancellation_failed' and ${t.causedByEventId} is not null
        when ${t.reason} = 'cancellation_completed'
          then ${t.beforeState} = 'cancelling' and ${t.afterState} = 'cancelled' and ${t.causedByEventId} is not null
        when ${t.reason} = 'operator_restoration'
          then ${t.beforeState} = 'cancelled' and ${t.afterState} = 'confirmed' and ${t.causedByEventId} is null
        else false
      end`
    ),
  ]
);

export const reservationAuditAccesses = pgTable(
  "reservation_audit_accesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: text("reservation_id")
      .$type<WorkspaceReservationId>()
      .notNull(),
    actorAccountId: text("actor_account_id")
      .$type<CustomerAccountId>()
      .notNull(),
    source: text("source").$type<AdministrationSource>().notNull(),
    occurredAt: instant("occurred_at").notNull().default(sql`now()`),
    beforeEventId: uuid("before_event_id"),
    returnedCount: integer("returned_count").notNull(),
  },
  (t) => [
    index("reservation_audit_accesses_subject_time_idx").on(
      t.reservationId,
      t.occurredAt
    ),
    check(
      "reservation_audit_accesses_source_check",
      sql`${t.source} in (${quotedSqlList(administrationSources)})`
    ),
    check(
      "reservation_audit_accesses_count_check",
      sql`${t.returnedCount} >= 0`
    ),
  ]
);
