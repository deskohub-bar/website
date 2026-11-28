import { eq } from "drizzle-orm";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import {
  openSpaceTableMoveBatches,
  openSpaceTableMoves,
  unlimitedPassDayMoves,
} from "@/db/schema";

/** Both reassignment workflows keep the same pass day and its provider history. */
export const passDayMoveJournal = (db: WorkspaceDatabaseClient) => {
  const fields = (
    move: typeof unlimitedPassDayMoves | typeof openSpaceTableMoves
  ) => ({
    generation: move.generation,
    reservationId: move.reservationId,
    customerId: move.customerId,
    sourceTableId: move.sourceTableId,
    targetTableId: move.targetTableId,
    targetReservationId: move.targetReservationId,
    attachedAt: move.attachedAt,
    settledAt: move.settledAt,
    ambiguousAt: move.ambiguousAt,
  });
  return db
    .select({
      ...fields(unlimitedPassDayMoves),
      requestedAt: unlimitedPassDayMoves.requestedAt,
    })
    .from(unlimitedPassDayMoves)
    .unionAll(
      db
        .select({
          ...fields(openSpaceTableMoves),
          requestedAt: openSpaceTableMoveBatches.requestedAt,
        })
        .from(openSpaceTableMoves)
        .innerJoin(
          openSpaceTableMoveBatches,
          eq(openSpaceTableMoveBatches.id, openSpaceTableMoves.batchId)
        )
    )
    .as("pass_day_move_journal");
};
