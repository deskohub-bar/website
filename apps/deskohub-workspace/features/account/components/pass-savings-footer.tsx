import type { ReactNode } from "react";
import { type Locale, m } from "@/features/i18n";
import { getPricingPath } from "@/features/pricing/pricing-path";
import { GuardedLink } from "@/shared/components/guarded-link";

/**
 * The Past reservations footer that sends a customer who pays visit by visit
 * to Pricing to compare Entry packs and Unlimited passes. It fills an
 * edge-to-edge `AccountSectionPanel` footer, which docks it above the install
 * bar and safe area while the section scrolls.
 */
export function PassSavingsFooter({
  locale,
  marks,
}: {
  readonly locale: Locale;
  /** Product marks shown before the label; decorative. */
  readonly marks?: ReactNode;
}) {
  return (
    <GuardedLink
      className="group flex min-h-14 items-center gap-3 border-t border-[#e9ded0] bg-[#fbf6ee] px-5 py-3 font-semibold text-[#813311] leading-[1.35] shadow-[0_-8px_18px_-14px_#522d1b55] outline-none hover:bg-[#f6ebdc] focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[#813311] @xl:px-8"
      data-account-pass-savings=""
      href={getPricingPath(locale)}
    >
      {marks !== undefined && (
        <span
          aria-hidden="true"
          className="flex flex-none items-center"
          data-account-pass-savings-marks=""
        >
          {marks}
        </span>
      )}
      <span className="text-balance underline-offset-[0.22em] group-hover:underline">
        {m.accountReservationsPassSavingsLink({}, { locale })}
      </span>
      <span
        aria-hidden="true"
        className="ms-auto size-[7px] flex-none rotate-45 border-t-[1.5px] border-e-[1.5px] border-current"
      />
    </GuardedLink>
  );
}
