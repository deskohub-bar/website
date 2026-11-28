import { Schema, Struct } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import { CustomerAccountLinkRequired, Money } from "./customer-account-api";
import {
  CustomerAdvertisedPrice,
  CustomerBookableDates,
  CustomerBookingQuote,
  customerAvailabilityReplacementHeader,
} from "./customer-booking-catalog-api";
import {
  CreateCustomerCheckout,
  CustomerCheckoutDetailsInvalid,
  CustomerCheckoutStart,
  CustomerQuoteExpired,
  RememberedReferralHeaders,
} from "./customer-booking-checkout-api";
import {
  CustomerBookingDateOutOfRange,
  CustomerBookingSelectionInvalid,
  CustomerPlainDate,
  CustomerSelectionUnavailable,
} from "./customer-booking-selection";
import { CustomerLocale } from "./customer-locale";
import { customerInputParseOptions } from "./customer-profile";
import {
  CustomerOrderState,
  CustomerReservationNotFound,
  CustomerReservationOrderId,
} from "./customer-reservations-api";
import { CustomerServiceUnavailable } from "./customer-session";
import {
  CustomerTeamTableProduct,
  CustomerTeamTableSeats,
  CustomerTeamTableSelection,
  CustomerTeamTableTime,
} from "./customer-team-table-selection";

export class CustomerTeamTableUnavailable extends Schema.TaggedError<CustomerTeamTableUnavailable>()(
  "CustomerTeamTableUnavailable",
  {}
) {
  static schema = this.pipe(HttpApiSchema.status("NotFound"));
}

const seatsFromQuery = Schema.FiniteFromString.pipe(
  Schema.decodeTo(CustomerTeamTableSeats)
);

export const CustomerTeamTableOfferings = Schema.Struct({
  advertisedOn: CustomerPlainDate,
  bookableDates: CustomerBookableDates,
  /** One reference-duration price per configured table size. */
  offerings: Schema.Array(
    Schema.Struct({
      product: CustomerTeamTableProduct,
      name: Schema.String,
      price: Money,
      advertisedPrice: CustomerAdvertisedPrice,
    })
  ),
}).annotate({ identifier: "CustomerTeamTableOfferings" });
export type CustomerTeamTableOfferings = typeof CustomerTeamTableOfferings.Type;

export const CustomerTeamTableCalendar = Schema.Struct({
  from: CustomerPlainDate,
  to: CustomerPlainDate,
  seats: CustomerTeamTableSeats,
  unavailableDates: Schema.Array(CustomerPlainDate),
}).annotate({ identifier: "CustomerTeamTableCalendar" });
export type CustomerTeamTableCalendar = typeof CustomerTeamTableCalendar.Type;

export const CustomerTeamTableSlots = Schema.Struct({
  date: CustomerPlainDate,
  seats: CustomerTeamTableSeats,
  slotMinutes: Schema.Literal(15),
  usableFrom: CustomerTeamTableTime,
  /** The local cutoff, if the service date has one. */
  usableUntil: Schema.NullOr(CustomerTeamTableTime),
  availableStarts: Schema.Array(CustomerTeamTableTime),
  availableEndsByStart: Schema.Array(
    Schema.Struct({
      startTime: CustomerTeamTableTime,
      endTimes: Schema.Array(CustomerTeamTableTime),
    })
  ),
}).annotate({ identifier: "CustomerTeamTableSlots" });
export type CustomerTeamTableSlots = typeof CustomerTeamTableSlots.Type;

export const CustomerTeamTableQuote = Schema.Struct({
  ...CustomerBookingQuote.fields,
  family: Schema.Literal("table"),
  product: CustomerTeamTableProduct,
}).annotate({ identifier: "CustomerTeamTableQuote" });
export type CustomerTeamTableQuote = typeof CustomerTeamTableQuote.Type;

export const CreateCustomerTeamTableCheckout = Schema.Struct({
  ...Struct.omit(CreateCustomerCheckout.fields, ["earlySetup"]),
  selection: CustomerTeamTableSelection,
}).annotate({ identifier: "CreateCustomerTeamTableCheckout" });
export type CreateCustomerTeamTableCheckout =
  typeof CreateCustomerTeamTableCheckout.Type;

