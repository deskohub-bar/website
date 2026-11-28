import { decodeStandardSchema } from "@deskohub/standard-schema";
import { tableSeatsSchema } from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Schema } from "effect";
import { getTrimmedSearchParam } from "@/features/reservation/reservation-checkout-query";
import { defineSelectionLink } from "@/features/reservation/selection-link";
import type { SupportedSearchParams } from "@/shared/utils";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  localTimeSchema,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import { getTableReservationInterval } from "./table-reservation-time";

const queryDateSchema = Schema.toStandardSchemaV1(plainDateStringSchema);
const queryTimeSchema = Schema.toStandardSchemaV1(localTimeSchema);
const querySeatsSchema = Schema.toStandardSchemaV1(
  Schema.FiniteFromString.pipe(Schema.decodeTo(tableSeatsSchema))
);

type TableSelection = {
  readonly date?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly seats?: number;
};

export const tableSelectionLink = defineSelectionLink({
  kind: "table",
  params: ["date", "seats", "startTime", "endTime"],
  read: (searchParams: SupportedSearchParams): TableSelection => ({
    date: decodeStandardSchema(
      queryDateSchema,
      getTrimmedSearchParam(searchParams, "date")
    ),
    seats: decodeStandardSchema(
      querySeatsSchema,
      getTrimmedSearchParam(searchParams, "seats")
    ),
    startTime: decodeStandardSchema(
      queryTimeSchema,
      getTrimmedSearchParam(searchParams, "startTime")
    ),
    endTime: decodeStandardSchema(
      queryTimeSchema,
      getTrimmedSearchParam(searchParams, "endTime")
    ),
  }),
  write: ({ date, seats, startTime, endTime }: TableSelection) => ({
    date: date || undefined,
    seats: seats ? String(seats) : undefined,
    startTime: startTime || undefined,
    endTime: endTime || undefined,
  }),
  fromStored: ({
    reservedFrom,
    reservedUntil,
    seats,
  }: {
    readonly reservedFrom: Temporal.Instant;
    readonly reservedUntil: Temporal.Instant;
    readonly seats: number;
  }): TableSelection | undefined => {
    const start = reservedFrom.toZonedDateTimeISO(
      workspaceSiteConstants.location.timeZone
    );
    const end = reservedUntil.toZonedDateTimeISO(
      workspaceSiteConstants.location.timeZone
    );
    const date = start.toPlainDate().toString();
    const startTime = start.toPlainTime().toString({ smallestUnit: "minute" });
    const endTime = end.toPlainTime().toString({ smallestUnit: "minute" });
    const interval = getTableReservationInterval(date, startTime, endTime);
    if (
      !interval ||
      !reservedFrom.equals(interval.startsAt) ||
      !reservedUntil.equals(interval.endsAt)
    )
      return undefined;
    return { date, startTime, endTime, seats };
  },
});
