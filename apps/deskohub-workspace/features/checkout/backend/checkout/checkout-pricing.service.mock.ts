import { Effect, Layer, Match, Schema } from "effect";
import type { CheckoutSummary } from "@/features/checkout/checkout-summary";
import { coworkReservationQuoteSchema } from "@/features/checkout/reservation-quote-cowork";
import { meetingRoomReservationQuoteSchema } from "@/features/checkout/reservation-quote-meeting-room";
import { officeReservationQuoteSchema } from "@/features/checkout/reservation-quote-office";
import { tableReservationQuoteSchema } from "@/features/checkout/reservation-quote-table";
import {
  CheckoutPricingService,
  type CustomerQuoteInput,
  type ICheckoutPricingService,
  type PaymentPriceAffirmation,
  type PaymentRepricingInput,
  type PreparedCustomerQuote,
  reviewDisplayedOfficePrice,
} from "./checkout-pricing.service";
import { PayState } from "./pay-state";
import {
  getCustomerQuotePriceVerdict,
  getPaymentPriceVerdict,
  type ReservationPaymentPriceAffirmation,
} from "./reservation-checkout-pricing";

export const CheckoutPricingServiceMock = Layer.mock(CheckoutPricingService);

/** The error a pricing operation fails with. */
type PricingError = Effect.Error<
  ReturnType<ICheckoutPricingService["repriceForPayment"]>
>;

/** The re-priced quote and commitment a caller's test stub returns. */
export type RepricedPayment = Pick<
  PaymentPriceAffirmation,
  "quote" | "commitment"
>;

type ReservationQuote = PaymentRepricingInput["quote"];

const isCoworkQuote = Schema.is(coworkReservationQuoteSchema);
const isMeetingRoomQuote = Schema.is(meetingRoomReservationQuoteSchema);
const isOfficeQuote = Schema.is(officeReservationQuoteSchema);
const isTableQuote = Schema.is(tableReservationQuoteSchema);

/**
 * The quote a stub returned, when it is a quote of the family the input
 * names. A stub that answers with another family's quote is a broken test.
 */
const requireFamilyQuote = <Quote extends ReservationQuote>(
  isFamilyQuote: (quote: ReservationQuote) => quote is Quote,
  quote: ReservationQuote
) =>
  isFamilyQuote(quote)
    ? Effect.succeed(quote)
    : Effect.die(
        new Error("The pricing stub returned another family's quote.")
      );

/** One family's re-priced payment with the summary its quote shows. */
const pricedPayment = <
  Reservation extends PaymentRepricingInput["reservation"],
  Quote extends ReservationQuote,
>(
  reservation: Reservation,
  {
    quote,
    commitment,
  }: {
    readonly quote: Quote;
    readonly commitment: RepricedPayment["commitment"];
  },
  summary: CheckoutSummary
): ReservationPaymentPriceAffirmation<Reservation, Quote> => ({
  kind: reservation.kind,
  reservation,
  quote,
  commitment,
  summary,
});

/**
 * Payment pricing for a caller's test: `reprice` stands in for the discount
 * affirmation and returns the re-priced quote and commitment, and the
 * payment verdict comes from the real payment rule.
 */
export const paymentPricingFrom = <E extends PricingError>(
  reprice: (input: PaymentRepricingInput) => Effect.Effect<RepricedPayment, E>
): Pick<ICheckoutPricingService, "repriceForPayment" | "affirmForPayment"> => {
  const repriceForPayment = (
    input: PaymentRepricingInput
  ): Effect.Effect<PaymentPriceAffirmation, E> =>
    Match.value(input).pipe(
      Match.when({ reservation: { kind: "cowork" } }, (cowork) =>
        reprice(cowork).pipe(
          Effect.flatMap(({ quote, commitment }) =>
            requireFamilyQuote(isCoworkQuote, quote).pipe(
              Effect.map((familyQuote) =>
                pricedPayment(
                  cowork.reservation,
                  { quote: familyQuote, commitment },
                  PayState.summary({
                    reservation: cowork.reservation,
                    quote: familyQuote,
                  })
                )
              )
            )
          )
        )
      ),
      Match.when({ reservation: { kind: "meeting-room" } }, (meetingRoom) =>
        reprice(meetingRoom).pipe(
          Effect.flatMap(({ quote, commitment }) =>
            requireFamilyQuote(isMeetingRoomQuote, quote).pipe(
              Effect.map((familyQuote) =>
                pricedPayment(
                  meetingRoom.reservation,
                  { quote: familyQuote, commitment },
                  PayState.summary({
                    reservation: meetingRoom.reservation,
                    quote: familyQuote,
                  })
                )
              )
            )
          )
        )
      ),
      Match.when({ reservation: { kind: "office" } }, (office) =>
        reprice(office).pipe(
          Effect.flatMap(({ quote, commitment }) =>
            requireFamilyQuote(isOfficeQuote, quote).pipe(
              Effect.map((familyQuote) =>
                pricedPayment(
                  office.reservation,
                  { quote: familyQuote, commitment },
                  PayState.summary({
                    reservation: office.reservation,
                    quote: familyQuote,
                  })
                )
              )
            )
          )
        )
      ),
      Match.when({ reservation: { kind: "table" } }, (table) =>
        reprice(table).pipe(
          Effect.flatMap(({ quote, commitment }) =>
            requireFamilyQuote(isTableQuote, quote).pipe(
              Effect.map((familyQuote) =>
                pricedPayment(
                  table.reservation,
                  { quote: familyQuote, commitment },
                  PayState.summary({
                    reservation: table.reservation,
                    quote: familyQuote,
                  })
                )
              )
            )
          )
        )
      ),
      Match.exhaustive
    );
  return {
    repriceForPayment,
    affirmForPayment: (input) =>
      repriceForPayment(input).pipe(
        Effect.map((priced) =>
          getPaymentPriceVerdict({
            signed: {
              quote: input.quote,
              summary: PayState.summary(input),
              acceptedTotal: input.acceptedTotal,
            },
            priced,
          })
        )
      ),
  };
};

