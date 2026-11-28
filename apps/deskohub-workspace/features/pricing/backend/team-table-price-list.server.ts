import "server-only";

import { Effect } from "effect";
import { workspaceStatementConcurrency } from "@/db/database.service";
import { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import { getPublicOfferingAdvertisedPrice } from "@/features/checkout/public-offerings";
import {
  getTableBaseAmount,
  getTableUsageAmount,
} from "@/features/checkout/table-product-catalog";
import type { Locale } from "@/features/i18n";
import { pagePreloadDeadline } from "@/features/reservation/backend/page-preload";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { getTableAdvertisedPriceReservation } from "@/features/reservation/table-reservation";
import { getTableReservationInterval } from "@/features/reservation/table-reservation-time";
import { loadAdvisoryTeamTableSeatCapacities } from "@/features/team-table/backend/team-table-advisory-capacity";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import { catchRecoverableCause } from "@/shared/backend/workspace-effect";
import { currentInstant } from "@/shared/utils/temporal";
import type { TeamTablePrice } from "../team-table-price";

type TeamTablePriceList = {
  readonly prices: ReadonlyArray<TeamTablePrice>;
  readonly complete: boolean;
};

const advertiseOneHour = Effect.fn("pricing.advertiseTeamTableHour")(function* (
  regular: TeamTablePrice,
  date: Temporal.PlainDate,
  locale: Locale
) {
  const interval = yield* Effect.fromNullishOr(
    getTableReservationInterval(date.toString(), "09:00", "10:00")
  );
  const pricing = yield* CheckoutPricingService;
  const { quote, discountsComplete } = yield* pricing.quoteAdvertisement({
    reservation: getTableAdvertisedPriceReservation({
      kind: "table",
      seats: regular.seats,
      ...interval,
    }),
    locale,
  });

  return {
    price: {
      ...regular,
      advertisedPrice: getPublicOfferingAdvertisedPrice(quote.payment),
    },
    complete: discountsComplete,
  };
});

/** The catalog rates of the currently configured sizes and today's public sale. */
export const loadTeamTablePriceList = Effect.fn(
  "pricing.loadTeamTablePriceList"
)(function* (locale: Locale) {
  if (!(yield* TeamTableReleaseGate.isOpen)) {
    return { prices: [], complete: true } satisfies TeamTablePriceList;
  }

  const sizes = yield* loadAdvisoryTeamTableSeatCapacities.pipe(
    Effect.timeout(pagePreloadDeadline),
    catchRecoverableCause((cause) =>
      Effect.logWarning("Team Table price list sizes are unavailable", {
        cause,
      }).pipe(Effect.as(null))
    )
  );
  if (sizes === null) {
    return { prices: [], complete: false } satisfies TeamTablePriceList;
  }

  const date = yield* currentInstant.pipe(Effect.map(getCurrentWorkspaceDate));
  const concurrency = yield* workspaceStatementConcurrency;
  const advertised = yield* Effect.forEach(
    sizes,
    (seats) => {
      const regular = {
        seats,
        base: getTableBaseAmount(seats),
        hourly: getTableUsageAmount(seats, 60),
      };
      return advertiseOneHour(regular, date, locale).pipe(
        Effect.timeout(pagePreloadDeadline),
        catchRecoverableCause((cause) =>
          Effect.logWarning("Team Table sale price is unavailable", {
            cause,
            seats,
          }).pipe(Effect.as({ price: regular, complete: false }))
        )
      );
    },
    { concurrency }
  );

  return {
    prices: advertised.map(({ price }) => price),
    complete: advertised.every(({ complete }) => complete),
  } satisfies TeamTablePriceList;
});
