"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type {
  CheckoutSummaryChangedKeys,
  CheckoutSummary as CheckoutSummaryData,
} from "@/features/checkout/checkout-summary";
import { CheckoutBanner } from "@/features/checkout/components/checkout-banner";
import { CheckoutDiscountCountdownBanner } from "@/features/checkout/components/checkout-discount-countdown-banner";
import { CheckoutSummary } from "@/features/checkout/components/checkout-summary";
import { type Locale, m } from "@/features/i18n";
import {
  type OfficeCheckoutPeople,
  OfficeCheckoutPeopleReview,
} from "@/features/office/components/office-checkout-people";
import { EntryPackBookingNotice } from "@/features/passes/components/entry-pack-booking-notice";
import { getCoworkReservationPath } from "@/features/reservation/routes";
import { Button } from "@/shared/components/ui/button";
import {
  CheckoutPayCard,
  CheckoutPayConsent,
  CheckoutPayMethodButtons,
  CheckoutPayProviderHandoff,
  CheckoutPaySubmitButton,
} from "./checkout-pay-page-card";
import {
  type StartCheckoutPaymentAction,
  useCheckoutPaySubmission,
} from "./use-checkout-pay-submission";

type CheckoutPayPageProps = {
  readonly changedKeys?: CheckoutSummaryChangedKeys;
  readonly discountCodeForm?: ReactNode;
  readonly earlyPerformanceRequestRequired?: boolean;
  readonly freshPayUrl?: string;
  readonly locale: Locale;
  /** An office order's first day, which its order line names. */
  readonly officeStartDateLabel?: string;
  readonly payStateToken?: string;
  /** Who is coming to an office order with a people list. */
  readonly people?: OfficeCheckoutPeople;
  readonly startPaymentAction?: StartCheckoutPaymentAction;
  readonly summary: CheckoutSummaryData;
  readonly usesEntryPack?: boolean;
  readonly variant: "pay" | "retry" | "pricingChanged";
  readonly retryOutcome?: "cancelled" | "failed";
};

