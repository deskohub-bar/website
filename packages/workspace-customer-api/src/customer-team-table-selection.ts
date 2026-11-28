import { Schema } from "effect";
import { CustomerPlainDate } from "./customer-booking-selection";

export const CustomerTeamTableSeats = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1)
);

const durationMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 15, maximum: 1440 }),
  Schema.isMultipleOf(15)
);

export const CustomerTeamTableProduct = Schema.Struct({
  kind: Schema.Literal("table"),
  seats: CustomerTeamTableSeats,
  durationMinutes,
}).annotate({ identifier: "CustomerTeamTableProduct" });
export type CustomerTeamTableProduct = typeof CustomerTeamTableProduct.Type;

/** A Prague time of day on a quarter hour. */
export const CustomerTeamTableTime = Schema.String.check(
  Schema.isPattern(/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/)
).annotate({ identifier: "CustomerTeamTableTime" });

export const CustomerTeamTableSelection = Schema.Struct({
  family: Schema.Literal("table"),
  date: CustomerPlainDate,
  startTime: CustomerTeamTableTime,
  /** Equal to or earlier than `startTime` means the next Prague date. */
  endTime: CustomerTeamTableTime,
  seats: CustomerTeamTableSeats,
}).annotate({ identifier: "CustomerTeamTableSelection" });
export type CustomerTeamTableSelection = typeof CustomerTeamTableSelection.Type;
