import { Effect } from "effect";
import type { CheckoutSummaryChangedKeys } from "@/features/checkout/checkout-summary";
import { getCoworkCheckoutSummary } from "@/features/checkout/checkout-summary-cowork";
import { getWorkspaceProductByTier } from "@/features/checkout/product-catalog";
import {
  buildCoworkReservationQuote,
  type CoworkEntryPackFunding,
  type CoworkReservationQuote,
} from "@/features/checkout/reservation-quote-cowork";
import type {
  DiscountAffirmationUnavailableError,
  DiscountQuote,
  DiscountResolutionError,
} from "@/features/discounts";
import { makeDiscountCommitment } from "@/features/discounts/commitment";
import { PromotionCodeUnavailableError } from "@/features/discounts/errors";
import type { Locale } from "@/features/i18n";
import {
  type CoworkAdvertisedPriceDetails,
  type CoworkAdvertisedPriceReservation,
  type CoworkReservationDetails,
  coworkAdvertisedPriceReservationEquals,
  getCoworkAdvertisedPriceReservation,
  type NormalizedCoworkReservationOrder,
} from "@/features/reservation/cowork-reservation";
import { type MoneyUnitMismatch, moneyEquals } from "@/shared/money/money";
import {
  AdvertisedPriceMismatchError,
  requireAdvertisedPriceStateKind,
} from "./advertised-price-mismatch";
import { openSubmittedAdvertisedPriceState } from "./advertised-price-state";
import {
  getPaymentPriceVerdict,
  type ReservationAdvertisementAffirmation,
  type ReservationAdvertisementAffirmationInput,
  type ReservationAdvertisementQuote,
  type ReservationAdvertisementQuoteInput,
  type ReservationCustomerQuoteInput,
  type ReservationDiscountCodeClearInput,
  type ReservationDiscountCodeClearResult,
  type ReservationDiscountCodePriceInput,
  type ReservationDiscountCodeVerdict,
  type ReservationPaymentPriceAffirmation,
  type ReservationPaymentPriceAffirmationInput,
  type ReservationPaymentRepricingInput,
  type ReservationPreparedCustomerQuote,
  reservationCheckoutPricing,
} from "./reservation-checkout-pricing";

export type CoworkCheckoutPricingError =
  | MoneyUnitMismatch
  | DiscountResolutionError
  | DiscountAffirmationUnavailableError;

export type CoworkAdvertisementQuoteInput =
  ReservationAdvertisementQuoteInput<CoworkAdvertisedPriceReservation>;

export type CoworkAdvertisementAffirmationInput =
  ReservationAdvertisementAffirmationInput<
    CoworkAdvertisedPriceReservation,
    NormalizedCoworkReservationOrder,
    CoworkReservationQuote
  >;

export type CoworkCustomerQuoteInput = ReservationCustomerQuoteInput<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

export type CoworkPaymentPriceAffirmationInput =
  ReservationPaymentPriceAffirmationInput<
    NormalizedCoworkReservationOrder,
    CoworkReservationQuote
  >;

export type CoworkPaymentRepricingInput = ReservationPaymentRepricingInput<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

export type CoworkDiscountCodePriceInput = ReservationDiscountCodePriceInput<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

export type CoworkDiscountCodeClearInput = ReservationDiscountCodeClearInput<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

export type CoworkDiscountCodeClearResult = ReservationDiscountCodeClearResult<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

export type CoworkAdvertisementQuote = ReservationAdvertisementQuote<
  CoworkAdvertisedPriceReservation,
  CoworkReservationQuote
>;

export type CoworkAdvertisementAffirmation =
  ReservationAdvertisementAffirmation<
    NormalizedCoworkReservationOrder,
    CoworkReservationQuote
  >;

export type CoworkCustomerQuote = ReservationPreparedCustomerQuote<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

export type CoworkPaymentPriceAffirmation = ReservationPaymentPriceAffirmation<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

export type CoworkDiscountCodeVerdict = ReservationDiscountCodeVerdict<
  NormalizedCoworkReservationOrder,
  CoworkReservationQuote
>;

const getCoworkPricingContext = Effect.fn(
  "CoworkCheckoutPricing.getPricingContext"
)((reservation: CoworkPricingSelection) => {
  const product = getWorkspaceProductByTier(reservation.entryTier);

  return Effect.succeed({
    reservation,
    discountInput: {
      product: { kind: "cowork" as const, tier: reservation.entryTier },
      discountableSubtotal: product.price,
      firstServiceDate: reservation.date,
      lastServiceDate: reservation.date,
    },
  });
});

/**
 * PII-free cowork selection that pricing accepts: advertised-price inputs or
 * the reservation domain's details projection. A full order satisfies it
 * structurally through `CoworkReservationDetails`, so the pricing selection
 * concept never names customer identity.
 */
type CoworkPricingSelection =
  | CoworkAdvertisedPriceDetails
  | CoworkReservationDetails;

type CoworkPricingContext = Effect.Success<
  ReturnType<typeof getCoworkPricingContext>
>;

