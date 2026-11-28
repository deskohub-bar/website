import { Effect, Match } from "effect";
import type {
  AdvertisedPrice,
  AdvertisedPriceRequest,
} from "@/features/checkout/advertised-price";
import { getCoworkCheckoutSummary } from "@/features/checkout/checkout-summary-cowork";
import { getMeetingRoomCheckoutSummary } from "@/features/checkout/checkout-summary-meeting-room";
import { getOfficeCheckoutSummary } from "@/features/checkout/checkout-summary-office";
import { getTableCheckoutSummary } from "@/features/checkout/checkout-summary-table";
import { ensureOfficeReservationsEnabled } from "@/features/office/backend/office-release-gate";
import { ensureTeamTableReservationsEnabled } from "@/features/team-table/backend/team-table-release-gate";
import {
  buildAdvertisedPriceState,
  sealAdvertisedPriceState,
} from "./advertised-price-state";
import { CheckoutPricingService } from "./checkout-pricing.service";

export const buildAdvertisedPrice = Effect.fn("buildAdvertisedPrice")(
  function* (input: AdvertisedPriceRequest) {
    yield* Match.value(input.reservation).pipe(
      Match.discriminatorsExhaustive("kind")({
        cowork: () => Effect.void,
        "meeting-room": () => Effect.void,
        office: () => ensureOfficeReservationsEnabled,
        table: () => ensureTeamTableReservationsEnabled,
      })
    );

    const pricing = yield* CheckoutPricingService;
    const advertised = yield* pricing.quoteAdvertisement(input);
    const state = yield* buildAdvertisedPriceState({
      ...advertised,
      locale: input.locale,
      requestedDiscountCode: input.submittedCode,
    });
    const advertisedPriceToken = yield* sealAdvertisedPriceState(state);
    const summary = Match.value(advertised).pipe(
      Match.discriminatorsExhaustive("kind")({
        cowork: ({ quote, reservation }) =>
          getCoworkCheckoutSummary(reservation.details, quote),
        "meeting-room": ({ quote }) => getMeetingRoomCheckoutSummary(quote),
        office: ({ quote }) => getOfficeCheckoutSummary(quote),
        table: ({ quote }) => getTableCheckoutSummary(quote),
      })
    );

    return {
      ...advertised,
      summary,
      advertisedPriceToken,
    } satisfies AdvertisedPrice;
  }
);
