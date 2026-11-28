import type { Locale } from "@/features/i18n";
import {
  getPassPurchaseDraftQuery,
  type PassPurchaseDraft,
} from "@/features/passes/pass-purchase-draft";

const pricingPath = "/pricing";

/**
 * The Pricing page, carrying a booking draft for its pass purchase links to
 * pass on. Without a draft it's the plain page.
 */
export const getPricingPath = (locale: Locale, draft?: PassPurchaseDraft) => {
  const query = draft ? getPassPurchaseDraftQuery(draft).toString() : "";
  return `/${locale}${pricingPath}${query && `?${query}`}`;
};
