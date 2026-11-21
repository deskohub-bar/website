import { Check, CircleAlert, Clock } from "lucide-react";
import Link from "next/link";
import { CheckoutFlowLayout } from "@/features/checkout/components/checkout-flow-layout";
import { type Locale, m } from "@/features/i18n";
import { RouteAutoRefresh } from "@/shared/components/route-auto-refresh";
import { Button } from "@/shared/components/ui/button";
import { formatMoney } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils";
import {
  formatInstantDateTime,
  formatPlainDateRange,
} from "@/shared/utils/date-time-format";
import type { EntryPackStatus } from "../backend/entry-pack-status";
import { getEntryPackDetailsPath } from "../entry-pack-checkout";
import { getEntryPackLastUsableDate } from "../pass-offer";
import { getPassTierName } from "../pass-offer.i18n";

type OrderStatus = Exclude<
  EntryPackStatus,
  { status: "not_found" | "sign_in" }
>;

const statusTitles = {
  paid: m.entryPackStatusPaidTitle,
  pending: m.checkoutStatusPendingTitle,
  checking: m.checkoutStatusPaymentPendingDelayedTitle,
  not_started: m.entryPackStatusNotStartedTitle,
  cancelled: m.checkoutStatusCancelledTitle,
  expired: m.checkoutStatusExpiredTitle,
  failed: m.checkoutStatusPaymentFailedTitle,
  refund_required: m.entryPackStatusRefundPendingTitle,
  refunded: m.entryPackStatusRefundedTitle,
  partially_refunded: m.entryPackStatusPartiallyRefundedTitle,
};

const statusIcons = {
  paid: Check,
  pending: Clock,
  checking: Clock,
  not_started: Clock,
  cancelled: CircleAlert,
  expired: CircleAlert,
  failed: CircleAlert,
  refund_required: CircleAlert,
  refunded: Check,
  partially_refunded: Check,
};

