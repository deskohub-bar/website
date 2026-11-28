import { Schema } from "effect";
import { tableReservationKind } from "./reservation-kind";

export const tableReservationSlotMinutes = 15;
const maximumDurationMinutes = 24 * 60;
export const tableDurationMinutesSchema = Schema.Int.check(
  Schema.isBetween({
    minimum: tableReservationSlotMinutes,
    maximum: maximumDurationMinutes,
  }),
  Schema.isMultipleOf(tableReservationSlotMinutes)
);

export const tableSeatsSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const workspaceTableProductIdentitySchema = Schema.Struct({
  kind: Schema.Literal(tableReservationKind),
  seats: tableSeatsSchema,
  durationMinutes: tableDurationMinutesSchema,
});

export type WorkspaceTableProductIdentity =
  typeof workspaceTableProductIdentitySchema.Type;

export const workspaceTableProductTargetSchema = Schema.Struct({
  kind: workspaceTableProductIdentitySchema.fields.kind,
});

export const workspaceTableProductKeySchema = Schema.TemplateLiteral([
  workspaceTableProductIdentitySchema.fields.kind,
  ":",
  tableSeatsSchema,
  ":",
  tableDurationMinutesSchema,
]);

export const getWorkspaceTableProductKey = (
  product: WorkspaceTableProductIdentity
): typeof workspaceTableProductKeySchema.Type =>
  `${product.kind}:${product.seats}:${product.durationMinutes}`;
