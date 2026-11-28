import { workspaceTableProductIdentitySchema } from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Array as Arr } from "effect";
import {
  type CheckoutSummary,
  checkoutSummaryDiscountSchema,
  checkoutSummaryOrderSectionSchema,
  checkoutSummaryTotalSectionSchema,
} from "./checkout-summary";
import {
  tableCheckoutSummaryDiscountedProductItemSchema,
  tableCheckoutSummaryProductItemSchema,
} from "./checkout-summary-table-item";
import { getWorkspaceProductKey } from "./product-identity";
import type { TableReservationQuote } from "./reservation-quote-table";

export const getTableCheckoutSummary = (
  quote: TableReservationQuote
): CheckoutSummary => {
  const [base, usage] = quote.items;
  const product = workspaceTableProductIdentitySchema.make({
    kind: "table",
    seats: base.seats,
    durationMinutes: usage.durationMinutes,
  });
  const { expectedPrice: total, undiscountedPrice, discounts } = quote.payment;
  const summaryDiscounts = discounts.map(({ amount, discount }) =>
    checkoutSummaryDiscountSchema.make({ amount, discount })
  );
  const item = {
    key: `product:${getWorkspaceProductKey(product)}`,
    product,
    amount: total,
    baseAmount: base.amount,
    usageAmount: usage.amount,
  };
  const productItem = Arr.isReadonlyArrayNonEmpty(summaryDiscounts)
    ? tableCheckoutSummaryDiscountedProductItemSchema.make({
        ...item,
        originalAmount: undiscountedPrice,
        discounts: summaryDiscounts,
      })
    : tableCheckoutSummaryProductItemSchema.make(item);

  return {
    sections: [
      checkoutSummaryOrderSectionSchema.make({
        key: "order",
        items: [productItem],
        total,
      }),
      checkoutSummaryTotalSectionSchema.make({
        key: "total",
        items: [{ key: "total:final", amount: total }],
        total,
      }),
    ],
    total,
  };
};
