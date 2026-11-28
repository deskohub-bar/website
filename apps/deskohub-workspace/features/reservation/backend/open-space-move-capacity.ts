import type {
  DotyposReservation,
  DotyposReservationId,
} from "@deskohub/dotypos";
import { Option } from "effect";
import {
  type TableBooking,
  workspaceBookingSeatCount,
} from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import { decodeBookedReservation } from "./booked-reservation";
import { formatOpenSpaceMoveMarker } from "./open-space-move-marker";
import type { ReservationRecord } from "./reservation-record";

export type OpenSpaceMoveCapacityClaim = Omit<
  TableBooking,
  "seats" | "exclusive"
> & {
  readonly exclusive?: never;
  readonly reservationId: DotyposReservationId | null;
  readonly generation: string | null;
};

type TeamTableCapacityClaim = TableBooking & {
  readonly exclusive: true;
  readonly reservationId: DotyposReservationId | null;
  readonly generation: null;
};

export type LocalTableCapacityClaim =
  | OpenSpaceMoveCapacityClaim
  | TeamTableCapacityClaim;

export const isTeamTableCapacityClaim = (
  claim: LocalTableCapacityClaim
): claim is TeamTableCapacityClaim => claim.exclusive === true;

type CapacityRecord = ReservationRecord & Pick<DotyposReservation, "note">;

/** A staged move holds one seat even before Dotypos's inventory lists it. */
export const getUnobservedOpenSpaceMoveBookings = (
  claims: readonly OpenSpaceMoveCapacityClaim[],
  records: readonly CapacityRecord[]
): readonly TableBooking[] => {
  if (claims.length === 0) return [];
  const byId = new Map(
    claims.flatMap((claim) =>
      claim.reservationId ? [[claim.reservationId, claim] as const] : []
    )
  );
  const byMarker = new Map(
    claims.flatMap((claim) =>
      claim.generation
        ? [[formatOpenSpaceMoveMarker(claim.generation), claim] as const]
        : []
    )
  );
  const observed = new Set<OpenSpaceMoveCapacityClaim>();
  for (const record of records) {
    const matchById = byId.get(record.id);
    const matchByMarker =
      record.note?.split("\n").flatMap((line) => byMarker.get(line) ?? []) ??
      [];
    const matches = matchById ? [matchById, ...matchByMarker] : matchByMarker;
    if (matches.length === 0) continue;
    if (record.status !== "NEW" && record.status !== "CONFIRMED") continue;
    const { interval } = decodeBookedReservation(record);
    if (Option.isNone(interval)) continue;
    for (const claim of matches) {
      if (
        record._tableId === claim.tableId &&
        interval.value.startsAt.epochNanoseconds ===
          BigInt(claim.startsAt) * 1_000_000n &&
        interval.value.endsAt.epochNanoseconds ===
          BigInt(claim.endsAt) * 1_000_000n
      )
        observed.add(claim);
    }
  }

  return claims
    .filter((claim) => !observed.has(claim))
    .map(({ generation: _generation, reservationId: _id, ...booking }) => ({
      ...booking,
      seats: workspaceBookingSeatCount,
    }));
};
