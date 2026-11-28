import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiSchema } from "effect/http-api";
import { CustomerAccountLinkRequired, Money } from "./customer-account-api";
import { CustomerLegalDocument } from "./customer-booking-catalog-api";
import {
  CustomerCheckoutBilling,
  CustomerCheckoutReturnTarget,
} from "./customer-booking-checkout-api";
import {
  CustomerMonitorOption,
  CustomerPlainDate,
} from "./customer-booking-selection";
import { CustomerLocale } from "./customer-locale";
import {
  CustomerEntryPackProduct,
  CustomerPassesUnavailable,
  CustomerPassId,
  CustomerPassNotFound,
  CustomerPassTier,
} from "./customer-pass-reads-api";
import {
  CustomerProfileInput,
  customerInputParseOptions,
} from "./customer-profile";
import {
  CustomerAccountId,
  CustomerServiceUnavailable,
} from "./customer-session";

const shortText = Schema.NonEmptyString.check(Schema.isMaxLength(255));

export const CustomerUnlimitedPassSelection = Schema.Union([
  Schema.Struct({
    tier: Schema.Literal("open-space"),
    startDate: CustomerPlainDate,
    coffee: Schema.Boolean,
  }),
  Schema.Struct({
    tier: Schema.Literal("reserved-desk"),
    startDate: CustomerPlainDate,
  }),
  Schema.Struct({
    tier: Schema.Literal("reserved-desk-workstation"),
    startDate: CustomerPlainDate,
    monitorOption: CustomerMonitorOption,
  }),
]).annotate({ identifier: "CustomerUnlimitedPassSelection" });
export type CustomerUnlimitedPassSelection =
  typeof CustomerUnlimitedPassSelection.Type;

export const CustomerPassPurchaseProduct = Schema.Union([
  CustomerEntryPackProduct,
  Schema.Struct({
    kind: Schema.Literal("unlimited"),
    selection: CustomerUnlimitedPassSelection,
  }),
]).annotate({ identifier: "CustomerPassPurchaseProduct" });
export type CustomerPassPurchaseProduct =
  typeof CustomerPassPurchaseProduct.Type;

export const BeginCustomerPassPurchase = Schema.Struct({
  /** The buyer keeps this ID across retries of the same purchase. */
  orderId: CustomerPassId,
  expectedBuyerAccountId: Schema.optionalKey(CustomerAccountId),
  locale: CustomerLocale,
  product: CustomerPassPurchaseProduct,
  holderEmail: Schema.optionalKey(shortText),
  recipientName: Schema.optionalKey(shortText),
  buyerProfile: Schema.optionalKey(CustomerProfileInput),
  supersedeOrderId: Schema.optionalKey(CustomerPassId),
}).annotate({ identifier: "BeginCustomerPassPurchase" });
export type BeginCustomerPassPurchase = typeof BeginCustomerPassPurchase.Type;

const priceFingerprint = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/)
);

export const CustomerPassPurchasePrice = Schema.Struct({
  fingerprint: priceFingerprint,
  subtotal: Money,
  total: Money,
  coffeePrice: Schema.optionalKey(Money),
  appliedDiscountCode: Schema.optionalKey(Schema.String),
  discounts: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, amount: Money })
  ),
}).annotate({ identifier: "CustomerPassPurchasePrice" });
export type CustomerPassPurchasePrice = typeof CustomerPassPurchasePrice.Type;

export const CustomerPassPurchaseDisclosure = Schema.Struct({
  documents: Schema.Array(CustomerLegalDocument),
  earlyStartRequest: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CustomerPassPurchaseDisclosure" });
export type CustomerPassPurchaseDisclosure =
  typeof CustomerPassPurchaseDisclosure.Type;

export const CustomerPassPurchase = Schema.Struct({
  orderId: CustomerPassId,
  product: CustomerPassPurchaseProduct,
  payPath: Schema.String,
  statusPath: Schema.String,
  price: CustomerPassPurchasePrice,
  validFrom: CustomerPlainDate,
  lastUsableDate: CustomerPlainDate,
  disclosure: CustomerPassPurchaseDisclosure,
}).annotate({ identifier: "CustomerPassPurchase" });
export type CustomerPassPurchase = typeof CustomerPassPurchase.Type;

export const SubmitCustomerPassPurchase = Schema.Struct({
  productKind: Schema.Literals(["entry-pack", "unlimited"]),
  accepted: Schema.Boolean,
  acceptedDocuments: Schema.Array(
    Schema.Struct({ key: Schema.String, hash: Schema.String })
  ).check(Schema.isMaxLength(2)),
  unlimitedEarlyStartAccepted: Schema.optionalKey(Schema.Boolean),
  displayedPriceFingerprint: priceFingerprint,
  billing: Schema.optionalKey(CustomerCheckoutBilling),
  priorPaymentAttemptId: Schema.optionalKey(Schema.NonEmptyString),
  returnTarget: Schema.optionalKey(CustomerCheckoutReturnTarget),
}).annotate({ identifier: "SubmitCustomerPassPurchase" });
export type SubmitCustomerPassPurchase = typeof SubmitCustomerPassPurchase.Type;

export const CustomerPassPayment = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("hosted"),
    statusUrl: Schema.String,
    redirectUrl: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literals(["paid", "pending"]),
    statusUrl: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("pricing_changed"),
    price: CustomerPassPurchasePrice,
  }),
  Schema.Struct({
    status: Schema.Literal("terms_changed"),
    disclosure: CustomerPassPurchaseDisclosure,
  }),
]).annotate({ identifier: "CustomerPassPayment" });
export type CustomerPassPayment = typeof CustomerPassPayment.Type;

