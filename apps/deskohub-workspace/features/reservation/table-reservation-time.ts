import {
  tableDurationMinutesSchema,
  tableReservationSlotMinutes,
} from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Option, Schema } from "effect";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  instantStringSchema,
  localTimeSchema,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import { getOpenSpaceServiceDay } from "./open-space-hours";
import {
  getTouchedWorkspaceDateBounds,
  getWorkspaceDate,
} from "./reservation-date";
import type { ReservationInterval } from "./reservation-interval-domain";

type OpenSpaceHours = Parameters<typeof getOpenSpaceServiceDay>[1];
const decodeDate = Schema.decodeUnknownOption(plainDateStringSchema);
const decodeTime = Schema.decodeUnknownOption(localTimeSchema);
const decodeDuration = Schema.decodeUnknownOption(tableDurationMinutesSchema);

const resolveLocalInstant = Option.liftThrowable(
  (value: Temporal.PlainDateTime) =>
    value
      .toZonedDateTime(workspaceSiteConstants.location.timeZone, {
        disambiguation: "reject",
      })
      .toInstant()
);

export const getTableReservationDurationMinutes = ({
  startsAt,
  endsAt,
}: ReservationInterval) =>
  (Temporal.Instant.from(endsAt).epochMilliseconds -
    Temporal.Instant.from(startsAt).epochMilliseconds) /
  60_000;

const isSlotBoundary = (time: Temporal.PlainDateTime | Temporal.PlainTime) =>
  time.minute % tableReservationSlotMinutes === 0 &&
  time.second === 0 &&
  time.millisecond === 0 &&
  time.microsecond === 0 &&
  time.nanosecond === 0;

export const isTableReservationSlotTime = (time: string) =>
  Option.isSome(decodeTime(time)) &&
  isSlotBoundary(Temporal.PlainTime.from(time));

export const isTableReservationInterval = (
  interval: ReservationInterval,
  hours?: OpenSpaceHours
) => {
  if (
    Option.isNone(decodeDuration(getTableReservationDurationMinutes(interval)))
  )
    return false;

  const start = Temporal.Instant.from(interval.startsAt);
  const end = Temporal.Instant.from(interval.endsAt);
  const localStart = start
    .toZonedDateTimeISO(workspaceSiteConstants.location.timeZone)
    .toPlainDateTime();
  const localEnd = end
    .toZonedDateTimeISO(workspaceSiteConstants.location.timeZone)
    .toPlainDateTime();
  if (
    !isSlotBoundary(localStart) ||
    !isSlotBoundary(localEnd) ||
    Option.isNone(resolveLocalInstant(localStart)) ||
    Option.isNone(resolveLocalInstant(localEnd))
  )
    return false;

  const { first, last } = getTouchedWorkspaceDateBounds({
    startsAt: start,
    endsAt: end,
  });
  for (
    let date = first;
    Temporal.PlainDate.compare(date, last) <= 0;
    date = date.add({ days: 1 })
  ) {
    const { endsAt } = getOpenSpaceServiceDay(date, hours);
    const cutoff = Temporal.PlainDateTime.from(endsAt);
    // A service day that ends at the next midnight can lead into the next day.
    if (
      cutoff.toPlainDate().equals(date) &&
      Temporal.PlainDateTime.compare(localEnd, cutoff) > 0
    )
      return false;
  }
  return true;
};

/** Interpret an end at or before the start on the following Prague date. */
export const getTableReservationInterval = (
  date: string,
  startTime: string,
  endTime: string,
  hours?: OpenSpaceHours
): ReservationInterval | null =>
  Option.all([
    decodeDate(date),
    decodeTime(startTime),
    decodeTime(endTime),
  ]).pipe(
    Option.flatMap(([day, start, end]) => {
      const startDate = Temporal.PlainDate.from(day);
      const endDate = end <= start ? startDate.add({ days: 1 }) : startDate;
      return Option.all([
        resolveLocalInstant(
          Temporal.PlainDateTime.from(`${startDate}T${start}`)
        ),
        resolveLocalInstant(Temporal.PlainDateTime.from(`${endDate}T${end}`)),
      ]);
    }),
    Option.map(([start, end]) => ({
      startsAt: instantStringSchema.make(start.toString()),
      endsAt: instantStringSchema.make(end.toString()),
    })),
    Option.filter((interval) => isTableReservationInterval(interval, hours)),
    Option.getOrNull
  );

export const isTableReservationBookable = (
  interval: ReservationInterval,
  now: Temporal.Instant
) =>
  Temporal.Instant.compare(Temporal.Instant.from(interval.endsAt), now) > 0 &&
  Temporal.PlainDate.compare(
    getWorkspaceDate(Temporal.Instant.from(interval.startsAt)),
    getWorkspaceDate(now).add({ months: 6 })
  ) <= 0;
