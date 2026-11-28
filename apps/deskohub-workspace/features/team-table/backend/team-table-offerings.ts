import "server-only";

import { Effect } from "effect";
import { workspaceStatementConcurrency } from "@/db/database.service";
import { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import { getWorkspaceTableProductTitle } from "@/features/checkout/product-catalog.i18n";
import { getPublicOfferingAdvertisedPrice } from "@/features/checkout/public-offerings";
import type { Locale } from "@/features/i18n";
import {
  getTableAdvertisedPriceReservation,
  getTableReservationProductIdentity,
} from "@/features/reservation/table-reservation";
import { getTableReservationInterval } from "@/features/reservation/table-reservation-time";
import { loadAdvisoryTeamTableSeatCapacities } from "./team-table-advisory-capacity";
import { TeamTableReleaseGate } from "./team-table-release-gate";

/** One one-hour advertised price per configured table size. */
export const loadTeamTableOfferings = Effect.fn("teamTable.loadOfferings")(
  function* ({
    advertisedOn,
    locale,
  }: {
    readonly advertisedOn: Temporal.PlainDate;
    readonly locale: Locale;
  }) {
    if (!(yield* TeamTableReleaseGate.isOpen)) return [];

    const interval = yield* Effect.fromNullishOr(
      getTableReservationInterval(advertisedOn.toString(), "09:00", "10:00")
    );
    const sizes = yield* loadAdvisoryTeamTableSeatCapacities;
    const pricing = yield* CheckoutPricingService;
    const concurrency = yield* workspaceStatementConcurrency;
    const name = getWorkspaceTableProductTitle(locale);

    return yield* Effect.forEach(
      sizes,
      (seats) => {
        const reservation = { kind: "table", seats, ...interval } as const;
        return pricing
          .quoteAdvertisement({
            reservation: getTableAdvertisedPriceReservation(reservation),
            locale,
          })
          .pipe(
            Effect.map(({ quote: { payment }, discountsComplete }) => ({
              product: getTableReservationProductIdentity(reservation),
              name,
              price: payment.undiscountedPrice,
              advertisedPrice: getPublicOfferingAdvertisedPrice(payment),
              discountsComplete,
            }))
          );
      },
      { concurrency }
    );
  }
);
