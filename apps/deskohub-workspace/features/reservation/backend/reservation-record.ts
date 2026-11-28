import type { DotyposReservation } from "@deskohub/dotypos";
import { readPassDayMarkers } from "@/features/passes/pass-day-marker";
import { hasOpenSpaceMoveMarker } from "./open-space-move-marker";

/**
 * The Dotypos reservation fields Workspace reads to show, place, and check a
 * reservation: no customer link and no free-text note, so it can be shared
 * across requests.
 */
export type ReservationRecord = Pick<
  DotyposReservation,
  "id" | "status" | "_tableId" | "startDate" | "endDate" | "seats"
> & {
  readonly unlimitedPassDay?: true;
  readonly openSpaceMoveReplacement?: true;
};

/** Drops customer links and free-text notes before sharing a reservation. */
export const toReservationRecord = ({
  id,
  status,
  _tableId,
  startDate,
  endDate,
  seats,
  note,
}: ReservationRecord &
  Pick<DotyposReservation, "note">): ReservationRecord => ({
  id,
  status,
  ...(_tableId !== undefined && { _tableId }),
  startDate,
  endDate,
  seats,
  ...(readPassDayMarkers(note).length > 0 && { unlimitedPassDay: true }),
  ...(hasOpenSpaceMoveMarker(note) && { openSpaceMoveReplacement: true }),
});
