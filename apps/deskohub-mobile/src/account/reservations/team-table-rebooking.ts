import {
  type CustomerTeamTableProduct,
  CustomerTeamTableSelection,
} from "@deskohub/workspace-customer-api";
import { Schema } from "effect";
import { teamTableBookAgainHref } from "../../booking/booking-preselection";
import { bookFamilyHref } from "../../booking/booking-routes";
import {
  addDays,
  type PragueDateTime,
  pragueDateTimeAt,
} from "../../booking/selection/prague-date";

const timeOf = ({ hour, minute }: PragueDateTime) =>
  [hour, minute].map((part) => String(part).padStart(2, "0")).join(":");

const isTeamTableSelection = Schema.is(CustomerTeamTableSelection);

const isRepeatedTime = (value: number, local: PragueDateTime) =>
  [-3_600_000, 3_600_000].some((offset) => {
    const other = pragueDateTimeAt(new Date(value + offset));
    return other.date === local.date && timeOf(other) === timeOf(local);
  });

/** Restore the exact Prague slot when it can be expressed as a selection. */
export const teamTableSelectionOfReservation = ({
  product,
  startsAt,
  endsAt,
}: {
  readonly product?: CustomerTeamTableProduct | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
}): CustomerTeamTableSelection | undefined => {
  if (product === undefined || !startsAt || !endsAt) return undefined;
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (
    startMs % 60_000 !== 0 ||
    endMs % 60_000 !== 0 ||
    (endMs - startMs) / 60_000 !== product.durationMinutes
  )
    return undefined;
  const start = pragueDateTimeAt(new Date(startMs));
  const end = pragueDateTimeAt(new Date(endMs));
  const startTime = timeOf(start);
  const endTime = timeOf(end);
  const endDate = endTime <= startTime ? addDays(start.date, 1) : start.date;
  const selection = {
    family: "table",
    date: start.date,
    seats: product.seats,
    startTime,
    endTime,
  };
  return end.date === endDate &&
    !isRepeatedTime(startMs, start) &&
    !isRepeatedTime(endMs, end) &&
    isTeamTableSelection(selection)
    ? selection
    : undefined;
};

export const teamTableRebookingHref = (
  reservation: Parameters<typeof teamTableSelectionOfReservation>[0]
) => {
  const selection = teamTableSelectionOfReservation(reservation);
  return selection === undefined
    ? bookFamilyHref("table")
    : teamTableBookAgainHref(selection);
};
