import type { AdministrationReservationAuditPage } from "@deskohub/workspace-admin-api";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import {
  reservationAuditAccesses,
  reservationAuditEvents,
  workspaceReservations,
} from "@/db/schema";
import type { AdministrationActor } from "@/features/administrators/administration-source";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";

const pageSize = 100;

export const readReservationAudit = Effect.fnUntraced(function* ({
  actor,
  reservationId,
  before,
}: {
  readonly actor: AdministrationActor;
  readonly reservationId: WorkspaceReservationId;
  readonly before?: string;
}) {
  const { db } = yield* WorkspaceTransaction;
  const subject = eq(reservationAuditEvents.reservationId, reservationId);
  const [cursor] = before
    ? yield* db
        .select({
          id: reservationAuditEvents.id,
          time: reservationAuditEvents.occurredAt,
        })
        .from(reservationAuditEvents)
        .where(and(subject, eq(reservationAuditEvents.id, before)))
    : [];
  if (before && !cursor) return null;

  const rows = yield* db
    .select()
    .from(reservationAuditEvents)
    .where(
      and(
        subject,
        cursor &&
          sql`(${reservationAuditEvents.occurredAt}, ${reservationAuditEvents.id}) < (${sql.param(cursor.time, reservationAuditEvents.occurredAt)}, ${cursor.id})`
      )
    )
    .orderBy(
      sql`${reservationAuditEvents.occurredAt} desc nulls last`,
      sql`${reservationAuditEvents.id} desc nulls last`
    )
    .limit(pageSize + 1);

  if (!cursor && rows.length === 0) {
    // Only log a known subject. An arbitrary user-supplied path may contain PII.
    const [reservation] = yield* db
      .select({ id: workspaceReservations.id })
      .from(workspaceReservations)
      .where(
        and(
          eq(workspaceReservations.id, reservationId),
          isNull(workspaceReservations.passId)
        )
      );
    if (!reservation) return null;
  }

  const events = rows
    .slice(0, pageSize)
    .map(({ reservationId: _, occurredAt, ...event }) => ({
      ...event,
      occurredAt: occurredAt.toString(),
    }));
  yield* db.insert(reservationAuditAccesses).values({
    reservationId,
    actorAccountId: actor.administrator.accountId,
    source: actor.source,
    beforeEventId: cursor?.id,
    returnedCount: events.length,
  });
  return {
    reservationId,
    events,
    nextBefore: rows.length > pageSize ? (events.at(-1)?.id ?? null) : null,
  } satisfies AdministrationReservationAuditPage;
});
