import { Effect } from "effect";
import { getTableCheckoutSummary } from "@/features/checkout/checkout-summary-table";
import {
  buildTableReservationQuote,
  getTableReservationQuote,
  type TableReservationQuote,
} from "@/features/checkout/reservation-quote-table";
import type {
  DiscountAffirmationUnavailableError,
  DiscountQuote,
  DiscountResolutionError,
} from "@/features/discounts";
import { getTouchedWorkspaceDateBounds } from "@/features/reservation/reservation-date";
import {
  getTableAdvertisedPriceReservation,
  getTableReservationProductIdentity,
  type NormalizedTableReservationOrder,
  type TableAdvertisedPriceReservation,
  type TableReservationDetails,
  tableAdvertisedPriceReservationEquals,
} from "@/features/reservation/table-reservation";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
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

export type TableCheckoutPricingError =
  | DiscountResolutionError
  | DiscountAffirmationUnavailableError;
export type TableAdvertisementQuoteInput =
  ReservationAdvertisementQuoteInput<TableAdvertisedPriceReservation>;
export type TableAdvertisementAffirmationInput =
  ReservationAdvertisementAffirmationInput<
    TableAdvertisedPriceReservation,
    NormalizedTableReservationOrder,
    TableReservationQuote
  >;
export type TableCustomerQuoteInput = ReservationCustomerQuoteInput<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;
export type TablePaymentPriceAffirmationInput =
  ReservationPaymentPriceAffirmationInput<
    NormalizedTableReservationOrder,
    TableReservationQuote
  >;

export type TablePaymentRepricingInput = ReservationPaymentRepricingInput<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;
export type TableDiscountCodePriceInput = ReservationDiscountCodePriceInput<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;

export type TableDiscountCodeClearInput = ReservationDiscountCodeClearInput<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;

export type TableDiscountCodeClearResult = ReservationDiscountCodeClearResult<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;
export type TableAdvertisementQuote = ReservationAdvertisementQuote<
  TableAdvertisedPriceReservation,
  TableReservationQuote
>;
export type TableAdvertisementAffirmation = ReservationAdvertisementAffirmation<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;
export type TableCustomerQuote = ReservationPreparedCustomerQuote<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;
export type TablePaymentPriceAffirmation = ReservationPaymentPriceAffirmation<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;
export type TableDiscountCodeVerdict = ReservationDiscountCodeVerdict<
  NormalizedTableReservationOrder,
  TableReservationQuote
>;

const getTablePricingContext = Effect.fn(
  "TableCheckoutPricing.getPricingContext"
)(function* (reservation: TableReservationDetails) {
  const undiscountedQuote = yield* getTableReservationQuote(reservation);
  const { first, last } = getTouchedWorkspaceDateBounds({
    startsAt: Temporal.Instant.from(reservation.startsAt),
    endsAt: Temporal.Instant.from(reservation.endsAt),
  });

  return {
    reservation,
    discountInput: {
      product: getTableReservationProductIdentity(reservation),
      discountableSubtotal: undiscountedQuote.payment.undiscountedPrice,
      firstServiceDate: plainDateStringSchema.make(first.toString()),
      lastServiceDate: plainDateStringSchema.make(last.toString()),
    },
  };
});

type TablePricingContext = Effect.Success<
  ReturnType<typeof getTablePricingContext>
>;

const buildTableQuote = Effect.fn("TableCheckoutPricing.buildQuote")(
  (input: {
    readonly pricing: TablePricingContext;
    readonly discountQuote: DiscountQuote;
  }) =>
    buildTableReservationQuote(input.pricing.reservation, {
      discountQuote: input.discountQuote,
    })
);

export const tableCheckoutPricing = reservationCheckoutPricing<
  TableReservationDetails,
  TableAdvertisedPriceReservation,
  NormalizedTableReservationOrder,
  TablePricingContext,
  TableReservationQuote,
  never,
  never
>({
  advertised: {
    project: getTableAdvertisedPriceReservation,
    equals: tableAdvertisedPriceReservationEquals,
  },
  getPricingContext: getTablePricingContext,
  buildQuote: buildTableQuote,
  getCheckoutSummary: ({ quote }) => getTableCheckoutSummary(quote),
});
