import {
  CustomerBookingDateOutOfRange,
  type CustomerBookingSelection,
  CustomerBookingSelectionInvalid,
  CustomerOfferingUnavailable,
  CustomerSelectionUnavailable,
  type CustomerTeamTableSelection,
  CustomerTeamTableUnavailable,
} from "@deskohub/workspace-customer-api";
import { Effect, Match, Option, Schema } from "effect";
import { EntryPackUnavailableError } from "@/features/passes/backend/entry-pack-redemption";
import {
  type BookingSelectionInput,
  BookingSelectionRejected,
  type BookingSelectionRejection,
  type QuoteSelection,
} from "@/features/reservation/backend/booking-selection";
import {
  TeamTableAvailabilityClosed,
  WorkspaceTableUnavailableError,
} from "@/features/reservation/backend/workspace-availability.service";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  answerSessionApiFailure,
  type CustomerSessionApiFailure,
} from "./customer-api-failure";

const decodePlainDate = Schema.decodeUnknownOption(plainDateStringSchema);

export const requireCustomerTeamTableRelease = TeamTableReleaseGate.isOpen.pipe(
  Effect.filterOrFail(
    (open) => open,
    () => new CustomerTeamTableUnavailable()
  ),
  Effect.asVoid
);

/**
 * The selection a client sent, as the booking domain resolves it: its dates
 * as calendar dates, which the contract checks only for their format.
 */
export const toBookingSelectionInput = (
  selection: CustomerBookingSelection | CustomerTeamTableSelection
): Effect.Effect<BookingSelectionInput, BookingSelectionRejected> =>
  Effect.gen(function* () {
    const plainDate = (field: "date" | "endDate", value: string) =>
      Option.match(decodePlainDate(value), {
        onNone: () => Effect.fail(BookingSelectionRejected.invalidField(field)),
        onSome: Effect.succeed,
      });

    const date = yield* plainDate("date", selection.date);
    if (selection.family === "table") return { ...selection, date };

    const { endDate, funding: _funding, ...fields } = selection;
    return {
      ...fields,
      date,
      ...(endDate !== undefined && {
        endDate: yield* plainDate("endDate", endDate),
      }),
    };
  });

export const entryPackUnavailableAnswer = () =>
  new CustomerSelectionUnavailable({ reason: "availability_changed" });

/** The public error a selection the booking pages wouldn't accept answers with. */
const toSelectionRejectionAnswer = <Unavailable>(
  reason: BookingSelectionRejection,
  offeringUnavailable: () => Unavailable
) =>
  Match.value(reason).pipe(
    Match.discriminatorsExhaustive("kind")({
      "invalid-field": ({ field }) =>
        new CustomerBookingSelectionInvalid({ field }),
      "date-out-of-range": ({ earliest, latest }) =>
        new CustomerBookingDateOutOfRange({ earliest, latest }),
      "office-closed": offeringUnavailable,
      "table-closed": offeringUnavailable,
    })
  );

const isSelectionInvalid = <E>(
  failure: E
): failure is Extract<E, CustomerBookingSelectionInvalid> =>
  failure instanceof CustomerBookingSelectionInvalid;

/**
 * Answers a selection the booking pages wouldn't accept with its public
 * error, keeps a field the contract itself refuses (such as early setup for
 * another family), and answers every other failure, such as a price that
 * can't be quoted, as unavailable: a Calendar sale that can't be read is
 * retried, never answered as a changed price. Every endpoint that resolves a
 * booking selection ends in it.
 */
const answerSelectionFailure =
  <Unavailable>(operation: string, offeringUnavailable: () => Unavailable) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch(
        (
          failure
        ): Effect.Effect<
          never,
          | ReturnType<typeof toSelectionRejectionAnswer<Unavailable>>
          | Unavailable
          | CustomerSelectionUnavailable
          | Extract<E, CustomerBookingSelectionInvalid>
          | CustomerSessionApiFailure<
              Exclude<
                E,
                | BookingSelectionRejected
                | CustomerBookingSelectionInvalid
                | EntryPackUnavailableError
                | TeamTableAvailabilityClosed
                | WorkspaceTableUnavailableError
              >
            >
        > => {
          if (failure instanceof BookingSelectionRejected)
            return Effect.fail(
              toSelectionRejectionAnswer(failure.reason, offeringUnavailable)
            );
          if (failure instanceof EntryPackUnavailableError)
            return Effect.fail(entryPackUnavailableAnswer());
          if (failure instanceof TeamTableAvailabilityClosed)
            return Effect.fail(offeringUnavailable());
          if (failure instanceof WorkspaceTableUnavailableError)
            return Effect.fail(
              new CustomerSelectionUnavailable({
                reason: "availability_changed",
              })
            );
          if (isSelectionInvalid(failure)) return Effect.fail(failure);
          return Effect.fail(failure).pipe(answerSessionApiFailure(operation));
        }
      )
    );

export const answerBookingSelectionFailure = (operation: string) =>
  answerSelectionFailure(
    operation,
    () => new CustomerOfferingUnavailable({ family: "office" })
  );

export const answerTeamTableSelectionFailure = (operation: string) =>
  answerSelectionFailure(operation, () => new CustomerTeamTableUnavailable());

/**
 * Adds the early setup a meeting-room booking asked for, at no cost, as
 * `start_reservation` does. Other families offer none.
 */
export const withEarlySetup = (
  selection: QuoteSelection,
  earlySetup: boolean | undefined
): Effect.Effect<
  QuoteSelection["reservation"],
  CustomerBookingSelectionInvalid
> => {
  if (earlySetup !== true) return Effect.succeed(selection.reservation);
  return selection.reservation.kind === "meeting-room"
    ? Effect.succeed({ ...selection.reservation, earlySetup: true })
    : Effect.fail(new CustomerBookingSelectionInvalid({ field: "earlySetup" }));
};
