import type { DotyposService, DotyposTableId } from "@deskohub/dotypos";
import { Effect, Option } from "effect";
import {
  excludeDotyposReservationsById,
  getOccupancyWindowDates,
  getTableBookingOccupancyById,
  toTableBookings,
} from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import type {
  StoredWorkspaceReservationDetails,
  WorkspaceReservationId,
} from "@/features/reservation/persistence-contracts";
import { currentInstant } from "@/shared/utils/temporal";
import type { BookedInterval } from "./booked-reservation";
import { hasSharedSeating } from "./customer-reservation-placement";
import type { WorkspaceReservationRepository } from "./workspace-reservation.repository";

type OpenSpacePlacementReads = {
  readonly dotypos: Pick<
    DotyposService["Service"],
    "listActiveReservationsOverlapping"
  >;
  readonly reservations: Pick<
    WorkspaceReservationRepository["Service"],
    | "selectExpiredHoldDotyposReservationIds"
    | "selectTeamTableDotyposReservationIds"
  >;
};

/** A Team Table is identified locally, but its current table comes from Dotypos. */
export const loadOpenSpaceTableExclusions = Effect.fn(
  "loadOpenSpaceTableExclusions"
)(function* (
  bookings: readonly {
    readonly id: WorkspaceReservationId;
    readonly reservationDetails: StoredWorkspaceReservationDetails;
    readonly occupiedInterval: Option.Option<BookedInterval>;
  }[],
  { dotypos, reservations }: OpenSpacePlacementReads
) {
  const windows = bookings.flatMap(
    ({ id, reservationDetails, occupiedInterval }) =>
      hasSharedSeating(reservationDetails) && Option.isSome(occupiedInterval)
        ? [
            {
              id,
              startsAt: occupiedInterval.value.startsAt.epochMilliseconds,
              endsAt: occupiedInterval.value.endsAt.epochMilliseconds,
            },
          ]
        : []
  );
  const exclusions = new Map<
    WorkspaceReservationId,
    ReadonlySet<DotyposTableId>
  >();
  const first = windows[0];
  if (!first) return exclusions;

  const bounds = windows.reduce(
    (span, window) => ({
      startsAt: Math.min(span.startsAt, window.startsAt),
      endsAt: Math.max(span.endsAt, window.endsAt),
    }),
    { startsAt: first.startsAt, endsAt: first.endsAt }
  );
  const observed = yield* dotypos.listActiveReservationsOverlapping(
    getOccupancyWindowDates(bounds)
  );
  const candidateIds = observed.flatMap(({ id, _tableId }) =>
    id && _tableId ? [id] : []
  );
  const teamTableIds = new Set(
    candidateIds.length
      ? yield* reservations.selectTeamTableDotyposReservationIds(candidateIds)
      : []
  );
  const expiredIds = teamTableIds.size
    ? yield* reservations.selectExpiredHoldDotyposReservationIds({
        now: yield* currentInstant,
      })
    : [];
  const activeTeamTables = toTableBookings(
    excludeDotyposReservationsById(
      observed.filter(({ id }) => id && teamTableIds.has(id)),
      expiredIds
    )
  );

  for (const window of windows) {
    exclusions.set(
      window.id,
      new Set(getTableBookingOccupancyById(activeTeamTables, window).keys())
    );
  }
  return exclusions;
});
