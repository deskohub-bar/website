import { Effect, Match, Schema } from "effect";
import type { AdvertisedPrice } from "@/features/checkout/advertised-price";
import { buildAdvertisedPrice } from "@/features/checkout/backend/checkout/advertised-price.server";
import { getReservationQuoteDiscount } from "@/features/checkout/reservation-quote-schema";
import { m } from "@/features/i18n";
import type { QuoteSelection } from "@/features/reservation/backend/booking-selection";
import { getShareableReservationUrl } from "@/features/reservation/backend/shareable-reservation-url";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import { getFirstInvalidFieldPath } from "@/shared/utils/schema-issue";
import { currentInstant } from "@/shared/utils/temporal";
import {
  agentToolLocaleField,
  defineAgentTool,
  defineMixedAccessAgentTool,
  getAgentToolLocale,
} from "./agent-tool";
import { AgentToolError } from "./agent-tool-error";
import { toAgentToolMoney } from "./agent-tool-money";
import { type GetQuoteResult, getQuoteResultSchema } from "./get-quote.schema";
import {
  getFundedReservationUrl,
  passFundingField,
  passFundingScope,
  quoteWithEntryPack,
  requireAgentPassesOpen,
  withoutPassFunding,
} from "./pass-funding";
import {
  completeSelectionFields,
  resolveQuoteSelection,
} from "./quote-selection";

const ordinaryInput = Schema.Struct({
  ...completeSelectionFields,
  locale: agentToolLocaleField,
});
const inputSchema = Schema.Struct({
  ...ordinaryInput.fields,
  pass_id: passFundingField,
});

type GetQuoteInput = typeof inputSchema.Type;

const quoteToolDefinition = {
  name: "get_quote",
  title: "Quote a Deskohub Workspace booking",
  description:
    "Prices a complete selection anonymously. A Team Table quote checks the date, offered seat count, and exact start and end times before pricing. The total includes any public sale, and the reservation link opens the booking page with the selection filled in. Use check_availability to find free dates and times.",
  readOnly: true,
  unavailableCode: "quote_unavailable",
  input: inputSchema,
  output: getQuoteResultSchema,
} as const;

const resolveSelection = (input: GetQuoteInput) =>
  Effect.succeed({ input }).pipe(
    Effect.let("locale", ({ input }) => getAgentToolLocale(input)),
    Effect.bind("now", () => currentInstant),
    Effect.bind("selection", resolveQuoteSelection)
  );

const quoteOrdinaryBooking = Effect.fn("agentTools.getQuote")(
  (input: GetQuoteInput) =>
    resolveSelection(input).pipe(
      Effect.tap(({ selection: { reservation } }) =>
        reservation.kind === "table"
          ? WorkspaceAvailabilityService.pipe(
              Effect.flatMap((service) => service.ensureAvailable(reservation)),
              Effect.mapError((cause) =>
                Match.value(cause).pipe(
                  Match.tag(
                    "WorkspaceTableUnavailableError",
                    AgentToolError.refused("selection_unavailable")
                  ),
                  Match.tag(
                    "TeamTableAvailabilityClosed",
                    AgentToolError.unsupportedFamily
                  ),
                  Match.orElse(AgentToolError.unavailable("quote_unavailable"))
                )
              )
            )
          : Effect.void
      ),
      Effect.bind("pricing", priceQuoteSelection),
      Effect.map(toQuoteResult)
    )
);

const priceFundedBooking = Effect.fn("agentTools.getFundedQuote")(
  (input: GetQuoteInput) => {
    const passId = input.pass_id;
    if (input.family !== "cowork" || passId === undefined) {
      return Effect.fail(AgentToolError.invalidInput("pass_id"));
    }
    return requireAgentPassesOpen.pipe(
      Effect.andThen(resolveSelection(input)),
      Effect.bind("pricing", ({ selection, locale }) =>
        Effect.all({
          advertised: quoteWithEntryPack({ selection, locale, passId }),
          reservationUrl: getFundedReservationUrl(selection, passId),
        })
      )
    );
  }
);

export const getQuoteTool = defineMixedAccessAgentTool({
  ...quoteToolDefinition,
  scopeWhenArgument: passFundingScope,
  run: quoteOrdinaryBooking,
  runWithGrant: (input) =>
    priceFundedBooking(input).pipe(Effect.map(toQuoteResult)),
});

export const getOrdinaryQuoteTool = withoutPassFunding(
  getQuoteTool,
  ordinaryInput
);

export const getBrowserPassQuoteTool = defineAgentTool({
  ...quoteToolDefinition,
  access: "public",
  run: (input: GetQuoteInput) =>
    priceFundedBooking(input).pipe(Effect.map(toQuoteResult)),
});

/** The mounted browser form needs this proof for its Server Action. */
export const getBrowserPassPreparationQuote = (input: Schema.Json) =>
  Schema.decodeUnknownEffect(inputSchema)(input).pipe(
    Effect.mapError(({ issue }) =>
      AgentToolError.invalidInput(getFirstInvalidFieldPath(issue))
    ),
    Effect.flatMap(priceFundedBooking),
    Effect.map((quote) => ({
      ...toQuoteResult(quote),
      advertised_price_token: quote.pricing.advertised.advertisedPriceToken,
    }))
  );

const priceQuoteSelection = ({
  selection,
}: {
  readonly selection: QuoteSelection;
}) =>
  Effect.all(
    {
      advertised: buildAdvertisedPrice(selection.request),
      reservationUrl: getShareableReservationUrl(
        selection.reservationSelection
      ),
    },
    { concurrency: "unbounded" }
  ).pipe(Effect.mapError(AgentToolError.unavailable("quote_unavailable")));

const toQuoteResult = ({
  input,
  locale,
  now,
  pricing: { advertised, reservationUrl },
}: {
  readonly input: GetQuoteInput;
  readonly locale: ReturnType<typeof getAgentToolLocale>;
  readonly now: Temporal.Instant;
  readonly pricing: {
    readonly advertised: AdvertisedPrice;
    readonly reservationUrl: string;
  };
}): GetQuoteResult => {
  const { expectedPrice, undiscountedPrice } = advertised.quote.payment;

  return {
    family: input.family,
    total: toAgentToolMoney(expectedPrice),
    regular_price: toAgentToolMoney(undiscountedPrice),
    discount: toAgentToolMoney(
      getReservationQuoteDiscount(advertised.quote.payment)
    ),
    ...(advertised.kind === "table" && {
      lines: [
        {
          type: "table-base",
          seats: advertised.quote.items[0].seats,
          amount: toAgentToolMoney(advertised.quote.items[0].amount),
        },
        {
          type: "table-usage",
          duration_minutes: advertised.quote.items[1].durationMinutes,
          amount: toAgentToolMoney(advertised.quote.items[1].amount),
        },
      ],
    }),
    quoted_at: now.toString(),
    note: m.agentToolQuoteNote({}, { locale }),
    reservation_url: reservationUrl,
  };
};
