import { Schema } from "effect";
import type { TableReservationQuote } from "@/features/checkout/reservation-quote-table";
import { tableReservationQuoteItemSchema } from "@/features/checkout/reservation-quote-table";
import { makeCheckoutDetailsSchema } from "@/features/checkout/schemas/checkout-details-base";
import type { Locale } from "@/features/i18n";
import {
  getTableReservationDetails,
  type TableReservationDetails,
  tableReservationDetailsSchema,
} from "@/features/reservation/table-reservation";

export const tableCheckoutDetailsSchema = makeCheckoutDetailsSchema({
  reservation: tableReservationDetailsSchema,
  paymentFields: {
    items: Schema.Array(tableReservationQuoteItemSchema),
  },
});

export type TableCheckoutDetails = typeof tableCheckoutDetailsSchema.Type;

export const getTableCheckoutDetails = (input: {
  readonly locale: Locale;
  readonly reservation: TableReservationDetails;
  readonly quote: TableReservationQuote;
  readonly legalEvidence: TableCheckoutDetails["legal"];
}): TableCheckoutDetails => ({
  locale: input.locale,
  reservation: getTableReservationDetails(input.reservation),
  payment: {
    expectedPrice: input.quote.payment.expectedPrice,
    undiscountedPrice: input.quote.payment.undiscountedPrice,
    discounts: input.quote.payment.discounts,
    items: input.quote.items,
  },
  legal: input.legalEvidence,
});
