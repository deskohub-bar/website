"use client";

import { Mail } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { getAccountSectionPath } from "@/features/account/routes";
import { type Locale, m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { resendEntryPackInvitation } from "@/features/passes/entry-pack-gift-actions";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils";

export function FocusedGiftPassCard({
  children,
  className,
  locale,
  orderId,
  titleId,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly locale: Locale;
  readonly orderId: OrderId;
  readonly titleId?: string;
}) {
  const pathname = usePathname();
  const targets = useSearchParams()?.getAll("pass");
  const highlighted =
    pathname === getAccountSectionPath(locale, "passes") &&
    targets?.length === 1 &&
    targets[0] === orderId;
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    if (highlighted) card.current?.focus();
  }, [highlighted]);

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        className,
        highlighted &&
          "scroll-mt-28 border-navy-blue ring-2 ring-navy-blue/30 ring-offset-2"
      )}
      ref={card}
      tabIndex={highlighted ? -1 : undefined}
    >
      {children}
    </article>
  );
}

export function GiftInvitationResend({
  canResend,
  locale,
  orderId,
}: {
  readonly canResend: boolean;
  readonly locale: Locale;
  readonly orderId: OrderId;
}) {
  const router = useRouter();
  const [result, resend, pending] = useActionState<
    "queued" | "unavailable" | undefined
  >(async () => {
    try {
      const outcome = await resendEntryPackInvitation(orderId, locale);
      router.refresh();
      return outcome;
    } catch {
      return "unavailable";
    }
  }, undefined);

  return (
    <form action={resend} className="contents">
      {(canResend || pending || result !== undefined) && (
        <Button
          disabled={!canResend || pending}
          size="sm"
          type="submit"
          variant="secondary"
          wrap
        >
          <Mail aria-hidden="true" className="size-4 shrink-0" />
          {pending
            ? m.accountPassGiftResending({}, { locale })
            : m.accountPassGiftResend({}, { locale })}
        </Button>
      )}
      <p
        className={
          result && !pending
            ? "basis-full text-sm text-slate-600 @2xl:text-end"
            : "sr-only"
        }
        role="status"
      >
        {result &&
          !pending &&
          {
            queued: m.accountPassGiftResendQueued,
            unavailable: m.accountPassGiftResendUnavailable,
          }[result]({}, { locale })}
      </p>
    </form>
  );
}
