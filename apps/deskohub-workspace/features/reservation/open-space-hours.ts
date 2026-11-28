import { Schema } from "effect";
import {
  type WorkspaceOpeningHours,
  workspaceSiteConstants,
} from "@/shared/utils/site-constants";
import {
  localDateTimeSchema,
  localDateTimeToInstant,
} from "@/shared/utils/temporal";
import { getWorkspaceDate } from "./reservation-date";

type OpenSpaceHours = Pick<WorkspaceOpeningHours, "openSpaceUsableUntil">;
const configuredHours: WorkspaceOpeningHours =
  workspaceSiteConstants.openingHours;
const decodeLocalDateTime = Schema.decodeUnknownSync(localDateTimeSchema);

/** Prague-local bounds of an Open Space service date, with an exclusive end. */
export const getOpenSpaceServiceDay = (
  serviceDate: Temporal.PlainDate,
  { openSpaceUsableUntil }: OpenSpaceHours = configuredHours
) => ({
  startsAt: decodeLocalDateTime(`${serviceDate}T00:00`),
  endsAt: decodeLocalDateTime(
    openSpaceUsableUntil == null
      ? `${serviceDate.add({ days: 1 })}T00:00`
      : `${serviceDate}T${openSpaceUsableUntil}`
  ),
});

export const isOpenSpaceDayCutoffReached = (
  serviceDate: string,
  now: Temporal.Instant = Temporal.Now.instant(),
  hours: OpenSpaceHours = configuredHours
) => {
  if (hours.openSpaceUsableUntil == null) return false;

  const today = getWorkspaceDate(now);
  if (serviceDate !== today.toString()) return false;

  const cutoff = localDateTimeToInstant({
    dateTime: getOpenSpaceServiceDay(today, hours).endsAt,
    timeZone: workspaceSiteConstants.location.timeZone,
  });
  return Temporal.Instant.compare(now, cutoff) >= 0;
};
