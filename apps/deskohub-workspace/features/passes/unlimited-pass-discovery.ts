import type { Locale } from "@/features/i18n";
import type { PlainDate } from "@/shared/utils/temporal";
import { type PassTier, unlimitedPassDays } from "./pass-offer";
import {
  getPassPurchaseDraftQuery,
  getTierPassPurchaseDraft,
  type PassPurchaseDraft,
} from "./pass-purchase-draft";
import { unlimitedPassCheckoutPath } from "./routes";

/**
 * The Unlimited purchase page for a tier, carrying the draft's start date
 * and the add-ons that tier sells.
 */
export function getUnlimitedPassPurchasePath(
  locale: Locale,
  draft: PassPurchaseDraft & { readonly tier: PassTier }
) {
  const query = getPassPurchaseDraftQuery(
    getTierPassPurchaseDraft(draft, draft.tier)
  );
  return `/${locale}${unlimitedPassCheckoutPath}?${query}`;
}

/**
 * The expiry an Unlimited pass bought now would show: its start date, or
 * today in Prague when none is chosen, plus the pass's calendar days.
 */
export const getUnlimitedPassOfferExpiry = ({
  today,
  startDate,
}: {
  readonly today: PlainDate | string;
  readonly startDate?: PlainDate;
}) =>
  Temporal.PlainDate.from(startDate ?? today).add({ days: unlimitedPassDays });
