import type {
  DotyposReservationId,
  DotyposTable,
  DotyposTableId,
} from "@deskohub/dotypos";
import { Result } from "effect";
import { workspaceBookingSeatCount } from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import {
  decodeTableCandidates,
  getOpenSpaceTablePlacementPriority,
  getWorkspaceTableCandidatesByPredicate,
  type InvalidDotyposTableSeats,
  isWorkspaceCoworkTableCandidate,
  type WorkspaceTableCandidate,
} from "@/features/checkout/backend/reservation/workspace-table-selection";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import {
  getTouchedWorkspaceDateBounds,
  getWorkspaceDate,
} from "@/features/reservation/reservation-date";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  type InstantInterval,
  instantIntervalsOverlap,
  isIncreasingInstantInterval,
  type PlainDate,
  plainDateSpanToInstants,
} from "@/shared/utils/temporal";
import { decodeTeamTableCandidates } from "./team-table-capacity";

type OpenSpaceMoveSource = {
  readonly reservationId: WorkspaceReservationId;
  readonly sourceReservationId: DotyposReservationId;
  readonly serviceDate: PlainDate;
};

/** Local ownership and eligibility verified against the current provider hold. */
type VerifiedOpenSpaceHold = OpenSpaceMoveSource &
  (
    | {
        readonly origin: "paid-single-day" | "entry-pack" | "unlimited-pass";
        readonly status: "CONFIRMED";
      }
    | {
        readonly origin: "authorized-checkout";
        readonly status: "NEW";
        readonly expiresAt: Temporal.Instant;
      }
  );

type SharedBooking = {
  readonly kind: "shared";
  readonly interval: InstantInterval;
  readonly seats: number;
  readonly move?: VerifiedOpenSpaceHold;
};

/** Unknown ownership or kind can block a table, but cannot authorize a move. */
export type TeamTableBooking = { readonly tableId: DotyposTableId } & (
  | SharedBooking
  | { readonly kind: "team-table"; readonly interval: InstantInterval }
  | { readonly kind: "unknown"; readonly interval?: InstantInterval }
);

type TeamTableOpenSpaceMove = OpenSpaceMoveSource &
  InstantInterval & {
    readonly targetTableId: DotyposTableId;
    readonly status: VerifiedOpenSpaceHold["status"];
  };

export type TeamTablePlan = {
  readonly tableId: DotyposTableId;
  readonly moves: readonly TeamTableOpenSpaceMove[];
};

type MovableBooking = SharedBooking & { readonly move: VerifiedOpenSpaceHold };

const bookingOverlaps = (booking: TeamTableBooking, window: InstantInterval) =>
  !booking.interval ||
  !isIncreasingInstantInterval(booking.interval) ||
  instantIntervalsOverlap(booking.interval, window);

const isMovableOpenSpace = (
  booking: TeamTableBooking,
  today: Temporal.PlainDate,
  now: Temporal.Instant
): booking is TeamTableBooking & MovableBooking => {
  if (
    booking.kind !== "shared" ||
    !booking.move ||
    booking.seats !== workspaceBookingSeatCount ||
    !isIncreasingInstantInterval(booking.interval) ||
    // Dotypos creates replacement holds with millisecond precision.
    booking.interval.startsAt.epochNanoseconds % 1_000_000n !== 0n ||
    booking.interval.endsAt.epochNanoseconds % 1_000_000n !== 0n ||
    booking.move.serviceDate <= today.toString() ||
    (booking.move.status === "NEW" &&
      Temporal.Instant.compare(booking.move.expiresAt, now) <= 0)
  )
    return false;

  const { first, last } = getTouchedWorkspaceDateBounds(booking.interval);
  return (
    first.toString() === booking.move.serviceDate &&
    last.toString() === booking.move.serviceDate
  );
};

const canFit = (
  source: MovableBooking,
  capacity: number,
  bookings: readonly TeamTableBooking[]
) => {
  const seatChanges: { at: Temporal.Instant; delta: number }[] = [];
  for (const booking of bookings) {
    if (!bookingOverlaps(booking, source.interval)) continue;
    if (
      booking.kind !== "shared" ||
      !isIncreasingInstantInterval(booking.interval) ||
      !Number.isSafeInteger(booking.seats) ||
      booking.seats <= 0
    )
      return false;

    seatChanges.push(
      { at: booking.interval.startsAt, delta: booking.seats },
      { at: booking.interval.endsAt, delta: -booking.seats }
    );
  }
  // Ends release seats before any starts at the same instant.
  seatChanges.sort(
    (left, right) =>
      Temporal.Instant.compare(left.at, right.at) || left.delta - right.delta
  );
  let seats = source.seats;
  for (const { delta } of seatChanges) {
    seats += delta;
    if (seats > capacity) return false;
  }
  return true;
};

