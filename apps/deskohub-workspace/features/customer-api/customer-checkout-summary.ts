import type { CustomerCheckoutSummary } from "@deskohub/workspace-customer-api";
import type { CheckoutSummary } from "@/features/checkout/checkout-summary";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";

/**
 * The checkout service's itemized price as the customer API answers it, with
 * the company's VAT status from the setting the website and invoices read.
 */
export const toCustomerCheckoutSummary = (
  summary: CheckoutSummary
): CustomerCheckoutSummary => ({
  ...summary,
  sections: summary.sections.map((section) => ({
    ...section,
    items: section.items.map((item) =>
      "product" in item && item.product.kind === "table"
        ? { ...item, seats: item.product.seats }
        : item
    ),
  })),
  vatStatus: workspaceSiteConstants.company.vatStatus,
});