const buildCoworkQuote = Effect.fn("CoworkCheckoutPricing.buildQuote")(
  (input: {
    readonly pricing: CoworkPricingContext;
    readonly discountQuote: DiscountQuote;
  }) =>
    buildCoworkReservationQuote(input.pricing.reservation, {
      discountQuote: input.discountQuote,
    })
);
const coworkPricingWithDiscounts = reservationCheckoutPricing<
  CoworkPricingSelection,
  CoworkAdvertisedPriceReservation,
  NormalizedCoworkReservationOrder,
  CoworkPricingContext,
  CoworkReservationQuote,
  never,
  MoneyUnitMismatch
>({
  advertised: {
    project: getCoworkAdvertisedPriceReservation,
    equals: coworkAdvertisedPriceReservationEquals,
  },
  getPricingContext: getCoworkPricingContext,
  buildQuote: buildCoworkQuote,
  getCheckoutSummary: ({ quote, reservation }) =>
    getCoworkCheckoutSummary(reservation, quote),
});

type CoworkEntryPackQuoteInput = {
  readonly reservation: NormalizedCoworkReservationOrder;
  readonly entryPack: CoworkEntryPackFunding;
};

/** Quotes a cowork reservation whose Entry pack funding was validated by booking. */
export const quoteCoworkEntryPack = Effect.fn("quoteCoworkEntryPack")(
  function* (
    input: CoworkEntryPackQuoteInput
  ): Effect.fn.Return<CoworkCustomerQuote, MoneyUnitMismatch> {
    const { reservation, entryPack } = input;
    const quote = yield* buildCoworkReservationQuote(reservation, {
      entryPack,
    });
    return { kind: reservation.kind, reservation, quote };
  }
);

/** Compares only the add-on that the Entry pack leaves payable to the customer. */
export const quoteCoworkEntryPackForContinue = Effect.fn(
  "quoteCoworkEntryPackForContinue"
)(function* (
  input: CoworkEntryPackQuoteInput & {
    readonly advertisedPriceToken?: string;
    readonly locale: Locale;
  }
) {
  const priced = yield* quoteCoworkEntryPack(input);
  const addon = priced.quote.items[1];
  if (
    addon === undefined ||
    input.entryPack.tier === "reserved-desk-workstation" ||
    input.advertisedPriceToken === undefined
  ) {
    return { ...priced, changedKeys: undefined };
  }

  const advertisement = yield* openSubmittedAdvertisedPriceState(
    input.advertisedPriceToken
  ).pipe(
    Effect.flatMap(requireAdvertisedPriceStateKind("cowork")),
    Effect.filterOrFail(
      (state) =>
        state.locale === input.locale &&
        coworkAdvertisedPriceReservationEquals(
          state.reservation,
          getCoworkAdvertisedPriceReservation(priced.reservation)
        ),
      AdvertisedPriceMismatchError.inputMismatch
    )
  );
  const previousAddon = advertisement.quote.items[1];
  const changedKeys: CheckoutSummaryChangedKeys | undefined =
    previousAddon?.type === addon.type &&
    moneyEquals(previousAddon.amount, addon.amount)
      ? undefined
      : {
          sectionKeys: ["order", "total"],
          itemKeys: [`addon:${addon.type}`, "total:final"],
        };
  return { ...priced, changedKeys };
});

const repriceCoworkEntryPack = Effect.fn("repriceCoworkEntryPack")(function* (
  input: CoworkEntryPackQuoteInput
): Effect.fn.Return<CoworkPaymentPriceAffirmation, MoneyUnitMismatch> {
  const priced = yield* quoteCoworkEntryPack(input);
  const { reservation, quote } = priced;
  return {
    ...priced,
    commitment: makeDiscountCommitment({
      product: { kind: reservation.kind, tier: reservation.entryTier },
      firstServiceDate: reservation.date,
      applications: [],
    }),
    summary: getCoworkCheckoutSummary(reservation, quote),
  };
});

const entryPackCodeUnavailable = () =>
  new PromotionCodeUnavailableError({
    reason: "product_ineligible",
    message: "An Entry pack booking cannot use a promotion code.",
  });

export const coworkCheckoutPricing = coworkPricingWithDiscounts.pipe(
  Effect.map((pricing) => ({
    ...pricing,
    repriceForPayment: (input: CoworkPaymentRepricingInput) => {
      const { entryPack } = input.quote;
      return entryPack
        ? repriceCoworkEntryPack({ reservation: input.reservation, entryPack })
        : pricing.repriceForPayment(input);
    },
    affirmForPayment: (input: CoworkPaymentPriceAffirmationInput) => {
      const { reservation, quote, acceptedTotal } = input;
      const { entryPack } = quote;
      if (!entryPack) return pricing.affirmForPayment(input);

      return repriceCoworkEntryPack({ reservation, entryPack }).pipe(
        Effect.map((priced) =>
          getPaymentPriceVerdict({
            signed: {
              quote,
              summary: getCoworkCheckoutSummary(reservation, quote),
              acceptedTotal,
            },
            priced,
          })
        )
      );
    },
    applyDiscountCode: (input: CoworkDiscountCodePriceInput) =>
      input.quote.entryPack
        ? Effect.fail(entryPackCodeUnavailable())
        : pricing.applyDiscountCode(input),
    clearDiscountCode: (input: CoworkDiscountCodeClearInput) =>
      input.quote.entryPack
        ? Effect.fail(entryPackCodeUnavailable())
        : pricing.clearDiscountCode(input),
  }))
);