const placeOpenSpaceBookings = (
  blockers: readonly MovableBooking[],
  destinations: readonly WorkspaceTableCandidate[],
  bookingsByTable: ReadonlyMap<DotyposTableId, readonly TeamTableBooking[]>
): readonly TeamTableOpenSpaceMove[] | undefined => {
  const choices = blockers
    .map((blocker) => ({
      blocker,
      candidates: destinations.filter(({ table, seatCapacity }) =>
        canFit(blocker, seatCapacity, bookingsByTable.get(table.id) ?? [])
      ),
    }))
    .sort(
      (left, right) =>
        left.candidates.length - right.candidates.length ||
        left.blocker.move.sourceReservationId.localeCompare(
          right.blocker.move.sourceReservationId
        )
    );
  if (choices.some(({ candidates }) => candidates.length === 0)) return;

  const assigned = new Map(bookingsByTable);
  const moves: TeamTableOpenSpaceMove[] = [];
  const tryPlacement = (index: number): boolean => {
    const choice = choices[index];
    if (!choice) return true;

    const { blocker, candidates } = choice;
    const { reservationId, sourceReservationId, serviceDate, status } =
      blocker.move;
    const ranked = candidates
      .flatMap(({ table, seatCapacity }) => {
        const previous = assigned.get(table.id) ?? [];
        if (!canFit(blocker, seatCapacity, previous)) return [];
        const occupied = previous.some((booking) =>
          bookingOverlaps(booking, blocker.interval)
        );
        return [
          {
            table,
            previous,
            priority: getOpenSpaceTablePlacementPriority(table, occupied),
          },
        ];
      })
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.table.id.localeCompare(right.table.id)
      );
    for (const { table, previous } of ranked) {
      assigned.set(table.id, [...previous, { ...blocker, tableId: table.id }]);
      moves.push({
        ...blocker.interval,
        reservationId,
        sourceReservationId,
        serviceDate,
        status,
        targetTableId: table.id,
      });
      if (tryPlacement(index + 1)) return true;
      moves.pop();
      assigned.set(table.id, previous);
    }
    return false;
  };
  return tryPlacement(0) ? moves : undefined;
};

/** Plan against the active bookings and claims for the full Prague dates touched. */
export const planTeamTable = ({
  tables,
  bookings,
  window,
  seats,
  now,
}: {
  readonly tables: readonly DotyposTable[];
  readonly bookings: readonly TeamTableBooking[];
  readonly window: InstantInterval;
  readonly seats: number;
  readonly now: Temporal.Instant;
}): Result.Result<TeamTablePlan | undefined, InvalidDotyposTableSeats> => {
  if (!isIncreasingInstantInterval(window)) return Result.succeed(undefined);

  const candidates = decodeTeamTableCandidates(tables);
  if (Result.isFailure(candidates)) return Result.fail(candidates.failure);

  const { first, last } = getTouchedWorkspaceDateBounds(window);
  const touchedDays = plainDateSpanToInstants({
    startsOn: first,
    endsOn: last,
    timeZone: workspaceSiteConstants.location.timeZone,
  });
  const bookingsByTable = Map.groupBy(bookings, (booking) => booking.tableId);
  const ranked = candidates.success
    .filter(({ seatCapacity }) => seats === seatCapacity)
    .map(({ table }) => {
      const holds = bookingsByTable.get(table.id) ?? [];
      return {
        tableId: table.id,
        blockers: holds.filter((hold) => bookingOverlaps(hold, window)),
        alreadyBooked: holds.some(
          (hold) =>
            hold.kind === "team-table" &&
            instantIntervalsOverlap(hold.interval, touchedDays)
        ),
      };
    })
    .sort(
      (left, right) =>
        left.blockers.length - right.blockers.length ||
        Number(right.alreadyBooked) - Number(left.alreadyBooked) ||
        left.tableId.localeCompare(right.tableId)
    );
  const emptyCandidate = ranked.find(({ blockers }) => blockers.length === 0);
  if (emptyCandidate)
    return Result.succeed({ tableId: emptyCandidate.tableId, moves: [] });

  const today = getWorkspaceDate(now);
  const repackable = ranked.flatMap(({ tableId, blockers }) =>
    blockers.every((booking) => isMovableOpenSpace(booking, today, now)) &&
    new Set(blockers.map(({ move }) => move.reservationId)).size ===
      blockers.length &&
    new Set(blockers.map(({ move }) => move.sourceReservationId)).size ===
      blockers.length
      ? [{ tableId, blockers }]
      : []
  );
  if (repackable.length === 0) return Result.succeed(undefined);

  const destinations = decodeTableCandidates(
    getWorkspaceTableCandidatesByPredicate(tables, (tags) =>
      isWorkspaceCoworkTableCandidate(tags, { entryTier: "open-space" })
    )
  );
  if (Result.isFailure(destinations)) return Result.fail(destinations.failure);
  for (const { tableId, blockers } of repackable) {
    const moves = placeOpenSpaceBookings(
      blockers,
      destinations.success.filter(({ table }) => table.id !== tableId),
      bookingsByTable
    );
    if (moves) return Result.succeed({ tableId, moves });
  }
  return Result.succeed(undefined);
};
