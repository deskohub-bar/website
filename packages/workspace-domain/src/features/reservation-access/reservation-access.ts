import { Schema } from "effect";

export const reservationAccessGrantIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ReservationAccessGrantId")
).annotate({
  identifier: "ReservationAccessGrantId",
  description: "Opaque identifier for a reservation access issuance ledger.",
});
export type ReservationAccessGrantId =
  typeof reservationAccessGrantIdSchema.Type;

export const reservationAccessGrantStates = [
  "pending",
  "provisioning",
  "issued",
  "expired",
  "uncertain",
  "failed",
] as const;
export type ReservationAccessGrantState =
  (typeof reservationAccessGrantStates)[number];