export function EntryPackStatusPage({
  allowPurchaseContinuation,
  locale,
  status,
  presentation,
}: {
  readonly allowPurchaseContinuation: boolean;
  readonly locale: Locale;
  readonly status: OrderStatus;
  readonly presentation: "page" | "modal";
}) {
  const isPaid = status.status === "paid";
  const unlimited = status.entryCount === null;
  const isPending = status.status === "pending";
  const retryPath =
    allowPurchaseContinuation && "retryPath" in status
      ? status.retryPath
      : undefined;
  const draftPath = (() => {
    if (!allowPurchaseContinuation || status.status !== "not_started") return;
    return status.entryCount === null
      ? `/${locale}/passes/unlimited?order=${status.orderId}&step=details`
      : getEntryPackDetailsPath(
          locale,
          { kind: "entry-pack", tier: status.tier, size: status.entryCount },
          status.orderId
        );
  })();
  const Icon = statusIcons[status.status];
  const title =
    unlimited && isPaid
      ? m.unlimitedPassStatusPaidTitle({}, { locale })
      : statusTitles[status.status]({}, { locale });
  const lead = (() => {
    switch (status.status) {
      case "paid":
        return status.gift
          ? {
              not_sent: m.entryPackStatusGiftInvitationNotSent,
              pending: m.entryPackStatusGiftInvitationPending,
              sent: m.entryPackStatusGiftInvitationSent,
              failed: m.entryPackStatusGiftInvitationFailed,
            }[status.invitation]({}, { locale })
          : undefined;
      case "pending":
        return m.entryPackStatusPendingLead({}, { locale });
      case "checking":
        return m.entryPackStatusCheckingLead({}, { locale });
      case "refund_required":
        return status.lateCapture
          ? m.entryPackStatusRefundLead({}, { locale })
          : undefined;
      case "refunded":
        return m.entryPackStatusRefundedLead({}, { locale });
      case "partially_refunded":
        return m.entryPackStatusPartiallyRefundedLead(
          { amount: formatMoney(status.refunded, locale) },
          { locale }
        );
      default:
        return retryPath
          ? m.checkoutPaymentRetryFailedBanner({}, { locale })
          : undefined;
    }
  })();
  const content = (
    <div
      className={
        presentation === "modal"
          ? "bg-white p-6 text-navy-blue sm:p-10"
          : "rounded-[2.25rem] border border-white/55 bg-white/94 p-6 text-navy-blue shadow-[0_44px_140px_-54px_rgba(0,2,79,0.62)] backdrop-blur-sm sm:p-10"
      }
      data-entry-pack-status={status.status}
    >
      <RouteAutoRefresh enabled={isPending || status.status === "checking"} />
      <output className="sr-only" aria-live="polite" aria-atomic>
        {title}
      </output>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-navy-blue/5">
          <Icon aria-hidden="true" className="size-8" />
        </div>
        <div className="min-w-0">
          <h1 className="text-balance text-4xl leading-none sm:text-5xl">
            {title}
          </h1>
          {lead && (
            <p className="mt-4 text-lg leading-8 text-navy-blue/70">{lead}</p>
          )}
          {isPaid && status.gift && (
            <p className="mt-2 text-navy-blue/70">
              {status.claimed
                ? m.accountPassGiftClaimed({}, { locale })
                : m.accountPassGiftNotClaimed({}, { locale })}
            </p>
          )}
          {status.status === "partially_refunded" && status.refundPending && (
            <p className="mt-2 text-navy-blue/70">
              {m.entryPackStatusAdditionalRefundLead({}, { locale })}
            </p>
          )}
        </div>
      </div>
      <div className="mt-8 rounded-2xl border border-navy-blue/10 bg-navy-blue/3 p-5 sm:p-6">
        <h2 className="text-xl font-semibold">
          {unlimited
            ? m.passUnlimited({}, { locale })
            : m.passEntryPack({}, { locale })}
        </h2>
        <p className="mt-1 text-navy-blue/70">
          {getPassTierName(status.tier, locale)}
          {status.entryCount !== null &&
            ` · ${m.passEntryCount({ count: status.entryCount }, { locale })}`}
        </p>
        {isPaid && (
          <p className="mt-1 text-sm text-navy-blue/70">
            {m.passEmailValid(
              {
                dates: formatPlainDateRange({
                  locale,
                  start: Temporal.PlainDate.from(status.validFrom),
                  end: getEntryPackLastUsableDate(status.validUntil),
                }),
              },
              { locale }
            )}
          </p>
        )}
        <dl className="mt-5 grid gap-4 border-t border-navy-blue/10 pt-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-navy-blue/70">
              {m.checkoutSummarySectionOrder({}, { locale })}
            </dt>
            <dd className="break-all text-sm">{status.orderId}</dd>
          </div>
          {isPaid && status.gift && status.maskedHolderEmail && (
            <div>
              <dt className="text-sm text-navy-blue/70">
                {m.passEmailFor({}, { locale })}
              </dt>
              <dd className="break-all text-sm">{status.maskedHolderEmail}</dd>
            </div>
          )}
          {isPaid && (
            <div>
              <dt className="text-sm text-navy-blue/70">
                {m.passEmailPaidOn({}, { locale })}
              </dt>
              <dd className="text-sm">
                {formatInstantDateTime({
                  instant: status.paidAt,
                  locale,
                  timeZone: workspaceSiteConstants.location.timeZone,
                })}
              </dd>
            </div>
          )}
        </dl>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        {isPaid && unlimited && !status.gift && (
          <Button asChild size="lg">
            <Link
              href={`/${locale}/reservation/access/${status.orderId}`}
              prefetch={false}
            >
              {m.unlimitedPassOpenAccess({}, { locale })}
            </Link>
          </Button>
        )}
        {isPending && status.paymentPage && (
          <Button asChild size="lg">
            <a href={status.paymentPage}>
              {m.checkoutStatusOpenPaymentPage({}, { locale })}
            </a>
          </Button>
        )}
        {retryPath && (
          <Button asChild size="lg">
            <a href={retryPath}>{m.checkoutStatusTryAgain({}, { locale })}</a>
          </Button>
        )}
        {draftPath && (
          <Button asChild size="lg">
            <a href={draftPath}>{m.checkoutContinueButton({}, { locale })}</a>
          </Button>
        )}
        <Button asChild size="lg" variant="secondary">
          <Link href={`/${locale}`} prefetch={false}>
            {m.checkoutStatusBackHome({}, { locale })}
          </Link>
        </Button>
      </div>
    </div>
  );
  return presentation === "modal" ? (
    content
  ) : (
    <CheckoutFlowLayout activeStepKey="complete" locale={locale} steps={false}>
      {content}
    </CheckoutFlowLayout>
  );
}
