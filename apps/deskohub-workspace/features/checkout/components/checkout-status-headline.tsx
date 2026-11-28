import { cva } from "class-variance-authority";
import type { Ref } from "react";
import { type Locale, m } from "@/features/i18n";
import { cn } from "@/shared/utils";
import type { CheckoutStatusCopy } from "./checkout-status-copy";

const statusIconWrapperVariants = cva(
  "flex h-16 w-16 shrink-0 items-center justify-center rounded-full ring-8",
  {
    variants: {
      tone: {
        success:
          "bg-aquamarine-green/14 text-aquamarine-ink ring-aquamarine-green/8",
        pending: "bg-burned-orange/12 text-burned-orange ring-burned-orange/8",
        warning: "bg-burned-orange/12 text-burned-orange ring-burned-orange/8",
        failed: "bg-red-500/10 text-red-600 ring-red-500/8",
        unknown: "bg-navy-blue/8 text-navy-blue/60 ring-navy-blue/6",
      },
    },
  }
);

export function CheckoutStatusAnnouncement({
  locale,
  title,
}: {
  readonly locale: Locale;
  readonly title: string;
}) {
  return (
    <output className="sr-only" aria-live="polite" aria-atomic>
      {m.checkoutStatusEyebrow({}, { locale })}: {title}
    </output>
  );
}

export function CheckoutStatusHeadline({
  copy,
  headingRef,
  locale,
  reviewSandbox,
  showSupportButton,
}: {
  readonly copy: CheckoutStatusCopy;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly locale: Locale;
  readonly reviewSandbox: boolean;
  readonly showSupportButton: boolean;
}) {
  const Icon = copy.Icon;

  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
      <div className={statusIconWrapperVariants({ tone: copy.tone })}>
        <Icon className="h-9 w-9" aria-hidden="true" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-burned-orange">
          {m.checkoutStatusEyebrow({}, { locale })}
        </p>
        <h1
          className="mt-4 text-balance text-4xl leading-none sm:text-5xl"
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
        >
          {copy.title}
        </h1>
        <p
          className={cn(
            "mt-5 text-lg leading-8 text-navy-blue/70",
            showSupportButton &&
              "after:content-['_↴'] after:text-4xl after:leading-0"
          )}
        >
          {copy.lead}
        </p>
        {reviewSandbox && (
          <p
            className="mt-4 rounded-2xl border border-navy-blue/10 bg-navy-blue/3 px-4 py-3 text-sm leading-6 text-navy-blue/72"
            id="checkout-status-review-sandbox"
          >
            {m.checkoutStatusReviewSandboxNotice({}, { locale })}
          </p>
        )}
      </div>
    </div>
  );
}
