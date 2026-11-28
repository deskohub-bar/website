import { useId } from "react";
import { type Locale, m } from "@/features/i18n";
import type { PlainDate } from "@/shared/utils/temporal";
import { getEntryPackPurchasePath } from "../entry-pack-discovery";
import type { PassTier } from "../pass-offer";
import type { PassPurchaseDraft } from "../pass-purchase-draft";
import {
  getUnlimitedPassOfferExpiry,
  getUnlimitedPassPurchasePath,
} from "../unlimited-pass-discovery";
import { EntryPackOfferCard, UnlimitedPassOfferCard } from "./pass-offer-cards";

/**
 * The Entry pack and Unlimited pass cards below a booking form, linking to
 * their purchase pages with the booking's current choices. An Entry pack is
 * used on dates booked later, so its link names only the tier.
 */
export function PassPurchaseOffers({
  draft,
  locale,
  today,
}: {
  readonly draft: PassPurchaseDraft & { readonly tier: PassTier };
  readonly locale: Locale;
  /** Today in Prague, the Unlimited start when the draft has no date. */
  readonly today: PlainDate | string;
}) {
  const headingId = useId();
  const expiryId = useId();

  return (
    <section aria-labelledby={headingId} className="pt-2">
      <h2 className="sr-only" id={headingId}>
        {m.passPurchaseOffersHeading({}, { locale })}
      </h2>
      {/* Spans the page edge to edge; the page clips horizontal overflow. */}
      <hr className="relative left-1/2 mb-8 w-screen -translate-x-1/2 border-0 border-t-2 border-dotted border-[#777caf]" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22.5rem),1fr))] gap-3">
        <EntryPackOfferCard
          href={getEntryPackPurchasePath(locale, draft.tier)}
          locale={locale}
          tier={draft.tier}
        />
        <UnlimitedPassOfferCard
          expiresOn={getUnlimitedPassOfferExpiry({
            today,
            startDate: draft.startDate,
          })}
          expiryId={expiryId}
          href={getUnlimitedPassPurchasePath(locale, draft)}
          locale={locale}
          tier={draft.tier}
        />
      </div>
    </section>
  );
}
