import { and, eq, isNull, or } from "drizzle-orm";
import { Effect } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { workspaceReservations } from "@/db/schema";
import type { OrderId } from "@/features/order";
import { currentInstant, type PlainDate } from "@/shared/utils/temporal";
import { ambiguousPassDayHoldCode } from "../pass-day-marker";

export type UnboundPassDayHold = {
  readonly passId: OrderId;
  readonly serviceDate: PlainDate;
  readonly holdGeneration: string | null;
  readonly holdRequestedAt: Temporal.Instant;
};

export const recordAmbiguousPassDayHolds = Effect.fnUntraced(function* (
  db: WorkspaceDatabaseClient,
  holds: readonly UnboundPassDayHold[]
) {
  if (holds.length === 0) return;
  const now = yield* currentInstant;
  const attempts = holds.map(
    ({ passId, serviceDate, holdGeneration, holdRequestedAt }) =>
      and(
        eq(workspaceReservations.passId, passId),
        eq(workspaceReservations.serviceDate, serviceDate),
        eq(workspaceReservations.passDayHoldRequestedAt, holdRequestedAt),
        holdGeneration === null
          ? isNull(workspaceReservations.passDayHoldGeneration)
          : eq(workspaceReservations.passDayHoldGeneration, holdGeneration)
      )
  );
  yield* db
    .update(workspaceReservations)
    .set({ failureCode: ambiguousPassDayHoldCode, updatedAt: now })
    .where(
      and(
        eq(workspaceReservations.reservationState, "creating_hold"),
        isNull(workspaceReservations.dotyposReservationId),
        or(...attempts)
      )
    );
});
