import type {
  CustomerTeamTableCalendar,
  CustomerTeamTableSelection,
  CustomerTeamTableSlots,
} from "@deskohub/workspace-customer-api";
import type { DateChoice } from "./booking-selection";
import { type OfficePeople, officePeopleCount, youOnly } from "./office-people";
import { type PragueDate, pragueDateTimeAt } from "./prague-date";

export interface TeamTableDraft {
  readonly seats: number;
  readonly date?: PragueDate | undefined;
  readonly startTime?: string | undefined;
  readonly endTime?: string | undefined;
  readonly people: OfficePeople;
}

export const openingTeamTableDraft = (
  initialSeats: number,
  preselection?: CustomerTeamTableSelection,
  people: OfficePeople = youOnly
): TeamTableDraft => {
  if (preselection === undefined) return { seats: initialSeats, people };
  const { seats, date, startTime, endTime } = preselection;
  return { seats, date, startTime, endTime, people };
};

export const teamTableDates = (
  calendar: CustomerTeamTableCalendar | undefined,
  seats: number
): DateChoice | undefined =>
  calendar?.seats === seats
    ? {
        earliest: calendar.from,
        latest: calendar.to,
        unavailable: new Set(calendar.unavailableDates),
      }
    : undefined;

export const isTeamTableDateAvailable = (date: PragueDate, dates: DateChoice) =>
  date >= dates.earliest &&
  date <= dates.latest &&
  !dates.unavailable.has(date);

/** Keep the slot order from Workspace, including ends after midnight. */
export const teamTableSelection = (
  { seats, date, startTime, endTime, people }: TeamTableDraft,
  calendar: CustomerTeamTableCalendar | undefined,
  slots: CustomerTeamTableSlots | undefined,
  now: Date
) => {
  const dates = teamTableDates(calendar, seats);
  const pragueNow = pragueDateTimeAt(now);
  const dateAvailable =
    date !== undefined &&
    date >= pragueNow.date &&
    dates !== undefined &&
    isTeamTableDateAvailable(date, dates);
  const currentSlots =
    dateAvailable && slots?.date === date && slots?.seats === seats
      ? slots
      : undefined;
  // Workspace allows a start already in progress while its end is still ahead.
  const liveEnd = (start: string, end: string) =>
    date !== pragueNow.date ||
    end <= start ||
    Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) >
      pragueNow.hour * 60 + pragueNow.minute;
  const endsByStart = new Map(
    currentSlots?.availableEndsByStart.map(({ startTime, endTimes }) => [
      startTime,
      endTimes,
    ])
  );
  const starts = (currentSlots?.availableStarts ?? []).filter((start) => {
    const lastEnd = endsByStart.get(start)?.at(-1);
    return lastEnd !== undefined && liveEnd(start, lastEnd);
  });
  const ends =
    startTime !== undefined && starts.includes(startTime)
      ? (endsByStart.get(startTime) ?? []).filter((end) =>
          liveEnd(startTime, end)
        )
      : [];
  const attendees = officePeopleCount(people);
  const hasAttendee = attendees > 0;
  const withinCapacity = attendees <= seats;
  const selection: CustomerTeamTableSelection | undefined =
    date !== undefined &&
    startTime !== undefined &&
    endTime !== undefined &&
    ends.includes(endTime) &&
    withinCapacity &&
    hasAttendee
      ? { family: "table", seats, date, startTime, endTime }
      : undefined;
  return {
    dates,
    dateAvailable,
    starts,
    ends,
    withinCapacity,
    hasAttendee,
    selection,
  };
};
