"use client";

import Interpolate from "@doist/react-interpolate";
import { CreditCard, QrCode, RotateCcw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { type ReactNode, type Ref, useId } from "react";
import { type Locale, m } from "@/features/i18n";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  type CardProps,
  CardTitle,
} from "@/shared/components/ui/card";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { ChoiceCard } from "@/shared/components/ui/choice-card";
import { formatMoney, type Money } from "@/shared/money/money";
import { cn } from "@/shared/utils";
import { CheckoutSummaryLine } from "./checkout-summary-line";
import type { CheckoutPaymentMethod } from "./use-checkout-pay-submission";

type CheckoutPayActionVariant = "pay" | "retry";

export function CheckoutPayCard({
  children,
  headingRef,
  lead,
  title,
  ...props
}: Omit<CardProps, "className"> & {
  readonly lead?: string | null;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly title: string;
}) {
  return (
    <Card
      {...props}
      className="relative overflow-hidden rounded-4xl border-white/55 bg-white/94 text-navy-blue shadow-[0_44px_140px_-54px_rgba(0,2,79,0.62)] backdrop-blur-sm"
    >
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-sunset-yellow/80 to-transparent" />
      <CardHeader className="space-y-3 pb-6">
        <CardTitle
          as="h1"
          className="text-3xl sm:text-[2.35rem]"
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
        >
          {title}
        </CardTitle>
        {!!lead && (
          <CardDescription className="max-w-2xl text-base leading-7 text-navy-blue/72">
            {lead}
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="space-y-6">{children}</CardContent>
    </Card>
  );
}

export function CheckoutPayConsent({
  checked,
  disabled,
  earlyStartRequest,
  id,
  locale,
  onCheckedChange,
  showEarlyPerformanceRequest = false,
  variant,
}: {
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly earlyStartRequest?: string;
  readonly id: string;
  readonly locale: Locale;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly showEarlyPerformanceRequest?: boolean;
  readonly variant: CheckoutPayActionVariant;
}) {
  return (
    <ChoiceCard htmlFor={id}>
      <Checkbox
        id={id}
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onCheckedChange={
          onCheckedChange
            ? (nextChecked) => onCheckedChange(Boolean(nextChecked))
            : undefined
        }
      />
      <span className="text-sm leading-6 text-navy-blue/66">
        <Interpolate
          string={
            {
              pay: m.checkoutPayConsent({}, { locale }),
              retry: m.checkoutPaymentRetryConsent({}, { locale }),
            }[variant]
          }
          mapping={{
            terms: (label) => (
              <LegalLink
                href={`/${locale}/terms-and-conditions`}
                label={label}
              />
            ),
            operatingRules: (label) => (
              <LegalLink href={`/${locale}/operating-rules`} label={label} />
            ),
            earlyPerformance: (text) =>
              showEarlyPerformanceRequest ? text : null,
          }}
        />
        {earlyStartRequest && <> {earlyStartRequest}</>}
      </span>
    </ChoiceCard>
  );
}

/**
 * What happens after the pay button: payment opens in a new tab, and the
 * payment provider's own "back to the shop" button, shown as a small replica
 * so the customer recognizes it there, returns them here.
 */
export function CheckoutPayProviderHandoff({
  id,
  locale,
}: {
  readonly id?: string;
  readonly locale: Locale;
}) {
  const returnToShop = m.checkoutPayNoteBackToShop({}, { locale });
  // Nexi publishes the German and Slovak language settings. The payment
  // result button labels for those languages have not been verified.
  const showsProviderLabel = locale !== "de-DE" && locale !== "sk-SK";
  return (
    <p
      className="flex items-start gap-2 text-sm leading-6 text-navy-blue/66"
      id={id}
    >
      <ShieldCheck
        aria-hidden="true"
        className="mt-1 size-4 shrink-0 text-aquamarine-ink"
      />
      <span>
        <Interpolate
          string={m.checkoutPayNoteNewTab({}, { locale })}
          mapping={{
            backToShop: showsProviderLabel ? (
              // Nexi's button: indigo, white bold capitals, 4px corners.
              <span className="mx-0.5 inline-block whitespace-nowrap rounded-[4px] bg-[#2D32AA] px-2 align-[0.1em] text-[0.7rem] font-bold uppercase leading-5 tracking-[0.08em] text-white">
                {returnToShop}
              </span>
            ) : (
              returnToShop
            ),
          }}
        />
      </span>
    </p>
  );
}

const payLabelAmountMarker = "__CHECKOUT_PAY_AMOUNT__";

/**
 * Whether the locale's pay label names the amount it charges. The catalog
 * decides: the de-DE legal order button (§ 312j BGB) carries no amount, so the
 * total stands beside the button instead.
 */
const payLabelNamesAmount = (locale: Locale) =>
  m
    .checkoutPayOrderAndPayAmountButton(
      { amount: payLabelAmountMarker },
      { locale }
    )
    .includes(payLabelAmountMarker);

export function CheckoutPaySubmitButton({
  disabled,
  freeOrderLabel,
  locale,
  onClick,
  pending,
  total,
  variant,
}: {
  readonly disabled?: boolean;
  readonly freeOrderLabel?: string;
  readonly locale: Locale;
  readonly onClick?: () => void;
  readonly pending?: boolean;
  /** The amount the provider charges; a free order omits it. */
  readonly total?: Money;
  readonly variant: CheckoutPayActionVariant;
}) {
  const separateTotalId = useId();
  const separateTotal =
    total && !payLabelNamesAmount(locale) ? total : undefined;
  const payMethod = total ? "card" : "free";

  const orderLabel = total
    ? m.checkoutPayOrderAndPayAmountButton(
        // No-break spaces keep the amount on one line when the label wraps.
        { amount: formatMoney(total, locale).replaceAll(" ", "\u00a0") },
        { locale }
      )
    : (freeOrderLabel ?? m.checkoutPayOrderAndPayButton({}, { locale }));
  return (
    <div className="@container space-y-3">
      {!!separateTotal && (
        <div id={separateTotalId}>
          <CheckoutSummaryLine
            amount={separateTotal}
            label={m.checkoutSummaryItemTotal({}, { locale })}
            locale={locale}
          />
        </div>
      )}
      <CheckoutPayButton
        describedBy={separateTotal ? separateTotalId : undefined}
        disabled={disabled}
        label={orderLabel}
        locale={locale}
        onClick={onClick}
        pending={pending}
        payment={variant === "retry" ? "retry" : payMethod}
      />
    </div>
  );
}

export function CheckoutPayMethodButtons({
  disabled,
  locale,
  pendingMethod,
  total,
}: {
  readonly disabled?: boolean;
  readonly locale: Locale;
  readonly pendingMethod?: CheckoutPaymentMethod;
  readonly total: Money;
}) {
  const totalId = useId();
  const cardHandoffId = useId();
  return (
    <section
      aria-labelledby={totalId}
      className="@container mx-auto grid w-full max-w-lg gap-3 border-t border-navy-blue/15 pt-4"
    >
      <h2
        className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 text-base font-semibold"
        id={totalId}
      >
        <span>{m.checkoutPayMethodsTitle({}, { locale })}</span>{" "}
        <span className="text-end text-lg whitespace-nowrap tabular-nums @max-[18rem]:text-base">
          {formatMoney(total, locale)}
        </span>
      </h2>
      {/* Equal outer tracks center the shared columns around the wider label. */}
      <div
        className={cn(
          "grid gap-y-2 [--payment-inset:1.5rem] @max-[18rem]:[--payment-inset:0.75rem]",
          "supports-[grid-template-columns:subgrid]:grid-cols-[minmax(var(--payment-inset),1fr)_3rem_minmax(0,max-content)_minmax(var(--payment-inset),1fr)]",
          "supports-[grid-template-columns:subgrid]:[&>button]:grid supports-[grid-template-columns:subgrid]:[&>button]:grid-cols-subgrid"
        )}
      >
        <CheckoutPayButton
          describedBy={totalId}
          disabled={disabled}
          label={m.checkoutPayByQr({}, { locale })}
          locale={locale}
          pending={pendingMethod === "qr"}
          payment="qr"
          sharedColumns
        />
        <CheckoutPayButton
          describedBy={`${totalId} ${cardHandoffId}`}
          disabled={disabled}
          label={m.checkoutPayByCard({}, { locale })}
          locale={locale}
          pending={pendingMethod === "card"}
          payment="card"
          sharedColumns
        />
      </div>
      <CheckoutPayProviderHandoff id={cardHandoffId} locale={locale} />
    </section>
  );
}

function CheckoutPayButton({
  describedBy,
  disabled,
  label,
  locale,
  onClick,
  payment,
  pending,
  sharedColumns = false,
}: {
  readonly describedBy?: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly locale: Locale;
  readonly onClick?: () => void;
  readonly payment: CheckoutPaymentMethod | "free" | "retry";
  readonly pending?: boolean;
  readonly sharedColumns?: boolean;
}) {
  const iconClassName = "size-4 shrink-0";
  const compact = sharedColumns || payment === "card";
  const icon = pending
    ? null
    : {
        card: (
          // The wordmark has 14px of transparent padding on the right at this size.
          // biome-ignore lint/performance/noImgElement: The fixed-size provider wordmark is served at its authored resolution.
          <img
            alt=""
            className="-mr-3.5 max-w-none shrink-0"
            height={15}
            src="/payment/nexi-wordmark-white.png"
            width={48}
          />
        ),
        free: <CreditCard aria-hidden="true" className={iconClassName} />,
        qr: <QrCode aria-hidden="true" className={iconClassName} />,
        retry: <RotateCcw aria-hidden="true" className={iconClassName} />,
      }[payment];
  return (
    <Button
      aria-describedby={describedBy}
      caps
      className={sharedColumns ? "col-span-full" : undefined}
      disabled={disabled}
      fullWidth
      name="method"
      onClick={onClick}
      pending={pending}
      size={compact ? "xl-compact" : "xl"}
      tone={payment === "card" ? "nexi" : undefined}
      type={onClick ? "button" : "submit"}
      value={payment}
      wrap
    >
      <span
        className={cn(
          sharedColumns
            ? "grid max-w-full min-w-0 grid-cols-[3rem_minmax(0,1fr)] items-center text-start supports-[grid-template-columns:subgrid]:col-span-2 supports-[grid-template-columns:subgrid]:col-start-2 supports-[grid-template-columns:subgrid]:grid-cols-subgrid"
            : "flex min-w-0 items-center justify-center gap-3",
          !sharedColumns && compact && "@max-[18rem]:gap-1"
        )}
      >
        {sharedColumns ? (
          <span
            className="flex justify-center pe-2 @max-[18rem]:pe-1"
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : (
          icon
        )}
        <span
          className={cn(
            "min-w-0",
            !sharedColumns && "text-balance",
            compact
              ? "@max-[21rem]:text-xs @max-[21rem]:tracking-[0.08em]"
              : "@max-[18rem]:text-xs @max-[18rem]:tracking-[0.08em]"
          )}
          data-checkout-pay-label=""
        >
          {pending ? m.checkoutPaymentRetryPending({}, { locale }) : label}
        </span>
      </span>
    </Button>
  );
}

function LegalLink({
  href,
  label,
}: {
  readonly href: string;
  readonly label: ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      target="_blank"
      rel="noreferrer"
      className="font-semibold text-burned-orange underline underline-offset-4 transition-colors hover:text-chilean-fire"
    >
      {label}
    </Link>
  );
}
