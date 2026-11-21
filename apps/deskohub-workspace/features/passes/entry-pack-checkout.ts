import { Schema } from "effect";
import { updateCustomerProfileSchema } from "@/features/account/contracts";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { Locale } from "@/features/i18n";
import { locales } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { reservationBillingSelectionSchema } from "@/features/reservation/reservation-billing";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import type { Money } from "@/shared/money/money";
import {
  type EntryPackProduct,
  entryPackProductSchema,
  passTiers,
} from "./pass-offer";

import { entryPackCheckoutPath } from "./routes";

export function readEntryPackSelection(query: {
  readonly tier?: string | string[];
  readonly size?: string | string[];
}): EntryPackProduct {
  return {
    kind: "entry-pack",
    tier: passTiers.find((tier) => tier === query.tier) ?? "reserved-desk",
    size: query.size === "5" ? 5 : 10,
  };
}

export function getEntryPackDetailsPath(
  locale: Locale,
  product: EntryPackProduct,
  orderId?: OrderId
) {
  const query = new URLSearchParams({
    tier: product.tier,
    size: String(product.size),
    step: "details",
    ...(orderId !== undefined && { order: orderId }),
  });
  return `/${locale}${entryPackCheckoutPath}?${query}`;
}

export function getEntryPackPayPath(locale: Locale, orderId: OrderId) {
  const query = new URLSearchParams({ order: orderId, step: "pay" });
  return `/${locale}${entryPackCheckoutPath}?${query}`;
}

export type { PassPurchaseBuyer as EntryPackBuyer } from "./pass-purchase-details";

export type EntryPackCheckoutPrice = {
  readonly fingerprint: string;
  readonly subtotal: Money;
  readonly total: Money;
  readonly appliedDiscountCode?: string;
  readonly discounts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly amount: Money;
  }>;
};

const entryPackOrderFields = {
  orderId: orderIdSchema,
  locale: Schema.Literals(locales),
};
const submittedCode = Schema.optionalKey(
  Schema.String.check(Schema.isMaxLength(160))
);
const displayedPriceFingerprint = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/)
);

export const beginEntryPackCheckoutSchema = (locale: Locale) =>
  Schema.Struct({
    ...entryPackOrderFields,
    product: entryPackProductSchema,
    buyerEmail: reservationCustomerEmailSchema,
    holderEmail: Schema.optionalKey(reservationCustomerEmailSchema),
    buyerProfile: Schema.optionalKey(updateCustomerProfileSchema(locale)),
  });

export const repriceEntryPackCheckoutSchema = Schema.Struct({
  ...entryPackOrderFields,
  submittedCode,
  displayedPriceFingerprint,
});

export const payEntryPackCheckoutSchema = Schema.Struct({
  ...entryPackOrderFields,
  priorPaymentAttemptId: Schema.optionalKey(paymentAttemptIdSchema),
  accepted: Schema.Boolean,
  acceptedDocuments: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      hash: Schema.String,
    })
  ).check(Schema.isMaxLength(2)),
  displayedPriceFingerprint,
  billing: reservationBillingSelectionSchema,
});
