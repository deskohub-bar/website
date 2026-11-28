import type { CheckoutSummaryOrderItem } from "@/features/checkout/checkout-summary";
import { CheckoutSummaryDiscountDetails } from "@/features/checkout/components/checkout-summary-discount-details";
import { CheckoutSummaryLine } from "@/features/checkout/components/checkout-summary-line";
import { getWorkspaceTableProductTitle } from "@/features/checkout/product-catalog.i18n";
import { type Locale, m } from "@/features/i18n";
import { moneyWithValue } from "@/shared/money/money";

type TableCheckoutSummaryItemData = Extract<
  CheckoutSummaryOrderItem,
  { readonly product: { readonly kind: "table" } }
>;

export function TableCheckoutSummaryItem({
  changed,
  item,
  locale,
}: {
  readonly changed?: boolean;
  readonly item: TableCheckoutSummaryItemData;
  readonly locale: Locale;
}) {
  return (
    <>
      <CheckoutSummaryLine
        amount={item.baseAmount}
        changed={changed}
        label={m.invoiceTableBaseLineLabel({}, { locale })}
        locale={locale}
      />
      <CheckoutSummaryLine
        amount={item.usageAmount}
        changed={changed}
        label={m.invoiceTableUsageLineLabel(
          { minutes: item.product.durationMinutes },
          { locale }
        )}
        locale={locale}
      />
      {item.originalAmount && item.discounts ? (
        <CheckoutSummaryLine
          amount={moneyWithValue(
            item.amount.value - item.originalAmount.value,
            item.amount
          )}
          changed={changed}
          label={m.checkoutSummaryItemCustomerDiscount({}, { locale })}
          locale={locale}
        >
          <CheckoutSummaryDiscountDetails
            discounts={item.discounts}
            locale={locale}
            productLabel={getWorkspaceTableProductTitle(locale)}
          />
        </CheckoutSummaryLine>
      ) : null}
    </>
  );
}
