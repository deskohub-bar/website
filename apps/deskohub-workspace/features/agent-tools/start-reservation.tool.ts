import { Duration, Effect, Match, Schema } from "effect";
import { CustomerAccountContactService } from "@/features/account";
import { buildAdvertisedPrice } from "@/features/checkout/backend/checkout/advertised-price.server";
import { type Locale, m } from "@/features/i18n";
import { prepareAgentPayState } from "@/features/reservation/backend/agent-booking";
import {
  BookingSelectionRejected,
  type QuoteSelection,
} from "@/features/reservation/backend/booking-selection";
import { buildEntryPackHoldAdvertisement } from "@/features/reservation/backend/entry-pack-booking";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import { currentInstant } from "@/shared/utils/temporal";
import {
  agentToolLocaleField,
  defineSignedInAgentTool,
  getAgentToolLocale,
} from "./agent-tool";
import { AgentToolError } from "./agent-tool-error";
import { toAgentToolMoney } from "./agent-tool-money";
import { CurrentCustomerAgentGrant } from "./customer-agent-caller";
import {
  passFundingField,
  passFundingScope,
  requireAgentPassesOpen,
  withoutPassFunding,
} from "./pass-funding";
import {
  completeSelectionFields,
  resolveQuoteSelection,
} from "./quote-selection";
import {
  type StartReservationResult,
  startReservationResultSchema,
} from "./start-reservation.schema";

const ordinaryInput = Schema.Struct({
  ...completeSelectionFields,
  early_setup: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Meeting room only: set true when the customer wants to come 15 minutes before the start to set up. It's free; the booked time and price stay the same.",
    })
  ),
  marketing_consent: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Set true only when the customer explicitly asked to receive Deskohub Workspace marketing emails. Omit it otherwise; never assume consent.",
    })
  ),
  locale: agentToolLocaleField,
});
const inputSchema = Schema.Struct({
  ...ordinaryInput.fields,
  pass_id: passFundingField,
});

type StartReservationInput = typeof inputSchema.Type;

/**
 * Starts at most five bookings per account in 30 minutes. Each start calls
 * Dotypos live, about five to seven requests for the profile, the
 * availability re-check, the hold, and superseding the previous hold, so an
 * account's starts stay under a quarter of the 150 requests per 30 minutes
 * the whole site shares.
 */
const startReservationAccountBudget = {
  limit: 5,
  window: Duration.minutes(30),
};

export const startReservationTool = defineSignedInAgentTool({
  name: "start_reservation",
  title: "Start a Deskohub Workspace booking",
  description:
    "Holds a complete selection for the signed-in customer and returns a pay_url. Accepts the same selection as get_quote, including exact start and end times and the seat count for a Team Table. A meeting room also accepts early_setup. Give the pay_url to the customer so they can check the order, accept the terms, and pay on the website before the link expires. The customer's account profile is the contact. Calling again with the same selection returns the same held order and pay_url until the link expires; a different selection replaces your previous unpaid hold unless payment has started. Holds from other assistants stay in place.",
  scope: "reservations:create",
  scopeWhenArgument: passFundingScope,
  accountBudget: startReservationAccountBudget,
  readOnly: false,
  // A different selection cancels the unpaid hold made before; the same
  // selection returns the same held order.
  destructive: true,
  idempotent: true,
  unavailableCode: "reservation_unavailable",
  input: inputSchema,
  output: startReservationResultSchema,
  run: Effect.fn("agentTools.startReservation")((input) =>
    Effect.succeed({ input }).pipe(
      Effect.tap(({ input }) => {
        if (input.pass_id === undefined) return Effect.void;
        return input.family === "cowork"
          ? requireAgentPassesOpen
          : Effect.fail(AgentToolError.invalidInput("pass_id"));
      }),
      Effect.let("locale", ({ input }) => getAgentToolLocale(input)),
      Effect.bind("now", () => currentInstant),
      Effect.bind("grant", () => CurrentCustomerAgentGrant),
      Effect.bind("quoted", resolveQuoteSelection),
      Effect.bind("selection", withEarlySetup),
      Effect.bind("contact", () => readBookingContact),
      Effect.bind(
        "advertised",
        Effect.fnUntraced(function* ({ input, locale, selection }) {
          if (input.pass_id !== undefined) {
            return yield* buildEntryPackHoldAdvertisement({
              reservation: selection.reservation,
              locale,
              passId: input.pass_id,
            }).pipe(Effect.mapError(AgentToolError.passesUnavailable));
          }
          return yield* buildAdvertisedPrice(selection.request).pipe(
            Effect.mapError(
              AgentToolError.unavailable("reservation_unavailable")
            )
          );
        })
      ),
      Effect.bind(
        "prepared",
        ({ input, locale, grant, selection, contact, advertised }) =>
          prepareAgentPayState({
            grant,
            reservation: selection.reservation,
            contact,
            advertisedPriceToken: advertised.advertisedPriceToken,
            ...(input.pass_id && { entryPackId: input.pass_id }),
            // Absent or false records nothing and withdraws nothing; the
            // booking operation labels a grant with the agent channel.
            marketingConsent: input.marketing_consent === true,
            locale,
          }).pipe(Effect.mapError(toStartReservationError))
      ),
      Effect.flatMap(toStartReservationResult)
    )
  ),
});

