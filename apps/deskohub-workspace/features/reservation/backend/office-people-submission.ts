import { Data, Effect, Result } from "effect";
import {
  getOfficePeopleSeats,
  type OfficePeople,
  type OfficePeopleIssue,
  type ValidOfficePeople,
  validateOfficePeople,
} from "@/features/office/office-people";
import { getOfficeReservationIntervalInput } from "@/features/reservation/office-reservation";
import type { ReservationOrderData } from "@/features/reservation/reservation-order";

/**
 * Why a submitted people list can't book: one of the list's own issues,
 * an office head count that differs from its seats, or a reservation that
 * doesn't support invitees.
 */
export type OfficePeopleRejection =
  | OfficePeopleIssue
  | { readonly _tag: "SeatsMismatch" }
  | { readonly _tag: "NotOffice" };

export class OfficePeopleRejectedError extends Data.TaggedError(
  "OfficePeopleRejectedError"
)<{ readonly rejection: OfficePeopleRejection }> {}

/**
 * Checks the people a submission sends with its reservation, against the
 * reservation's contact email and seats. Office seats equal the head count.
 * A Team Table can have spare seats and defaults to the contact attending.
 * Older Office submissions can still book seats without a people list.
 */
export const validateSubmittedOfficePeople = (
  people: OfficePeople | undefined,
  reservation: ReservationOrderData
): Effect.Effect<ValidOfficePeople | undefined, OfficePeopleRejectedError> => {
  if (people === undefined) {
    return Effect.succeed(
      reservation.kind === "table"
        ? { contactAttends: true, invitees: [] }
        : undefined
    );
  }
  if (reservation.kind !== "office" && reservation.kind !== "table") {
    return Effect.fail(
      new OfficePeopleRejectedError({ rejection: { _tag: "NotOffice" } })
    );
  }
  const checked = validateOfficePeople(people, {
    seatCapacity: reservation.seats,
    contactEmail: reservation.email,
  });
  if (Result.isFailure(checked)) {
    return Effect.fail(
      new OfficePeopleRejectedError({ rejection: checked.failure })
    );
  }
  return reservation.kind === "table" ||
    getOfficePeopleSeats(checked.success) === reservation.seats
    ? Effect.succeed(checked.success)
    : Effect.fail(
        new OfficePeopleRejectedError({
          rejection: { _tag: "SeatsMismatch" },
        })
      );
};

/** When an office's access ends: the end of its last booked day in Prague. */
export const getOfficeAccessEndsAt = (reservation: {
  readonly startsOn: string;
  readonly endsOn: string;
}) =>
  Temporal.Instant.from(getOfficeReservationIntervalInput(reservation).endsAt);