export function CheckoutPayPage({
  changedKeys,
  discountCodeForm,
  earlyPerformanceRequestRequired = true,
  freshPayUrl,
  locale,
  officeStartDateLabel,
  payStateToken,
  people,
  retryOutcome,
  startPaymentAction,
  summary,
  usesEntryPack = false,
  variant,
}: CheckoutPayPageProps) {
  const providerTotal = summary.total.value > 0 ? summary.total : undefined;
  const dualPaymentTotal =
    startPaymentAction &&
    !usesEntryPack &&
    payStateToken &&
    variant === "pay" &&
    providerTotal?.currency === "CZK"
      ? providerTotal
      : undefined;
  const {
    errorMessage,
    isSubmitPending,
    legalConsent,
    pendingMethod,
    setLegalConsent,
    submit,
  } = useCheckoutPaySubmission({
    earlyPerformanceRequestRequired,
    locale,
    payStateToken,
    startPaymentAction: dualPaymentTotal ? startPaymentAction : undefined,
  });
  const isPricingChanged = variant === "pricingChanged";
  const title = {
    pay:
      usesEntryPack && providerTotal
        ? m.coworkEntryPackPayAddon({}, { locale })
        : m.checkoutPayTitle({}, { locale }),
    retry: m.checkoutPaymentRetryTitle({}, { locale }),
    pricingChanged: m.checkoutPayPricingChangedTitle({}, { locale }),
  }[variant];
  const lead = {
    pay: null,
    retry: m.checkoutPaymentRetryLead({}, { locale }),
    pricingChanged: m.checkoutPayPricingChangedLead({}, { locale }),
  }[variant];
  const actionVariant = (
    {
      pay: "pay",
      retry: "retry",
      pricingChanged: "pay",
    } as const
  )[variant];
  return (
    <CheckoutPayCard lead={lead} title={title}>
      <CheckoutPayNotices
        isPricingChanged={isPricingChanged}
        locale={locale}
        retryOutcome={retryOutcome}
      />

      <CheckoutDiscountCountdownBanner locale={locale} summary={summary} />

      {people ? (
        <div className="@container">
          <div className="grid items-start gap-3 @3xl:grid-cols-2">
            <CheckoutSummary
              changedKeys={changedKeys}
              locale={locale}
              officeStartDateLabel={officeStartDateLabel}
              summary={summary}
            />
            <OfficeCheckoutPeopleReview locale={locale} people={people} />
          </div>
        </div>
      ) : (
        <CheckoutSummary
          changedKeys={changedKeys}
          locale={locale}
          officeStartDateLabel={officeStartDateLabel}
          summary={summary}
          usesEntryPack={usesEntryPack}
        />
      )}

      {variant === "pay" && discountCodeForm}
      {usesEntryPack && <EntryPackBookingNotice locale={locale} />}

      {isPricingChanged ? (
        <CheckoutPayUpdatedPriceLink
          freshPayUrl={freshPayUrl}
          locale={locale}
        />
      ) : (
        <form
          className="space-y-6"
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            const method =
              dualPaymentTotal &&
              event.nativeEvent.submitter?.getAttribute("value") === "qr"
                ? "qr"
                : "card";
            submit(method);
          }}
        >
          <CheckoutPayConsent
            checked={legalConsent}
            id="checkout-pay-legal-consent"
            locale={locale}
            onCheckedChange={setLegalConsent}
            showEarlyPerformanceRequest={earlyPerformanceRequestRequired}
            variant={actionVariant}
          />

          {dualPaymentTotal ? (
            <CheckoutPayMethodButtons
              disabled={!legalConsent || isSubmitPending}
              locale={locale}
              pendingMethod={pendingMethod}
              total={dualPaymentTotal}
            />
          ) : (
            <>
              <CheckoutPaySubmitButton
                disabled={!legalConsent || isSubmitPending}
                freeOrderLabel={
                  usesEntryPack
                    ? m.coworkEntryPackBookWithEntry({}, { locale })
                    : undefined
                }
                locale={locale}
                pending={isSubmitPending}
                total={providerTotal}
                variant={actionVariant}
              />
              {!!providerTotal && (
                <CheckoutPayProviderHandoff locale={locale} />
              )}
            </>
          )}
        </form>
      )}

      {!!errorMessage && (
        <CheckoutBanner role="alert">{errorMessage}</CheckoutBanner>
      )}
    </CheckoutPayCard>
  );
}

/** Why the customer is back on the Pay page, when they are. */
function CheckoutPayNotices({
  isPricingChanged,
  locale,
  retryOutcome,
}: {
  readonly isPricingChanged: boolean;
  readonly locale: Locale;
  readonly retryOutcome: CheckoutPayPageProps["retryOutcome"];
}) {
  return (
    <>
      {!!retryOutcome && (
        <CheckoutBanner>
          {
            {
              cancelled: m.checkoutPaymentRetryCancelledBanner({}, { locale }),
              failed: m.checkoutPaymentRetryFailedBanner({}, { locale }),
            }[retryOutcome]
          }
        </CheckoutBanner>
      )}

      {isPricingChanged && (
        <CheckoutBanner>
          {m.checkoutPayPricingChangedBanner({}, { locale })}
        </CheckoutBanner>
      )}
    </>
  );
}

function CheckoutPayUpdatedPriceLink({
  freshPayUrl,
  locale,
}: {
  readonly freshPayUrl: string | undefined;
  readonly locale: Locale;
}) {
  return (
    <Button asChild size="xl" caps fullWidth>
      <Link
        href={freshPayUrl ?? getCoworkReservationPath(locale)}
        prefetch={false}
      >
        {m.checkoutPayReviewUpdatedPriceButton({}, { locale })}
      </Link>
    </Button>
  );
}
