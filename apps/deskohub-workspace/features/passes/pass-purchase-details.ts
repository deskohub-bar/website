import { Schema } from "effect";
import { updateCustomerProfileSchema } from "@/features/account/contracts";
import { type Locale, m } from "@/features/i18n";
import { reservationBillingSelectionSchema } from "@/features/reservation/reservation-billing";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";

export type PassPurchaseBuyer =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "profile-required"; readonly email: string }
  | { readonly kind: "linked"; readonly name: string; readonly email: string };

export const unlimitedGiftRecipientNameMaxLength = 100;

export const unlimitedGiftRecipientNameSchema = (locale: Locale) =>
  Schema.Trim.check(
    Schema.isNonEmpty({
      message: m.unlimitedPassRecipientNameRequired({}, { locale }),
    }),
    Schema.isMaxLength(unlimitedGiftRecipientNameMaxLength, {
      message: m.contactValidationNameMaximum(
        { max: unlimitedGiftRecipientNameMaxLength },
        { locale }
      ),
    })
  );

export const missingUnlimitedGiftRecipientName = (
  input: { readonly holderEmail?: string; readonly recipientName?: string },
  locale: Locale
): Schema.FilterIssue | undefined =>
  input.holderEmail && input.recipientName === undefined
    ? {
        path: ["recipientName"],
        issue: m.unlimitedPassRecipientNameRequired({}, { locale }),
      }
    : undefined;

export const passPurchaseDetailsSchema = (
  locale: Locale,
  product: "entry-pack" | "unlimited"
) =>
  Schema.Struct({
    holderEmail: Schema.optionalKey(reservationCustomerEmailSchema),
    recipientName: Schema.optionalKey(unlimitedGiftRecipientNameSchema(locale)),
    buyerProfile: Schema.optionalKey(updateCustomerProfileSchema(locale)),
    billing: reservationBillingSelectionSchema,
  }).check(
    Schema.makeFilter((input) =>
      product === "unlimited"
        ? missingUnlimitedGiftRecipientName(input, locale)
        : undefined
    )
  );
