"use client";

import { useSearchParams } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import type { Locale } from "@/features/i18n";
import type { PassTier } from "@/features/passes/pass-offer";
import {
  type PassPurchaseDraft,
  readPassPurchaseDraft,
} from "@/features/passes/pass-purchase-draft";
import { getUnlimitedPassPurchasePath } from "@/features/passes/unlimited-pass-discovery";
import { GuardedLink as Link } from "@/shared/components/guarded-link";
import { Button } from "@/shared/components/ui/button";

type UnlimitedPassPurchaseButtonProps = {
  readonly "aria-label": string;
  readonly children: ReactNode;
  readonly locale: Locale;
  readonly tier: PassTier;
};

/**
 * Buys the row's Unlimited tier with the booking draft Pricing was opened
 * with. The draft is read in the browser, so the prerendered page keeps the
 * plain link and stays the same for every visitor. Until the page hydrates
 * that link can't be followed, so it can't drop the draft; agents reading the
 * HTML still find it.
 */
export function UnlimitedPassPurchaseButton(
  props: UnlimitedPassPurchaseButtonProps
) {
  return (
    <Suspense fallback={<PurchaseButton {...props} pending />}>
      <DraftPurchaseButton {...props} />
    </Suspense>
  );
}

function DraftPurchaseButton(props: UnlimitedPassPurchaseButtonProps) {
  // Rendered outside the App Router, as React's own prerender does, there
  // are no search params.
  const searchParams = useSearchParams() ?? new URLSearchParams();
  return (
    <PurchaseButton
      {...props}
      draft={readPassPurchaseDraft(Object.fromEntries(searchParams))}
    />
  );
}

function PurchaseButton({
  children,
  draft,
  locale,
  pending = false,
  tier,
  ...props
}: UnlimitedPassPurchaseButtonProps & {
  readonly draft?: PassPurchaseDraft;
  /** Not yet followable: the page's draft isn't read until it hydrates. */
  readonly pending?: boolean;
}) {
  return (
    <Button asChild size="md" caps className="mt-3">
      <Link
        {...props}
        href={getUnlimitedPassPurchasePath(locale, { ...draft, tier })}
        inert={pending}
      >
        {children}
      </Link>
    </Button>
  );
}