export const startOrdinaryReservationTool = withoutPassFunding(
  startReservationTool,
  ordinaryInput
);

/**
 * Adds the early setup the customer asked for to a meeting-room selection.
 * The selection key then differs, so a repeat with another choice replaces
 * the hold. Setup is free, so the quoted price stays. Other families offer no
 * setup time.
 */
const withEarlySetup = ({
  input,
  quoted,
}: {
  readonly input: StartReservationInput;
  readonly quoted: QuoteSelection;
}): Effect.Effect<QuoteSelection, AgentToolError> => {
  if (input.early_setup !== true) return Effect.succeed(quoted);
  return quoted.reservation.kind === "meeting-room"
    ? Effect.succeed({
        ...quoted,
        reservation: { ...quoted.reservation, earlySetup: true },
      })
    : Effect.fail(AgentToolError.invalidInput("early_setup"));
};

/**
 * The customer's own account profile, the contact every account booking
 * carries. An account without a bookable profile finishes it on the site.
 */
const readBookingContact = CustomerAccountContactService.pipe(
  Effect.flatMap((contacts) => contacts.current),
  Effect.mapError(AgentToolError.refused("account_unavailable")),
  Effect.flatMap((contact) =>
    contact?.phone
      ? Effect.succeed({ ...contact, phone: contact.phone })
      : Effect.fail(AgentToolError.refused("profile_incomplete")())
  )
);

const toStartReservationError = (
  error: Effect.Error<ReturnType<typeof prepareAgentPayState>>
) =>
  Match.value(error).pipe(
    Match.tag("WorkspaceTableUnavailableError", (cause) =>
      AgentToolError.refused("selection_unavailable")(cause)
    ),
    Match.tag("TableAssignmentUnavailableError", (cause) =>
      AgentToolError.refused("selection_unavailable")(cause)
    ),
    Match.tag("EntryPackUnavailableError", (cause) =>
      AgentToolError.refused("selection_unavailable")(cause)
    ),
    Match.tag("AgentBookingProfileRequiredError", (cause) =>
      AgentToolError.refused("profile_incomplete")(cause)
    ),
    Match.tag("CheckoutAttemptUnavailableError", (cause) =>
      AgentToolError.refused("reservation_conflict")(cause)
    ),
    Match.tag("AgentBookingPaymentInProgressError", (cause) =>
      AgentToolError.refused("payment_in_progress")(cause)
    ),
    Match.tag("AdvertisedPriceMismatchError", (cause) =>
      AgentToolError.refused("reservation_conflict")(cause)
    ),
    Match.tag("CustomerAccountAccessError", (cause) =>
      AgentToolError.refused("account_unavailable")(cause)
    ),
    Match.tag("OfficeReservationsDisabledError", () =>
      AgentToolError.unsupportedFamily()
    ),
    Match.tag("TeamTableReservationsDisabledError", () =>
      AgentToolError.unsupportedFamily()
    ),
    Match.tag("TeamTableAvailabilityClosed", () =>
      AgentToolError.unsupportedFamily()
    ),
    Match.tag("OvernightStayUnavailableError", () =>
      AgentToolError.rejectedSelection(
        BookingSelectionRejected.invalidField("stay")
      )
    ),
    Match.orElse(AgentToolError.unavailable("reservation_unavailable"))
  );

const toStartReservationResult = ({
  input,
  locale,
  advertised,
  prepared,
}: {
  readonly input: StartReservationInput;
  readonly locale: Locale;
  readonly advertised: {
    readonly quote: Pick<
      Effect.Success<ReturnType<typeof buildAdvertisedPrice>>["quote"],
      "payment"
    >;
  };
  readonly prepared: Effect.Success<ReturnType<typeof prepareAgentPayState>>;
}) =>
  Match.value(prepared).pipe(
    Match.discriminatorsExhaustive("status")({
      // The hold creation claim lost to another submission that holds no
      // reusable reservation.
      error: () =>
        Effect.fail(AgentToolError.refused("reservation_conflict")()),
      ready: (ready) => Effect.succeed({ ready, priceChanged: false }),
      pricing_changed: (ready) => Effect.succeed({ ready, priceChanged: true }),
    }),
    Effect.flatMap(({ ready, priceChanged }) =>
      getWorkspaceRuntimeCallbackOrigin.pipe(
        Effect.mapError(AgentToolError.unavailable("reservation_unavailable")),
        Effect.map(
          (origin): StartReservationResult => ({
            order_id: ready.orderId,
            pay_url: new URL(ready.redirectUrl, origin).toString(),
            pay_url_expires_at: ready.expiresAt,
            family: input.family,
            total: toAgentToolMoney(advertised.quote.payment.expectedPrice),
            price_changed: priceChanged,
            note: priceChanged
              ? m.agentToolStartReservationPriceChangedNote({}, { locale })
              : m.agentToolStartReservationNote({}, { locale }),
          })
        )
      )
    )
  );
