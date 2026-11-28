import { Schema } from "effect";
import { coworkStaySchema } from "@/features/reservation/cowork-stay";
import { meetingRoomReservationDurationKeySchema } from "@/features/reservation/meeting-room-reservation-duration";
import { workspaceReservationKindSchema } from "@/features/reservation/reservation-kind";
import { isPlainDateString } from "@/shared/utils/temporal";

// Tool arguments use inline schemas without identifiers, so each published
// property carries its own type and description instead of a shared `$ref`.
const workspaceDateArgument = (description: string) =>
  Schema.String.annotate({ description })
    .check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/), isPlainDateString())
    .pipe(Schema.brand("PlainDate"));

export const quarterHourTimePattern = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;

/**
 * The Reserved Desk stay an availability, quote, or booking tool takes. The
 * selection is rejected on `stay` while overnight stays are not offered.
 */
export const coworkStayArgument = coworkStaySchema.annotate({
  description:
    "Cowork Reserved Desk only: day (default; the date's Prague calendar day) or overnight (from noon on the date, the arrival date, to noon the next date, Prague time; same price). Rejected while overnight stays are not offered.",
});

/** Selection fields shared by the availability and quote tools. */
export const reservationSelectionFields = {
  family: workspaceReservationKindSchema.annotate({
    description:
      "Reservation family: cowork (a desk for a day), meeting-room, office (a private office for whole days), or table (an exclusive Team Table in Open Space).",
  }),
  date: workspaceDateArgument(
    "Prague calendar date in YYYY-MM-DD format. For an office or a cowork range, the first date."
  ),
  end_date: Schema.optionalKey(
    workspaceDateArgument(
      "Cowork or office only: the last date, inclusive, in YYYY-MM-DD format. Defaults to date."
    )
  ),
  start_time: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Prague start time in HH:mm, on the hour for the meeting room or on a quarter hour for a Team Table. A booking may start before now if it ends in the future. Omit both times when checking a Team Table's free slots. Omit for a whole-day meeting room booking.",
    }).check(Schema.isPattern(/^\d{2}:\d{2}$/))
  ),
  end_time: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Team Table only: exclusive Prague end time in HH:mm on a quarter hour. A time at or before the start ends the next day, where allowed. Provide both times to quote or book.",
    }).check(Schema.isPattern(quarterHourTimePattern))
  ),
  duration: Schema.optionalKey(
    meetingRoomReservationDurationKeySchema.annotate({
      description:
        "Meeting room only: hour:1 (one hour), hour:4 (four hours), or day:1 (a whole Prague calendar day, today included until it ends).",
    })
  ),
  seats: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        "Number of seats. Required for Team Table and must match an offered table size. Defaults to 1 for an office.",
    }).check(Schema.isGreaterThanOrEqualTo(1))
  ),
};

/**
 * The shared fields for a quote: a cowork booking covers one date, so only an
 * office takes a date range.
 */
export const quoteSelectionFields = {
  ...reservationSelectionFields,
  date: workspaceDateArgument(
    "Prague calendar date in YYYY-MM-DD format. For an office, the first date."
  ),
  end_date: Schema.optionalKey(
    workspaceDateArgument(
      "Office only: the last date, inclusive, in YYYY-MM-DD format. Defaults to date."
    )
  ),
};
