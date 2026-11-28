import { Schema } from "effect";
import { workspaceCoworkCurrentTiers } from "@/features/checkout/product-catalog";
import { workspaceReservationKindSchema } from "@/features/reservation/reservation-kind";

// The widget decodes this inside the host's sandbox. Keep its wire DTO free
// of the availability module's reservation form and locale dependencies.
const tableSlotsResult = Schema.Struct({
  date: Schema.String,
  seats: Schema.Int,
  slotMinutes: Schema.Literal(15),
  usableFrom: Schema.String,
  usableUntil: Schema.NullOr(Schema.String),
  availableStarts: Schema.Array(Schema.String),
  availableEndsByStart: Schema.Array(
    Schema.Struct({
      startTime: Schema.String,
      endTimes: Schema.Array(Schema.String),
    })
  ),
});

export const checkAvailabilityResultSchema = Schema.Struct({
  family: workspaceReservationKindSchema,
  available: Schema.Boolean.annotate({
    description:
      "Whether the whole selection looked free. For a Team Table request without times, whether any slot looked free for the requested size on that date.",
  }),
  days: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      available: Schema.Boolean,
      offers: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            tier: Schema.Literals(workspaceCoworkCurrentTiers),
            available: Schema.Boolean,
            workstation_required: Schema.Boolean,
          })
        )
      ),
    })
  ),
  meeting_room: Schema.optionalKey(
    Schema.Struct({
      duration: Schema.String,
      starts_at: Schema.String,
      ends_at: Schema.String,
      early_setup_available: Schema.Boolean.annotate({
        description:
          "Whether the meeting room is also free for the 15 minutes before the start, so the customer can come early to set up.",
      }),
    })
  ),
  office: Schema.optionalKey(
    Schema.Struct({
      seats: Schema.Int,
      max_seats: Schema.Int,
    })
  ),
  table: Schema.optionalKey(
    tableSlotsResult.annotate({
      description:
        "Start and end choices when both times were omitted from a Team Table request.",
    })
  ),
  checked_at: Schema.String,
  note: Schema.String,
  reservation_url: Schema.String,
});

export type CheckAvailabilityResult = typeof checkAvailabilityResultSchema.Type;
