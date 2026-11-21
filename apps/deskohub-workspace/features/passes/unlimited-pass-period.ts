import type { PlainDate } from "@/shared/utils/temporal";
import type { PassStatus } from "./pass";

type UnlimitedPassPeriod = {
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
};

const getUnlimitedPassDay = ({
  validFrom,
  validUntil,
  date,
}: UnlimitedPassPeriod & { readonly date: Temporal.PlainDate }) => {
  if (
    Temporal.PlainDate.compare(date, validFrom) < 0 ||
    Temporal.PlainDate.compare(date, validUntil) >= 0
  ) {
    return undefined;
  }

  return date.since(validFrom, { largestUnit: "day" }).days + 1;
};

/** A paid pass keeps access through the last included day of a cancellation. */
export const getUnlimitedPassAccessDay = ({
  status,
  accessEndsOn,
  validUntil,
  ...period
}: UnlimitedPassPeriod & {
  readonly status: PassStatus;
  readonly accessEndsOn: PlainDate | null;
  readonly date: Temporal.PlainDate;
}) => {
  const retainsAccess =
    status === "active" ||
    (accessEndsOn !== null &&
      (status === "cancelled" || status === "withdrawn"));
  return retainsAccess
    ? getUnlimitedPassDay({ ...period, validUntil: accessEndsOn ?? validUntil })
    : undefined;
};