export const CustomerTeamTableStatus = Schema.Struct({
  ...Struct.omit(CustomerOrderState.fields, ["bookedSelection"]),
  kind: Schema.Literal("table"),
  product: Schema.optionalKey(CustomerTeamTableProduct),
  tableName: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CustomerTeamTableStatus" });
export type CustomerTeamTableStatus = typeof CustomerTeamTableStatus.Type;

export const CustomerTeamTableInvitationRejectionReason = Schema.Literals([
  "not-confirmed",
  "ended",
  "invalid-email",
  "duplicate",
  "capacity",
]);

export class CustomerTeamTableInvitationRejected extends Schema.TaggedError<CustomerTeamTableInvitationRejected>()(
  "CustomerTeamTableInvitationRejected",
  { reason: CustomerTeamTableInvitationRejectionReason }
) {
  static schema = this.pipe(HttpApiSchema.status("Conflict"));
}

const bookingErrors = [
  CustomerTeamTableUnavailable.schema,
  CustomerBookingSelectionInvalid.schema,
  CustomerBookingDateOutOfRange.schema,
  CustomerServiceUnavailable.schema,
] as const;

const orderErrors = [
  CustomerReservationNotFound.schema,
  CustomerServiceUnavailable.schema,
] as const;

const replacementHeaders = Schema.Struct({
  [customerAvailabilityReplacementHeader]: Schema.optionalKey(Schema.String),
});

const orderParams = { orderId: CustomerReservationOrderId };

/** Team Table endpoints that clients can adopt independently of legacy booking. */
export const CustomerTeamTableApi = HttpApiGroup.make("teamTable").add(
  HttpApiEndpoint.get("listOfferings", "/booking/team-table/offerings", {
    query: Schema.Struct({ locale: CustomerLocale }),
    success: CustomerTeamTableOfferings,
    error: CustomerServiceUnavailable.schema,
  }),
  HttpApiEndpoint.get("getAvailability", "/booking/team-table/availability", {
    query: Schema.Struct({
      seats: seatsFromQuery,
      from: Schema.optionalKey(CustomerPlainDate),
      to: Schema.optionalKey(CustomerPlainDate),
    }),
    headers: replacementHeaders,
    success: CustomerTeamTableCalendar,
    error: bookingErrors,
  }),
  HttpApiEndpoint.get("getSlots", "/booking/team-table/slots", {
    query: Schema.Struct({ date: CustomerPlainDate, seats: seatsFromQuery }),
    headers: replacementHeaders,
    success: CustomerTeamTableSlots,
    error: bookingErrors,
  }),
  HttpApiEndpoint.get("getQuote", "/booking/team-table/quote", {
    query: Schema.Struct({
      ...Struct.omit(CustomerTeamTableSelection.fields, ["family"]),
      seats: seatsFromQuery,
      locale: CustomerLocale,
    }),
    success: CustomerTeamTableQuote,
    error: [...bookingErrors, CustomerSelectionUnavailable.schema],
  }),
  HttpApiEndpoint.post("createCheckout", "/booking/team-table/checkouts", {
    payload: CreateCustomerTeamTableCheckout,
    headers: RememberedReferralHeaders,
    success: CustomerCheckoutStart,
    error: [
      ...bookingErrors,
      CustomerCheckoutDetailsInvalid.schema,
      CustomerSelectionUnavailable.schema,
      CustomerQuoteExpired.schema,
      CustomerAccountLinkRequired.schema,
    ],
  }).annotate(HttpApi.PayloadParseOptions, customerInputParseOptions),
  HttpApiEndpoint.get("getStatus", "/reservations/:orderId/team-table/status", {
    params: orderParams,
    success: CustomerTeamTableStatus,
    error: orderErrors,
  }),
  HttpApiEndpoint.post("addInvitees", "/reservations/:orderId/invitations", {
    params: orderParams,
    payload: Schema.Struct({
      locale: CustomerLocale,
      emails: Schema.Array(Schema.String.check(Schema.isMaxLength(255))).check(
        Schema.isMinLength(1)
      ),
    }),
    success: Schema.Struct({ added: Schema.Int }),
    error: [...orderErrors, CustomerTeamTableInvitationRejected.schema],
  }).annotate(HttpApi.PayloadParseOptions, customerInputParseOptions)
);
