import {
  tableDurationMinutesSchema,
  tableSeatsSchema,
} from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Effect, Schema } from "effect";
import type { DiscountQuote } from "@/features/discounts/contracts";
import type { TableReservationDetails } from "@/features/reservation/table-reservation";
import { getTableReservationDurationMinutes } from "@/features/reservation/table-reservation-time";
import { currencyCZK } from "@/shared/money/currencies";
import { positiveMoneyCodec } from "@/shared/money/money";
import { getReservationQuoteFingerprint } from "./reservation-quote-fingerprint";
import { makeReservationQuoteSchema } from "./reservation-quote-schema";
import {
  getTableBaseAmount,
  getTableUsageAmount,
} from "./table-product-catalog";

const tableBaseQuoteItemSchema = Schema.Struct({
  type: Schema.Literal("table-base"),
  seats: tableSeatsSchema,
  amount: positiveMoneyCodec,
});

const tableUsageQuoteItemSchema = Schema.Struct({
  type: Schema.Literal("table-usage"),
  durationMinutes: tableDurationMinutesSchema,
  amount: positiveMoneyCodec,
});

export const tableReservationQuoteItemSchema = Schema.Union([
  tableBaseQuoteItemSchema,
  tableUsageQuoteItemSchema,
]);

export const tableReservationQuoteSchema = makeReservationQuoteSchema(
  Schema.Tuple([tableBaseQuoteItemSchema, tableUsageQuoteItemSchema])
);

export type TableReservationQuote = typeof tableReservationQuoteSchema.Type;

export const getTableReservationQuote = (
  reservation: TableReservationDetails,
  { discountQuote }: { readonly discountQuote?: DiscountQuote } = {}
) => {
  const { seats } = reservation;
  const durationMinutes = getTableReservationDurationMinutes(reservation);
  const baseAmount = getTableBaseAmount(seats);
  const usageAmount = getTableUsageAmount(seats, durationMinutes);
  const undiscountedPrice = currencyCZK(baseAmount.value + usageAmount.value);

  return Effect.succeed({
    items: [
      { type: "table-base", seats, amount: baseAmount },
      { type: "table-usage", durationMinutes, amount: usageAmount },
    ] as const,
    payment: {
      undiscountedPrice,
      expectedPrice: discountQuote?.discountedSubtotal ?? undiscountedPrice,
      discounts: discountQuote?.discounts ?? [],
    },
  });
};

export const buildTableReservationQuote = Effect.fn(
  "buildTableReservationQuote"
)(function* (
  reservation: TableReservationDetails,
  options: { readonly discountQuote?: DiscountQuote } = {}
) {
  const quote = yield* getTableReservationQuote(reservation, options);
  return {
    ...quote,
    fingerprint: getReservationQuoteFingerprint(reservation, quote),
  };
});
