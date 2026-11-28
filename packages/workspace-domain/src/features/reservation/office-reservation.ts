import { Schema } from "effect";
import { officeReservationKind } from "./reservation-kind";

export const makeOfficeSeatsSchema = (message?: string) =>
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(
      1,
      message === undefined ? undefined : { message }
    )
  ).annotate({
    identifier: "OfficeSeats",
    description: "Total number of seats reserved in the office.",
  });

export const officeReservationDayCountSchema = Schema.Int.check(
  Schema.isGreaterThan(0)
).annotate({
  identifier: "OfficeReservationDayCount",
  description: "Inclusive number of whole calendar days reserved.",
});

export const workspaceOfficeProductIdentitySchema = Schema.Struct({
  kind: Schema.Literal(officeReservationKind),
  seats: makeOfficeSeatsSchema(),
  dayCount: officeReservationDayCountSchema,
});

export const workspaceOfficeProductTargetSchema = Schema.Struct({
  kind: workspaceOfficeProductIdentitySchema.fields.kind,
});
