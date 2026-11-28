import "server-only";

import { Effect, Schema } from "effect";
import { customerPassesAgentScope } from "@/features/account/agent-scopes";
import type { Locale } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import type { QuoteSelection } from "@/features/reservation/backend/booking-selection";
import { buildEntryPackBookingQuote } from "@/features/reservation/backend/entry-pack-booking";
import { getShareableReservationUrl } from "@/features/reservation/backend/shareable-reservation-url";
import { toClosedStandardJSONSchemaV1 } from "@/shared/utils/closed-json-schema";
import { type AgentTool, hasAgentToolArgument } from "./agent-tool";
import { AgentToolError } from "./agent-tool-error";

export const passFundingScope = {
  argument: "pass_id",
  scope: customerPassesAgentScope,
} as const;

export const passFundingField = Schema.optionalKey(
  orderIdSchema.annotate({
    description:
      "Cowork only: the ID of the customer's entry pack from list_passes. Requires the customer's permission to use passes. Leave it out for an ordinary quote or booking.",
  })
);

/** Publish the ordinary input while the rollout is closed, and reject a stale funded call. */
export const withoutPassFunding = <R>(
  { scopeWhenArgument: _scope, call, ...tool }: AgentTool<R>,
  input?: Schema.Constraint
): AgentTool<R> => ({
  ...tool,
  input: input ? toClosedStandardJSONSchemaV1(input) : tool.input,
  call: (args, caller) =>
    hasAgentToolArgument(args, passFundingScope.argument)
      ? Effect.fail(AgentToolError.serviceUnavailable())
      : call(args, caller),
});

export const requireAgentPassesOpen = CoworkPassesReleaseGate.isOpen.pipe(
  Effect.filterOrFail(Boolean, AgentToolError.serviceUnavailable)
);

export const quoteWithEntryPack = ({
  selection,
  locale,
  passId,
}: {
  readonly selection: QuoteSelection;
  readonly locale: Locale;
  readonly passId: OrderId;
}) =>
  buildEntryPackBookingQuote({
    reservation: selection.reservation,
    passId,
    locale,
  }).pipe(Effect.mapError(AgentToolError.passesUnavailable));

export const getFundedReservationUrl = (
  selection: QuoteSelection,
  passId: OrderId
) =>
  getShareableReservationUrl(selection.reservationSelection).pipe(
    Effect.mapError(AgentToolError.unavailable("quote_unavailable")),
    Effect.map((address) => {
      const url = new URL(address);
      url.searchParams.set("pass", passId);
      return url.href;
    })
  );
