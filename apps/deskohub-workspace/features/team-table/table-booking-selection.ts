import {
  getTableReservationInterval,
  isTableReservationBookable,
  isTableReservationSlotTime,
} from "@/features/reservation/table-reservation-time";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";

export type TableBookingSelection = {
  readonly seats: number;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
};

type TableBookingWindow = {
  readonly today: string;
  readonly capacities: readonly number[];
  readonly now?: Temporal.Instant;
};

export const getTableBookingSelection = (
  linked: Partial<TableBookingSelection>,
  { today, capacities, now = Temporal.Now.instant() }: TableBookingWindow
): TableBookingSelection => {
  const { from, to } = getWorkspaceAvailabilityRange(today);
  const seats =
    linked.seats !== undefined && capacities.includes(linked.seats)
      ? linked.seats
      : (capacities[0] ?? 0);
  const date =
    linked.date && linked.date >= from && linked.date <= to
      ? linked.date
      : today;
  const startTime =
    (linked.seats === undefined || linked.seats === seats) &&
    linked.date === date &&
    linked.startTime &&
    isTableReservationSlotTime(linked.startTime)
      ? linked.startTime
      : "";
  const interval = linked.endTime
    ? getTableReservationInterval(date, startTime, linked.endTime)
    : null;
  if (interval && !isTableReservationBookable(interval, now)) {
    return { seats, date, startTime: "", endTime: "" };
  }
  const endTime = interval ? (linked.endTime ?? "") : "";
  return { seats, date, startTime, endTime };
};

export const getTableBookingTimes = (
  availability:
    | {
        readonly date: string;
        readonly seats: number;
        readonly availableStarts: readonly string[];
        readonly availableEndsByStart: readonly {
          readonly startTime: string;
          readonly endTimes: readonly string[];
        }[];
      }
    | null
    | undefined,
  { date, seats, startTime }: TableBookingSelection
) => {
  if (availability?.date !== date || availability.seats !== seats) {
    return { startTimes: [], endTimes: [] };
  }
  return {
    startTimes: availability.availableStarts,
    endTimes:
      availability.availableEndsByStart.find(
        (entry) => entry.startTime === startTime
      )?.endTimes ?? [],
  };
};
