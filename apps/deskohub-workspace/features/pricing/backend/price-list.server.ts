import "server-only";

import { Effect, Layer, Option } from "effect";
import { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import { loadPublicPriceList } from "@/features/checkout/backend/checkout/public-offerings";
import {
  getPublicCatalogOfferings,
  type PublicPriceListOffering,
} from "@/features/checkout/public-offerings";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend";
import type { Locale } from "@/features/i18n";
import { OfficeReleaseGate } from "@/features/office/backend/office-release-gate";
import { ReferralReleaseGate } from "@/features/referrals/referral-release-gate";
import { SharedAvailabilityInventoryLive } from "@/features/reservation/backend/availability-inventory-cache.server";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import { readSharedSnapshot } from "@/shared/backend/shared-snapshot";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import type { TeamTablePrice } from "../team-table-price";
import { loadTeamTablePriceList } from "./team-table-price-list.server";

type PriceList = {
  readonly offerings: ReadonlyArray<PublicPriceListOffering>;
  readonly teamTablePrices: ReadonlyArray<TeamTablePrice>;
};

/** The price list every visitor gets, and whether a visitor's may differ. */
export type SharedPriceList = PriceList & {
  /**
   * True when a release gate the list reads is decided per visitor, or the
   * list is incomplete, so a visitor's own list may differ.
   */
  readonly variesByVisitor: boolean;
  /**
   * False when an advertised price fell back to the catalog, or the whole
   * list did, so its prices are right for now but not to keep.
   */
  readonly complete: boolean;
};

/**
 * The life of an incomplete list: revalidated on the next request after a
 * second, so a sale the provider answers again shows at once. Its `stale`
 * and `expire` stay at the five minutes that keep it in the route's App
 * Shell; anything shorter drops it from the shell the page prerenders.
 */
const incompletePriceListLife = { stale: 300, revalidate: 1, expire: 300 };

/**
 * The gates the shared list reads, each with its value when it is the same
 * for every visitor. A gate decided per visitor stays closed here.
 */
const decideSharedReleases = Effect.gen(function* () {
  const featureFlags = yield* WorkspaceFeatureFlagService;
  const [office, teamTable, calendarSales, customerDiscounts, discountCodes] =
    yield* Effect.all([
      featureFlags.constantValue("office_page"),
      featureFlags.constantValue("team_table_page"),
      featureFlags.constantValue("calendar_sales"),
      featureFlags.constantValue("customer_discounts"),
      featureFlags.constantValue("discount_codes"),
    ]);
  const decided = (gate: Option.Option<boolean>) =>
    Option.getOrElse(gate, () => false);

  return {
    officeOpen: decided(office),
    teamTableOpen: decided(teamTable),
    discountReleaseGates: {
      calendarSales: decided(calendarSales),
      customerDiscounts: decided(customerDiscounts),
      discountCodes: decided(discountCodes),
    },
    variesByVisitor: [
      office,
      teamTable,
      calendarSales,
      customerDiscounts,
      discountCodes,
    ].some(Option.isNone),
  };
}).pipe(Effect.provide(WorkspaceFeatureFlagService.Default));

// Referral discounts belong to a signed-in customer, never to an anonymous
// advertised price.
const withoutReferrals = Layer.provideMerge(
  ReferralReleaseGate.fromDecision(false)
);

const loadPriceList = (locale: Locale) =>
  Effect.all(
    {
      catalog: loadPublicPriceList(locale),
      tables: loadTeamTablePriceList(locale),
    },
    { concurrency: "unbounded" }
  ).pipe(
    Effect.map(({ catalog, tables }) => ({
      offerings: catalog.offerings,
      teamTablePrices: tables.prices,
      complete: catalog.complete && tables.complete,
    })),
    Effect.provide(SharedAvailabilityInventoryLive)
  );

const catalogFallback = (locale: Locale): PriceList => ({
  offerings: getPublicCatalogOfferings({ locale }),
  teamTablePrices: [],
});

const loadSharedOfferings = Effect.fn("pricing.loadSharedOfferings")(function* (
  locale: Locale
) {
  const { officeOpen, teamTableOpen, discountReleaseGates, variesByVisitor } =
    yield* decideSharedReleases;
  const priceList = yield* loadPriceList(locale).pipe(
    Effect.provide(
      Layer.mergeAll(
        CheckoutPricingService.withDiscountReleaseGates(
          discountReleaseGates
        ).pipe(withoutReferrals),
        OfficeReleaseGate.fromDecision(officeOpen),
        TeamTableReleaseGate.fromDecision(teamTableOpen)
      )
    )
  );
  return {
    ...priceList,
    variesByVisitor: variesByVisitor || !priceList.complete,
  } satisfies SharedPriceList;
});

/**
 * Every bookable product at its advertised price, read without the request
 * so the page prerenders it: agents that read only the visible static HTML
 * find every price. Advertised prices read only the anonymous Calendar
 * sales. Team Table reads configured capacities from the shared inventory.
 *
 * `minutes` keeps a complete list in the route's App Shell, which needs a
 * `stale` of at least five minutes, while it still revalidates every minute.
 * An incomplete list is never kept that long. A runtime that cannot start
 * shares the catalog prices without the office, as an incomplete list.
 */
export async function loadSharedPriceList(
  locale: Locale
): Promise<SharedPriceList> {
  "use cache";

  return await readSharedSnapshot(
    "pricing.shared-price-list.load",
    loadSharedOfferings(locale),
    {
      complete: { lifetime: "minutes" },
      incomplete: {
        when: (priceList) => !priceList.complete,
        lifetime: incompletePriceListLife,
      },
      failure: {
        failureCode: "pricing.shared_price_list.load_failed",
        fallback: (): SharedPriceList => ({
          ...catalogFallback(locale),
          variesByVisitor: true,
          complete: false,
        }),
        lifetime: incompletePriceListLife,
      },
    }
  );
}

const VisitorPriceListLive = Layer.mergeAll(
  CheckoutPricingService.Live.pipe(withoutReferrals),
  OfficeReleaseGate.Live,
  TeamTableReleaseGate.Live
);

/**
 * The visitor's own price list, under the request's release gates. A runtime
 * that cannot start still renders the catalog prices, without the office,
 * whose release gate is then unknown.
 */
export const loadVisitorPriceList = (locale: Locale): Promise<PriceList> =>
  loadPriceList(locale).pipe(
    Effect.provide(VisitorPriceListLive),
    runWorkspaceEffectOrElse("pricing.price-list.load", {
      failureCode: "pricing.price_list.load_failed",
      orElse: () => catalogFallback(locale),
    })
  );
