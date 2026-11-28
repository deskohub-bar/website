import { Effect, Schema, Struct } from "effect";
import bookingWidgetHtml from "@/features/agent-tools/booking-widget/generated/booking-widget.html" with {
  type: "text",
};
import { m } from "@/features/i18n";
import { ensureTeamTableReservationsEnabled } from "@/features/team-table/backend/team-table-release-gate";
import {
  agentToolLocaleField,
  CallableAgentTools,
  defineAgentTool,
  getAgentToolLocale,
} from "./agent-tool";
import { AgentToolError } from "./agent-tool-error";
import type { AgentToolView } from "./agent-tool-view";
import { loadAgentOfferings } from "./list-offerings.tool";
import { completeSelectionFields } from "./quote-selection";
import {
  type BookingMode,
  type ShowBookingResult,
  showBookingResultSchema,
} from "./show-booking.schema";
import { startReservationTool } from "./start-reservation.tool";

/** The booking view: offerings, availability, a quote, and the handoff. */
const bookingView: AgentToolView = {
  uri: "ui://dh-workspace/booking-v3.html",
  name: "booking",
  title: "Deskohub Workspace booking",
  description:
    "Lets the customer choose a product, date, and options, check availability and the price, and continue on the website.",
  invocationStatus: {
    invoking: "Opening the booking view…",
    invoked: "Booking view ready",
  },
  html: bookingWidgetHtml,
};

const inputSchema = Schema.Struct({
  family: Schema.optionalKey(completeSelectionFields.family),
  date: Schema.optionalKey(completeSelectionFields.date),
  end_date: completeSelectionFields.end_date,
  tier: completeSelectionFields.tier,
  duration: completeSelectionFields.duration,
  start_time: completeSelectionFields.start_time,
  end_time: completeSelectionFields.end_time,
  seats: completeSelectionFields.seats,
  locale: agentToolLocaleField,
});

/**
 * `show_booking` for a client whose app directory admits checkout links, or
 * for one whose doesn't, which decides whether its view may start a booking
 * (`getBookingMode`).
 */
export const makeShowBookingTool = ({
  admitsCheckout,
}: {
  readonly admitsCheckout: boolean;
}) =>
  defineAgentTool({
    name: "show_booking",
    title: "Show the Deskohub Workspace booking view",
    description:
      "Shows an interactive view where the customer chooses a Workspace offering, a date and options, checks availability and the price, and continues on the website. Prefill any choices the customer already made, including seats and times for a Team Table. The result lists the offerings and the booking_mode, so where no view is shown, continue with check_availability and get_quote.",
    access: "public",
    readOnly: true,
    unavailableCode: "offerings_unavailable",
    view: bookingView,
    input: inputSchema,
    output: showBookingResultSchema,
    run: Effect.fn("agentTools.showBooking")((input) =>
      Effect.Do.pipe(
        Effect.tap(() =>
          input.family === "table"
            ? ensureTeamTableReservationsEnabled.pipe(
                Effect.mapError(AgentToolError.unsupportedFamily)
              )
            : Effect.void
        ),
        Effect.let("locale", () => getAgentToolLocale(input)),
        Effect.bind("listing", ({ locale }) => loadAgentOfferings(locale)),
        Effect.bind("mode", () => getBookingMode(admitsCheckout)),
        Effect.map(
          ({ locale, listing, mode }): ShowBookingResult => ({
            booking_mode: mode,
            locale,
            selection: Struct.omit(input, ["locale"]),
            ...listing,
            note: {
              reserve: () => m.agentToolBookingViewReserveNote({}, { locale }),
              reservation_page: () =>
                m.agentToolBookingViewReservationPageNote({}, { locale }),
            }[mode](),
          })
        )
      )
    ),
  });

/**
 * How the view lets the customer finish: it starts a booking only where the
 * client's directory admits checkout links and the caller may call
 * `start_reservation`. ChatGPT's public `start_reservation` is callable by
 * anyone, so the directory rule decides there.
 */
const getBookingMode = (admitsCheckout: boolean) =>
  CallableAgentTools.pipe(
    Effect.map(
      (callable): BookingMode =>
        admitsCheckout && callable.has(startReservationTool.name)
          ? "reserve"
          : "reservation_page"
    )
  );
