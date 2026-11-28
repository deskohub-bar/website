import { sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import { reservationAuditEvents } from "@/db/schema";
import { CurrentAdministrationAction } from "@/features/admin-cli/administration-action";
import type { AdministrationActor } from "@/features/administrators/administration-source";

/** One operator attempt, shared by a claim and its settlement. */
export type ReservationAuditAttempt = Pick<
  typeof reservationAuditEvents.$inferInsert,
  "actorAccountId" | "source" | "correlationId" | "administrationActionId"
> & { readonly rootEventId: string };

export const startReservationAudit = Effect.fnUntraced(function* (
  actor: AdministrationActor
): Effect.fn.Return<ReservationAuditAttempt> {
  const action = yield* Effect.serviceOption(CurrentAdministrationAction);
  return {
    actorAccountId: actor.administrator.accountId,
    source: actor.source,
    correlationId: crypto.randomUUID(),
    administrationActionId: Option.match(action, {
      onNone: () => null,
      onSome: ({ id }) => id,
    }),
    rootEventId: crypto.randomUUID(),
  };
});

export const appendReservationAuditEvent = Effect.fnUntraced(function* (
  { rootEventId, ...attempt }: ReservationAuditAttempt,
  transition: Pick<
    typeof reservationAuditEvents.$inferInsert,
    "reservationId" | "beforeState" | "afterState" | "reason"
  >
) {
  const { db } = yield* WorkspaceTransaction;
  const settlement =
    transition.beforeState === "cancelling" &&
    transition.afterState !== "cancelling";
  yield* db.insert(reservationAuditEvents).values({
    ...attempt,
    ...transition,
    id: settlement ? crypto.randomUUID() : rootEventId,
    causedByEventId: settlement ? rootEventId : null,
    // The transition owns its row lock by now. A request's earlier clock can
    // predate the state change it observed after waiting for that lock.
    occurredAt: sql`clock_timestamp()`,
  });
});
