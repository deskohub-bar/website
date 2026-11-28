import { CustomerProfileInput } from "@deskohub/workspace-customer-api";
import { Schema } from "effect";
import Mail from "lucide-react-native/icons/mail";
import { StyleSheet, View } from "react-native";
import { AccountAvatar } from "../../account/account-avatar";
import {
  checkoutBillingInput,
  type DetailsDraft,
  type DetailsFieldProblems,
  type DetailsProfile,
} from "../../booking/checkout-screen/details-form";
import {
  fieldProblemMessage,
  InvoiceSection,
} from "../../booking/checkout-screen/details-step";
import { BookingSectionHeading } from "../../booking/ui/booking-section-heading";
import type { AppLocale } from "../../i18n/app-locale";
import { m } from "../../i18n/messages";
import { Card } from "../../ui/card";
import { CheckboxRow } from "../../ui/checkbox";
import { TextField } from "../../ui/controls";
import { Icon } from "../../ui/icon";
import { Text } from "../../ui/text";
import { color, space } from "../../ui/tokens";
import type { PurchaseKind } from "./pass-purchase-selection";

export interface PurchaseDetails {
  readonly invoice: DetailsDraft;
  readonly buyer: {
    readonly firstName: string;
    readonly lastName: string;
    readonly phone: string;
  };
  readonly gift: boolean;
  readonly holderEmail: string;
  readonly recipientName: string;
}

export interface PurchaseDetailsProblems {
  readonly invoice?: DetailsFieldProblems;
  readonly buyer?: boolean;
  readonly holderEmail?: boolean;
  readonly recipientName?: boolean;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const validatePurchaseDetails = (
  kind: PurchaseKind,
  details: PurchaseDetails,
  profile: DetailsProfile,
  needsProfile: boolean
) => {
  const holderEmail = details.holderEmail.trim();
  const recipientName = details.recipientName.trim();
  const buyer = {
    firstName: details.buyer.firstName.trim(),
    lastName: details.buyer.lastName.trim(),
    ...(details.buyer.phone.trim() && { phone: details.buyer.phone.trim() }),
  };
  const invoice = checkoutBillingInput(profile.saved, details.invoice);
  const invoiceInvalid = Object.values(invoice.problems).some(
    (problem) => problem !== undefined
  );
  const problems: PurchaseDetailsProblems = {
    ...(invoiceInvalid && { invoice: invoice.problems }),
    ...(needsProfile &&
      !Schema.is(CustomerProfileInput)(buyer) && { buyer: true }),
    ...(details.gift &&
      (holderEmail.length > 255 ||
        !emailPattern.test(holderEmail) ||
        holderEmail.toLowerCase() === profile.self.email.toLowerCase()) && {
        holderEmail: true,
      }),
    ...(details.gift &&
      kind === "unlimited" &&
      (recipientName.length < 2 || recipientName.length > 100) && {
        recipientName: true,
      }),
  };
  if (Object.keys(problems).length > 0) {
    return { ok: false as const, problems };
  }
  return {
    ok: true as const,
    billing: invoice.billing,
    input: {
      ...(needsProfile && { buyerProfile: buyer }),
      ...(details.gift && {
        holderEmail,
        ...(kind === "unlimited" && { recipientName }),
      }),
    },
  };
};

export function PassPurchaseDetails({
  kind,
  profile,
  name,
  initials,
  needsProfile,
  details,
  onChange,
  problems,
  busy,
  locale,
}: {
  readonly kind: PurchaseKind;
  readonly profile: DetailsProfile;
  readonly name: string | undefined;
  readonly initials: string | undefined;
  readonly needsProfile: boolean;
  readonly details: PurchaseDetails;
  readonly onChange: (next: PurchaseDetails) => void;
  readonly problems: PurchaseDetailsProblems;
  readonly busy: boolean;
  readonly locale: AppLocale;
}) {
  const changeBuyer = (patch: Partial<PurchaseDetails["buyer"]>) =>
    onChange({ ...details, buyer: { ...details.buyer, ...patch } });
  return (
    <>
      <BookingSectionHeading
        title={m.pass_purchase_buyer({}, { locale })}
        first
      />
      <Card>
        {needsProfile ? (
          <View style={styles.fields}>
            <Text variant="bodySmall" tone="muted">
              {profile.self.email}
            </Text>
            <TextField
              label={m.profile_first_name_label({}, { locale })}
              autoComplete="given-name"
              value={details.buyer.firstName}
              onChangeText={(firstName) => changeBuyer({ firstName })}
              editable={!busy}
            />
            <TextField
              label={m.profile_last_name_label({}, { locale })}
              autoComplete="family-name"
              value={details.buyer.lastName}
              onChangeText={(lastName) => changeBuyer({ lastName })}
              editable={!busy}
            />
            <TextField
              label={m.profile_phone_label({}, { locale })}
              autoComplete="tel"
              keyboardType="phone-pad"
              value={details.buyer.phone}
              onChangeText={(phone) => changeBuyer({ phone })}
              editable={!busy}
              error={
                problems.buyer
                  ? m.pass_purchase_profile_invalid({}, { locale })
                  : undefined
              }
            />
          </View>
        ) : (
          <View style={styles.identity}>
            <AccountAvatar tone="on-paper" {...(initials && { initials })} />
            <View style={styles.identityText}>
              {name && <Text variant="subhead">{name}</Text>}
              <Text variant="bodySmall" tone="muted">
                {profile.self.email}
              </Text>
            </View>
          </View>
        )}
      </Card>
      <Text variant="bodySmall" tone="muted">
        {m.pass_purchase_buyer_note({}, { locale })}
      </Text>
      <CheckboxRow
        checked={details.gift}
        onChange={(gift) => onChange({ ...details, gift })}
        label={m.pass_purchase_gift({}, { locale })}
        disabled={busy}
      />
      {details.gift && (
        <Card>
          <View style={styles.fields}>
            {kind === "unlimited" && (
              <TextField
                label={m.pass_purchase_recipient_name({}, { locale })}
                value={details.recipientName}
                onChangeText={(recipientName) =>
                  onChange({ ...details, recipientName })
                }
                editable={!busy}
                error={
                  problems.recipientName
                    ? m.booking_details_error_name({}, { locale })
                    : undefined
                }
              />
            )}
            <TextField
              label={m.pass_purchase_holder_email({}, { locale })}
              value={details.holderEmail}
              onChangeText={(holderEmail) =>
                onChange({ ...details, holderEmail })
              }
              autoCapitalize="none"
              keyboardType="email-address"
              editable={!busy}
              error={
                problems.holderEmail
                  ? m.pass_purchase_holder_invalid({}, { locale })
                  : undefined
              }
            />
            <View style={styles.note}>
              <Icon icon={Mail} size={18} color={color.action} />
              <Text
                variant="bodySmall"
                tone="muted"
                style={styles.identityText}
              >
                {m.pass_purchase_invitation({}, { locale })}
              </Text>
            </View>
          </View>
        </Card>
      )}
      <InvoiceSection
        first={false}
        locale={locale}
        draft={details.invoice}
        saved={profile.saved}
        busy={busy}
        change={(invoice) => onChange({ ...details, invoice })}
        field={(name) => {
          const problem = problems.invoice?.[name];
          return {
            editable: !busy,
            error: problem && fieldProblemMessage(name, problem, locale),
          };
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  fields: { gap: space.md },
  identity: { flexDirection: "row", alignItems: "center", gap: space.md },
  identityText: { flex: 1, minWidth: 0 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
});
