import type { DotyposTable } from "@deskohub/dotypos";
import { Effect } from "effect";
import {
  decodeTableCandidates,
  getWorkspaceTableCandidates,
  workspaceCoworkOpenSpaceTableTag,
  workspaceTableReservationTableTag,
} from "@/features/checkout/backend/reservation/workspace-table-selection";

export const decodeTeamTableCandidates = (tables: readonly DotyposTable[]) =>
  decodeTableCandidates(
    getWorkspaceTableCandidates(tables, [
      workspaceTableReservationTableTag,
      workspaceCoworkOpenSpaceTableTag,
    ])
  );

export const getTeamTableSeatCapacities = (tables: readonly DotyposTable[]) =>
  Effect.map(
    Effect.fromResult(decodeTeamTableCandidates(tables)),
    (candidates) =>
      Array.from(
        new Set(candidates.map(({ seatCapacity }) => seatCapacity))
      ).sort((left, right) => left - right)
  );
