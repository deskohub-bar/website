import type {
  CustomerPassPurchase,
  CustomerPassTier,
} from "@deskohub/workspace-customer-api";
import KeyRound from "lucide-react-native/icons/key-round";
import { StyleSheet, View } from "react-native";
import { daysBetween } from "../../booking/selection/prague-date";
import { BookingSectionHeading } from "../../booking/ui/booking-section-heading";
import { formatPragueDate } from "../../booking/ui/prague-date-format";
import { monitorOptionName } from "../../booking/ui/price-line-description";
import type { AppLocale } from "../../i18n/app-locale";
import { m } from "../../i18n/messages";
import { formatMoney, formatMoneyReduction } from "../../i18n/money-format";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Text } from "../../ui/text";
import { color, space } from "../../ui/tokens";
import { PassPurchaseAgreement } from "./pass-purchase-agreement";
import { PassPurchaseCode } from "./pass-purchase-code";
import type { PurchaseKind } from "./pass-purchase-selection";

export const passTitle = (kind: PurchaseKind, locale: AppLocale) =>
  kind === "entry-pack"
    ? m.pass_purchase_entry_pack({}, { locale })
    : m.pass_purchase_unlimited({}, { locale });

export const passTierTitle = (tier: CustomerPassTier, locale: AppLocale) =>
  ({
    "open-space": m.booking_checkout_line_open_space,
    "reserved-desk": m.booking_checkout_line_reserved_desk,
    "reserved-desk-workstation": m.pass_purchase_workstation,
  })[tier]({}, { locale });

export const passEntryLabel = (size: number, locale: AppLocale) =>
  m.pass_purchase_entry_label({ count: String(size) }, { locale });

export const passPeriodLabel = (
  start: string,
  end: string,
  locale: AppLocale,
  includeYear = false
) =>
  m.pass_purchase_period_range(
    {
      start: formatPragueDate(start, locale, {
        month: "short",
        day: "numeric",
      }),
      end: formatPragueDate(end, locale, {
        month: "short",
        day: "numeric",
        ...(includeYear && { year: "numeric" }),
      }),
    },
    { locale }
  );

export function PassPurchaseReview({
  quote,
  recipient,
  buyer,
  checked,
  busy,
  onToggle,
  onChange,
  onCode,
  locale,
}: {
  readonly quote: CustomerPassPurchase;
  readonly recipient: string | undefined;
  readonly buyer: string;
  readonly checked: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onChange: () => void;
  readonly onCode: (code: string | undefined) => void;
  readonly locale: AppLocale;
}) {
  const { product, price, disclosure, validFrom, lastUsableDate } = quote;
  const entryPack = product.kind === "entry-pack";
  const title = passTitle(product.kind, locale);
  const tier = passTierTitle(
    entryPack ? product.tier : product.selection.tier,
    locale
  );
  const days = daysBetween(validFrom, lastUsableDate) + 1;
  const units = entryPack
    ? passEntryLabel(product.size, locale)
    : m.pass_purchase_days({ count: String(days) }, { locale });
  const monitors =
    product.kind === "unlimited" &&
    product.selection.tier === "reserved-desk-workstation"
      ? monitorOptionName(product.selection.monitorOption)
      : undefined;
  const coffee = price.coffeePrice;
  const basePrice =
    coffee === undefined
      ? price.subtotal
      : { ...price.subtotal, value: price.subtotal.value - coffee.value };
  return (
    <>
      <BookingSectionHeading
        first
        title={m.pass_purchase_summary({}, { locale })}
        action={{
          label: m.pass_purchase_change({}, { locale }),
          onPress: onChange,
          disabled: busy,
        }}
      />
      <Card padding="none">
        <ReviewRow
          label={m.pass_purchase_pass({}, { locale })}
          value={m.pass_purchase_product_summary({ title, units }, { locale })}
        />
        <ReviewRow
          label={m.pass_purchase_desk_type({}, { locale })}
          value={tier}
        />
        <ReviewRow
          label={
            entryPack
              ? m.pass_purchase_valid_until({}, { locale })
              : m.pass_purchase_period({}, { locale })
          }
          value={
            entryPack
              ? formatPragueDate(lastUsableDate, locale, {
                  dateStyle: "medium",
                })
              : passPeriodLabel(validFrom, lastUsableDate, locale, true)
          }
        />
        {monitors !== undefined && (
          <ReviewRow
            label={m.pass_purchase_monitors({}, { locale })}
            value={monitors}
          />
        )}
        <ReviewRow
          label={m.pass_purchase_for({}, { locale })}
          value={recipient ?? m.pass_purchase_self({ name: buyer }, { locale })}
          last
        />
      </Card>
      {!entryPack && (
        <Text variant="bodySmall" tone="muted">
          {m.pass_purchase_membership_terms({ days }, { locale })}
        </Text>
      )}
      <BookingSectionHeading title={m.pass_purchase_price({}, { locale })} />
      <Card padding="none">
        <ReviewRow
          label={m.pass_purchase_product_summary(
            { title, units: tier },
            { locale }
          )}
          detail={units}
          value={formatMoney(basePrice, locale)}
        />
        {coffee !== undefined && (
          <ReviewRow
            label={m.booking_checkout_line_coffee({}, { locale })}
            detail={units}
            value={formatMoney(coffee, locale)}
          />
        )}
        {price.discounts.map(({ id, label, amount }) => (
          <ReviewRow
            key={id}
            label={label}
            value={formatMoneyReduction(amount, locale)}
          />
        ))}
        <ReviewRow
          label={m.pass_purchase_total({}, { locale })}
          value={formatMoney(price.total, locale)}
          strong
          last
        />
      </Card>
      <PassPurchaseCode
        applied={price.appliedDiscountCode}
        busy={busy}
        onUpdate={onCode}
        locale={locale}
      />
      <PassPurchaseAgreement
        disclosure={disclosure}
        checked={checked}
        disabled={busy}
        onToggle={onToggle}
        locale={locale}
      />
      {product.kind === "unlimited" && (
        <View style={styles.note}>
          <Icon icon={KeyRound} size={18} color={color.action} />
          <Text variant="bodySmall" tone="muted" style={styles.noteText}>
            {m.pass_purchase_daily_code({}, { locale })}
          </Text>
        </View>
      )}
    </>
  );
}

function ReviewRow({
  label,
  value,
  detail,
  last = false,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly last?: boolean;
  readonly strong?: boolean;
}) {
  return (
    <View style={[styles.row, !last && styles.divided]}>
      <View style={styles.rowLabel}>
        <Text
          variant={strong ? "subhead" : "body"}
          tone={strong ? "default" : "muted"}
        >
          {label}
        </Text>
        {detail !== undefined && (
          <Text variant="bodySmall" tone="muted">
            {detail}
          </Text>
        )}
      </View>
      <Text variant={strong ? "headline" : "body"} style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  noteText: { flex: 1, minWidth: 0 },
  row: {
    padding: space.lg,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
  },
  divided: { borderBottomWidth: 1, borderBottomColor: color.divider },
  rowLabel: { flexGrow: 1, flexShrink: 1, minWidth: 70 },
  rowValue: { flexShrink: 1, textAlign: "right", maxWidth: "100%" },
});
