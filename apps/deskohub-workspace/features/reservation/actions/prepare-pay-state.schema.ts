import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Schema } from "effect";
import { checkoutSummarySchema } from "@/features/checkout/checkout-summary";
import { defaultPhoneRegion, type Locale, locales } from "@/features/i18n";
import { officePeopleSchema } from "@/features/office/office-people";
import { orderIdSchema } from "@/features/order";
import { reservationOrderIssuanceSchema } from "@/features/reservation/reservation-order";
import {
  marketingConsentSourceRequiresConsent,
  preparePayStateCommonSchema,
} from "./prepare-pay-state-common.schema";

/**
 * One reservation submission the booking operation prepares Pay for. Its
 * phone is read in the default region of the submission's own `locale`, the
 * locale the form validated it in and every later parse reads it with, so
 * validation and parsing can't use different regions. A form left open after
 * the visitor's language changes elsewhere still submits in its own locale.
 */
const reservationSubmissionFields = (locale: Locale) => ({
  ...preparePayStateCommonSchema.fields,
  locale: Schema.Literal(locale),
  reservation: reservationOrderIssuanceSchema(defaultPhoneRegion(locale)),
  /**
   * Who is coming to an Office or Team Table, beside the reservation so the
   * signed Pay state never carries an invitee's address. A submission
   * without it books the selected seats with no invitations.
   */
  people: Schema.optionalKey(officePeopleSchema),
  entryPackId: Schema.optionalKey(orderIdSchema),
  // A Pay edit's displayed price is only a baseline for review.
  // The current advertisement still proves the price to recheck.
  displayedOfficePrice: Schema.optionalKey(checkoutSummarySchema),
});

export const preparePayStateInputSchema = Schema.Union(
  locales.map((locale) => Schema.Struct(reservationSubmissionFields(locale)))
).check(marketingConsentSourceRequiresConsent);

export const preparePayStateSchema = Schema.toStandardSchemaV1(
  Schema.Union(
    locales.map((locale) =>
      Schema.Struct({
        ...reservationSubmissionFields(locale),
        siteToolEntryPackQuote: Schema.optionalKey(Schema.Literal(true)),
      })
    )
  ).check(marketingConsentSourceRequiresConsent),
  { parseOptions: { onExcessProperty: "error" } }
);

export type PreparePayStateInput = StandardSchemaV1.InferOutput<
  typeof preparePayStateSchema
>;
