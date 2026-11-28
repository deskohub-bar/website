import { Schema } from "effect";

export const reservationInviteeIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ReservationInviteeId")
).annotate({
  identifier: "ReservationInviteeId",
  description:
    "Opaque identifier for a person a booker invited to a reservation by email.",
});

export type ReservationInviteeId = typeof reservationInviteeIdSchema.Type;

/**
 * Names the key that encrypted an invitee's address and derived its lookup
 * key, so rows written before a key rotation stay readable: the kid of the
 * `CHECKOUT_PAY_STATE_KEYS` entry both keys derive from.
 */
export const reservationInviteeKeyIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ReservationInviteeKeyId")
);

export type ReservationInviteeKeyId = typeof reservationInviteeKeyIdSchema.Type;
