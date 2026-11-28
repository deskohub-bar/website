import type { DotyposTable } from "@deskohub/dotypos";
import { tableReservationSlotMinutes } from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Result } from "effect";
import type { InvalidDotyposTableSeats } from "@/features/checkout/backend/reservation/workspace-table-selection";
import { getOpenSpaceServiceDay } from "@/features/reservation/open-space-hours";
import {
  getTouchedWorkspaceDateBounds,
  getWorkspaceDate,
} from "@/features/reservation/reservation-date";
import type { ReservationInterval } from "@/features/reservation/reservation-interval";
import {
  getTableReservationInterval,
  isTableReservationBookable,
} from "@/features/reservation/table-reservation-time";
import type { TableSlotsAvailability } from "@/features/reservation/workspace-availability";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  getPlainDatesBetween,
  localTimeSchema,
  plainDateSpanToInstants,
} from "@/shared/utils/temporal";
import { decodeTeamTableCandidates } from "./team-table-capacity";
import { planTeamTable, type TeamTableBooking } from "./team-table-plan";

type Inventory = {
  readonly tables: readonly DotyposTable[];
  readonly bookings: readonly TeamTableBooking[];
  readonly fullyOccupiedDates: ReadonlySet<string>;
  readonly now: Temporal.Instant;
};

type LocalTime = typeof localTimeSchema.Type;

const dayMinutes = 24 * 60;

const slotTime = (minutes: number) => {
  const withinDay = minutes % dayMinutes;
  const time = new Temporal.PlainTime(
    Math.floor(withinDay / 60),
    withinDay % 60
  );
  return localTimeSchema.make(time.toString({ smallestUnit: "minute" }));
};

export const planAvailableTeamTable = (
  inventory: Inventory,
  interval: ReservationInterval,
  seats: number
) => {
  const window = {
    startsAt: Temporal.Instant.from(interval.startsAt),
    endsAt: Temporal.Instant.from(interval.endsAt),
  };
  const { first, last } = getTouchedWorkspaceDateBounds(window);
  if (
    !isTableReservationBookable(interval, inventory.now) ||
    getPlainDatesBetween(first, last).some((date) =>
      inventory.fullyOccupiedDates.has(date.toString())
    )
  )
    return Result.succeed(undefined);
  return planTeamTable({ ...inventory, window, seats });
};

export const evaluateTeamTableDay = (
  inventory: Inventory,
  date: Temporal.PlainDate,
  seats: number,
  firstAvailableSlotOnly = false
): Result.Result<
  Pick<
    TableSlotsAvailability,
    "usableFrom" | "usableUntil" | "availableStarts" | "availableEndsByStart"
  >,
  InvalidDotyposTableSeats
> => {
  const serviceDay = getOpenSpaceServiceDay(date);
  const cutoff = Temporal.PlainDateTime.from(serviceDay.endsAt);
  const usableUntil = cutoff.toPlainDate().equals(date)
    ? localTimeSchema.make(
        cutoff.toPlainTime().toString({ smallestUnit: "minute" })
      )
    : null;
  const response: {
    usableFrom: LocalTime;
    usableUntil: LocalTime | null;
    availableStarts: LocalTime[];
    availableEndsByStart: { startTime: LocalTime; endTimes: LocalTime[] }[];
  } = {
    usableFrom: localTimeSchema.make("00:00"),
    usableUntil,
    availableStarts: [],
    availableEndsByStart: [],
  };
  const today = getWorkspaceDate(inventory.now);
  if (
    Temporal.PlainDate.compare(date, today) < 0 ||
    Temporal.PlainDate.compare(date, today.add({ months: 6 })) > 0 ||
    inventory.fullyOccupiedDates.has(date.toString())
  )
    return Result.succeed(response);

  const candidates = decodeTeamTableCandidates(inventory.tables);
  if (Result.isFailure(candidates)) return Result.fail(candidates.failure);
  if (!candidates.success.some(({ seatCapacity }) => seatCapacity === seats))
    return Result.succeed(response);

  const { startsAt, endsAt } = plainDateSpanToInstants({
    startsOn: date,
    endsOn: usableUntil ? date : date.add({ days: 1 }),
    timeZone: workspaceSiteConstants.location.timeZone,
  });
  // Keep each overlapping record's full interval for repack destination checks.
  const bookings = inventory.bookings.filter(
    ({ interval }) =>
      !interval ||
      (Temporal.Instant.compare(interval.startsAt, endsAt) < 0 &&
        Temporal.Instant.compare(interval.endsAt, startsAt) > 0)
  );
  const bounds = { ...inventory, bookings };
  const lastMinute = usableUntil
    ? cutoff.hour * 60 + cutoff.minute
    : dayMinutes;

  for (
    let start = 0;
    start < lastMinute;
    start += tableReservationSlotMinutes
  ) {
    const startTime = slotTime(start);
    const endTimes: LocalTime[] = [];
    const maxEnd = usableUntil ? lastMinute : start + dayMinutes;
    for (
      let end = start + tableReservationSlotMinutes;
      end <= maxEnd;
      end += tableReservationSlotMinutes
    ) {
      const endTime = slotTime(end);
      const interval = getTableReservationInterval(
        date.toString(),
        startTime,
        endTime
      );
      if (!interval || !isTableReservationBookable(interval, inventory.now))
        continue;

      const plan = planAvailableTeamTable(bounds, interval, seats);
      if (Result.isFailure(plan)) return Result.fail(plan.failure);
      // Extending the same start only adds occupancy and move constraints.
      if (!plan.success) break;
      endTimes.push(endTime);
      if (firstAvailableSlotOnly) break;
    }
    if (endTimes.length === 0) continue;
    response.availableStarts.push(startTime);
    response.availableEndsByStart.push({ startTime, endTimes });
    if (firstAvailableSlotOnly) break;
  }
  return Result.succeed(response);
};