export const UpdateCustomerPassPurchasePrice = Schema.Struct({
  productKind: Schema.Literals(["entry-pack", "unlimited"]),
  displayedPriceFingerprint: priceFingerprint,
  /** Omit the code to remove it from the unpaid quote. */
  submittedCode: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(160))
  ),
}).annotate({ identifier: "UpdateCustomerPassPurchasePrice" });
export type UpdateCustomerPassPurchasePrice =
  typeof UpdateCustomerPassPurchasePrice.Type;

export const CustomerPassPurchasePriceUpdate = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["ready", "pricing_changed"]),
    price: CustomerPassPurchasePrice,
  }),
  Schema.Struct({ status: Schema.Literal("code_unavailable") }),
]).annotate({ identifier: "CustomerPassPurchasePriceUpdate" });
export type CustomerPassPurchasePriceUpdate =
  typeof CustomerPassPurchasePriceUpdate.Type;

export const CustomerPassPurchaseState = Schema.Literals([
  "not_started",
  "pending",
  "checking",
  "paid",
  "cancelled",
  "expired",
  "failed",
  "refund_required",
  "refunded",
  "partially_refunded",
  "granted",
  "grant_cancelled",
]);

export const CustomerPassPurchaseStatus = Schema.Struct({
  orderId: CustomerPassId,
  status: CustomerPassPurchaseState,
  productKind: Schema.Literals(["entry-pack", "unlimited"]),
  tier: CustomerPassTier,
  statusPath: Schema.String,
  /** The same buyer's website Pay page for an unsubmitted order. */
  resumePath: Schema.optionalKey(Schema.String),
  /** The pending provider page when the current attempt can still be reopened. */
  paymentUrl: Schema.optionalKey(Schema.String),
  gift: Schema.optionalKey(Schema.Boolean),
  validFrom: Schema.optionalKey(CustomerPlainDate),
  lastUsableDate: Schema.optionalKey(CustomerPlainDate),
  retry: Schema.optionalKey(
    Schema.Struct({
      priorPaymentAttemptId: Schema.NonEmptyString,
      price: CustomerPassPurchasePrice,
      disclosure: CustomerPassPurchaseDisclosure,
    })
  ),
}).annotate({ identifier: "CustomerPassPurchaseStatus" });
export type CustomerPassPurchaseStatus = typeof CustomerPassPurchaseStatus.Type;

export const CustomerUnlimitedStartDates = Schema.Struct({
  today: CustomerPlainDate,
  lastStartDate: CustomerPlainDate,
  starts: Schema.Struct({
    "open-space": Schema.Array(CustomerPlainDate),
    "reserved-desk": Schema.Array(CustomerPlainDate),
    "reserved-desk-workstation": Schema.Record(
      CustomerMonitorOption,
      Schema.Array(CustomerPlainDate)
    ),
  }),
}).annotate({ identifier: "CustomerUnlimitedStartDates" });
export type CustomerUnlimitedStartDates =
  typeof CustomerUnlimitedStartDates.Type;

export class CustomerPassPurchaseRefused extends Schema.TaggedError<CustomerPassPurchaseRefused>()(
  "CustomerPassPurchaseRefused",
  {
    reason: Schema.Literals([
      "buyer-profile-required",
      "holder-unavailable",
      "purchase-conflict",
      "consent-required",
      "quote-expired",
      "payment-in-progress",
      "holds-unavailable",
      "billing-changed",
      "invalid-selection",
    ]),
    blockingDates: Schema.optionalKey(Schema.Array(CustomerPlainDate)),
    orderId: Schema.optionalKey(CustomerPassId),
  }
) {
  static schema = this.pipe(HttpApiSchema.status("Conflict"));
}

const purchaseErrors = [
  CustomerPassesUnavailable.schema,
  CustomerAccountLinkRequired.schema,
  CustomerPassPurchaseRefused.schema,
  CustomerServiceUnavailable.schema,
] as const;

export const customerPassPurchaseEndpoints = [
  HttpApiEndpoint.get("getUnlimitedStartDates", "/unlimited/start-dates", {
    query: {
      startsOn: Schema.optionalKey(CustomerPlainDate),
      supersedeOrderId: Schema.optionalKey(CustomerPassId),
    },
    success: CustomerUnlimitedStartDates,
    error: purchaseErrors,
  }),
  HttpApiEndpoint.post("beginPassPurchase", "/purchases", {
    payload: BeginCustomerPassPurchase,
    success: CustomerPassPurchase,
    error: purchaseErrors,
  }).annotate(HttpApi.PayloadParseOptions, customerInputParseOptions),
  HttpApiEndpoint.get("getPassPurchaseStatus", "/purchases/:orderId", {
    params: { orderId: CustomerPassId },
    query: { locale: Schema.optionalKey(CustomerLocale) },
    success: CustomerPassPurchaseStatus,
    error: [...purchaseErrors, CustomerPassNotFound.schema],
  }),
  HttpApiEndpoint.post("submitPassPurchase", "/purchases/:orderId/payment", {
    params: { orderId: CustomerPassId },
    payload: SubmitCustomerPassPurchase,
    success: CustomerPassPayment,
    error: [...purchaseErrors, CustomerPassNotFound.schema],
  }).annotate(HttpApi.PayloadParseOptions, customerInputParseOptions),
  HttpApiEndpoint.patch(
    "updatePassPurchasePrice",
    "/purchases/:orderId/price",
    {
      params: { orderId: CustomerPassId },
      payload: UpdateCustomerPassPurchasePrice,
      success: CustomerPassPurchasePriceUpdate,
      error: purchaseErrors,
    }
  ).annotate(HttpApi.PayloadParseOptions, customerInputParseOptions),
] as const;