/**
 * The verdict on one family's customer quote: full validation keeps the
 * advertised query code, and the verdict comes from the real submission rule.
 */
const customerQuoteVerdict = (input: {
  readonly quoted: CustomerQuoteInput;
  readonly advertisedSummary: CheckoutSummary;
  readonly priced: PreparedCustomerQuote;
  readonly customerSummary: CheckoutSummary;
}) =>
  reviewDisplayedOfficePrice(
    getCustomerQuotePriceVerdict({
      advertised: {
        status: input.quoted.advertisement.status,
        summary: input.advertisedSummary,
      },
      customer: {
        priced: input.priced,
        summary: input.customerSummary,
        advertisedCodeChanged: false,
      },
    }),
    input.quoted.displayedOfficePrice
  );

/**
 * Customer quoting for a caller's test: `quote` stands in for the customer's
 * discounts and returns the customer quote, full validation keeps the
 * advertised query code, and the verdict comes from the real submission rule.
 */
export const customerQuotePricingFrom = <E extends PricingError>(
  quote: (
    input: CustomerQuoteInput
  ) => Effect.Effect<PreparedCustomerQuote["quote"], E>
): Pick<ICheckoutPricingService, "quoteForCustomer"> => ({
  quoteForCustomer: (input) =>
    Match.value(input.advertisement.priced).pipe(
      Match.discriminatorsExhaustive("kind")({
        cowork: (priced) =>
          quote(input).pipe(
            Effect.flatMap((customerQuote) =>
              requireFamilyQuote(isCoworkQuote, customerQuote)
            ),
            Effect.map((customerQuote) =>
              customerQuoteVerdict({
                quoted: input,
                advertisedSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: priced.advertisedQuote,
                }),
                priced: {
                  kind: priced.kind,
                  reservation: priced.reservation,
                  quote: customerQuote,
                },
                customerSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: customerQuote,
                }),
              })
            )
          ),
        "meeting-room": (priced) =>
          quote(input).pipe(
            Effect.flatMap((customerQuote) =>
              requireFamilyQuote(isMeetingRoomQuote, customerQuote)
            ),
            Effect.map((customerQuote) =>
              customerQuoteVerdict({
                quoted: input,
                advertisedSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: priced.advertisedQuote,
                }),
                priced: {
                  kind: priced.kind,
                  reservation: priced.reservation,
                  quote: customerQuote,
                },
                customerSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: customerQuote,
                }),
              })
            )
          ),
        office: (priced) =>
          quote(input).pipe(
            Effect.flatMap((customerQuote) =>
              requireFamilyQuote(isOfficeQuote, customerQuote)
            ),
            Effect.map((customerQuote) =>
              customerQuoteVerdict({
                quoted: input,
                advertisedSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: priced.advertisedQuote,
                }),
                priced: {
                  kind: priced.kind,
                  reservation: priced.reservation,
                  quote: customerQuote,
                },
                customerSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: customerQuote,
                }),
              })
            )
          ),
        table: (priced) =>
          quote(input).pipe(
            Effect.flatMap((customerQuote) =>
              requireFamilyQuote(isTableQuote, customerQuote)
            ),
            Effect.map((customerQuote) =>
              customerQuoteVerdict({
                quoted: input,
                advertisedSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: priced.advertisedQuote,
                }),
                priced: {
                  kind: priced.kind,
                  reservation: priced.reservation,
                  quote: customerQuote,
                },
                customerSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: customerQuote,
                }),
              })
            )
          ),
      })
    ),
});
