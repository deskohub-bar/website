import { type Ref, useId, useState } from "react";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import {
  CheckoutPayCard,
  CheckoutPayConsent,
  CheckoutPayProviderHandoff,
  CheckoutPaySubmitButton,
} from "@/features/checkout/components/checkout-pay-page-card";
import { openCheckoutPaymentWindow } from "@/features/checkout/components/checkout-payment-window";
import { CheckoutSummaryLine } from "@/features/checkout/components/checkout-summary-line";
import {
  CheckoutSummarySection,
  CheckoutSummarySections,
} from "@/features/checkout/components/checkout-summary-section";
import { type Locale, m } from "@/features/i18n";
import type { PaymentSubmitLegalDocument } from "@/features/legal/payment-submit-evidence";
import type { OrderId } from "@/features/order";
import type { ReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { reservationStatusPath } from "@/features/reservation/routes";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { formatMoney } from "@/shared/money/money";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import type { EntryPackCheckoutPrice } from "../entry-pack-checkout";
import type {
  payEntryPackCheckout,
  repriceEntryPackCheckout,
} from "../entry-pack-checkout-actions";
import { formatPassDate } from "../pass-offer.i18n";

export type PassPurchasePayState = {
  readonly price: EntryPackCheckoutPrice;
  readonly disclosure: {
    readonly documents: readonly PaymentSubmitLegalDocument[];
    readonly earlyStartRequest?: string;
  };
  readonly validFrom: string;
  readonly lastUsableDate: string;
  readonly billing: ReservationBillingSelection;
  readonly priorPaymentAttemptId?: PaymentAttemptId;
  readonly holderEmail?: string;
};

export type PassPurchasePaymentActions = {
  readonly repriceCheckout: typeof repriceEntryPackCheckout;
  readonly payCheckout: typeof payEntryPackCheckout;
};

export type PassPurchasePayProps = {
  readonly locale: Locale;
  readonly orderId: OrderId;
  readonly discountCodeEntryEnabled: boolean;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onExpire: () => void;
  readonly onRequestPayment: () => void;
};

export function PassPurchasePay({
  locale,
  orderId,
  state,
  discountCodeEntryEnabled,
  signInPath,
  orderLabel,
  product,
  orderDetail,
  returnExpiredQuoteToStatus,
  repriceCheckout,
  payCheckout,
  headingRef,
  onExpire,
  onRequestPayment,
}: PassPurchasePayProps &
  PassPurchasePaymentActions & {
    readonly state: PassPurchasePayState;
    readonly signInPath: string;
    readonly orderLabel: string;
    readonly product: "entry-pack" | "unlimited";
    readonly orderDetail?: string;
    readonly returnExpiredQuoteToStatus?: boolean;
  }) {
  const [price, setPrice] = useState(state.price);
  const [disclosure, setDisclosure] = useState(state.disclosure);
  const [checked, setChecked] = useState(false);
  const { appliedDiscountCode } = price;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [expired, setExpired] = useState(false);
  const consentId = useId();
  const codeId = useId();
  const input = { locale, orderId };
  const showError = () => setError(m.actionFailedUnexpectedly({}, { locale }));
  const signIn = () => window.location.assign(signInPath);
  const goToStatus = () =>
    window.location.replace(`/${locale}${reservationStatusPath}/${orderId}`);

  function handlePurchaseFailure(reason: string) {
    if (reason === "billing-changed" || reason === "payment-in-progress") {
      goToStatus();
    } else if (reason === "quote-expired") {
      if (returnExpiredQuoteToStatus) {
        goToStatus();
        return;
      }
      setExpired(true);
      setError(m.entryPackCheckoutQuoteExpired({}, { locale }));
    } else {
      showError();
    }
  }

  const reprice = useWorkspaceAction(repriceCheckout, {
    onError: showError,
    onSuccess({ data }) {
      if (data.status === "ready") {
        setPrice(data.price);
        setDraft("");
        setChecked(false);
      } else if (data.status === "pricing_changed") {
        setPrice(data.price);
        setChecked(false);
        setError(m.checkoutPayPricingChangedLead({}, { locale }));
      } else if (data.status === "code_unavailable") {
        setError(m.checkoutDiscountCodeUnavailable({}, { locale }));
      } else if (data.status === "signed_out") {
        signIn();
      } else if (data.status === "terms_changed") {
        setDisclosure(data.disclosure);
        setChecked(false);
        setError(m.entryPackCheckoutTermsChanged({}, { locale }));
      } else if (data.status === "purchase_error") {
        handlePurchaseFailure(data.reason);
      }
    },
  });
  const pay = useWorkspaceAction(payCheckout, {
    onError: showError,
    onSuccess({ data }) {
      if (data.status === "hosted") {
        if (openCheckoutPaymentWindow(data.redirectUrl, data.statusUrl))
          window.location.replace(data.statusUrl);
        else window.location.assign(data.redirectUrl);
      } else if (data.status === "paid" || data.status === "pending") {
        window.location.replace(data.statusUrl);
      } else if (data.status === "pricing_changed") {
        setPrice(data.price);
        setChecked(false);
        setError(m.checkoutPayPricingChangedLead({}, { locale }));
      } else if (data.status === "signed_out") {
        signIn();
      } else if (data.status === "terms_changed") {
        setDisclosure(data.disclosure);
        setChecked(false);
        setError(m.entryPackCheckoutTermsChanged({}, { locale }));
      } else if (data.status === "purchase_error") {
        handlePurchaseFailure(data.reason);
      }
    },
  });
  const busy = reprice.isPending || pay.isPending;
  const updateCode = (code?: string) => {
    setError(undefined);
    reprice.execute({
      ...input,
      displayedPriceFingerprint: price.fingerprint,
      ...(code !== undefined && { submittedCode: code }),
    });
  };
  const submitPayment = () => {
    if (!checked || busy || expired) return;
    setError(undefined);
    onRequestPayment();
    pay.execute({
      ...input,
      accepted: checked,
      ...(product === "unlimited" && {
        unlimitedEarlyStartAccepted: Boolean(disclosure.earlyStartRequest),
      }),
      acceptedDocuments: disclosure.documents.map(({ key, hash }) => ({
        key,
        hash,
      })),
      billing: state.billing,
      displayedPriceFingerprint: price.fingerprint,
      ...(state.priorPaymentAttemptId && {
        priorPaymentAttemptId: state.priorPaymentAttemptId,
      }),
    });
  };

  return (
    <CheckoutPayCard
      headingRef={headingRef}
      title={m.checkoutPayTitle({}, { locale })}
    >
      <CheckoutSummarySections>
        <CheckoutSummarySection sectionKey="order" locale={locale}>
          <CheckoutSummaryLine
            label={orderLabel}
            amount={price.total}
            detail={
              <>
                <span className="block">
                  {formatPassDate(state.validFrom, locale)} –{" "}
                  {formatPassDate(state.lastUsableDate, locale)}
                </span>
                {orderDetail && <span className="block">{orderDetail}</span>}
                {state.holderEmail && (
                  <span className="block break-all">
                    {m.entryPackCheckoutOrderHolder(
                      { email: state.holderEmail },
                      { locale }
                    )}
                  </span>
                )}
                {price.discounts.map(({ id, label, amount }) => (
                  <span
                    key={id}
                    className="block font-semibold text-aquamarine-ink"
                  >
                    {label} · −{formatMoney(amount, locale)}
                  </span>
                ))}
              </>
            }
            locale={locale}
          >
            {price.discounts.length > 0 && (
              <del className="order-first text-navy-blue/55">
                {formatMoney(price.subtotal, locale)}
              </del>
            )}
          </CheckoutSummaryLine>
        </CheckoutSummarySection>
        <CheckoutSummarySection sectionKey="total" locale={locale}>
          <CheckoutSummaryLine
            label={m.checkoutSummaryItemTotal({}, { locale })}
            amount={price.total}
            locale={locale}
          />
        </CheckoutSummarySection>
      </CheckoutSummarySections>
      {discountCodeEntryEnabled &&
        (appliedDiscountCode ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-aquamarine-green/40 bg-aquamarine-green/15 p-3 text-sm">
            <span>
              {m.entryPackCheckoutCodeApplied(
                { code: appliedDiscountCode },
                { locale }
              )}
            </span>
            <Button
              disabled={busy || expired}
              variant="link"
              type="button"
              onClick={() => updateCode()}
            >
              {m.checkoutDiscountCodeRemove({}, { locale })}
            </Button>
          </div>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() && !busy && !expired) updateCode(draft);
            }}
          >
            <label htmlFor={codeId} className="font-semibold text-sm">
              {m.checkoutDiscountCodeLabel({}, { locale })}
            </label>
            <div className="flex flex-wrap gap-2">
              <Input
                id={codeId}
                disabled={busy || expired}
                className="min-w-40 flex-1"
                autoComplete="off"
                maxLength={160}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <Button
                disabled={!draft.trim() || busy || expired}
                variant="secondary"
                type="submit"
              >
                {m.checkoutDiscountCodeApply({}, { locale })}
              </Button>
            </div>
          </form>
        ))}
      {price.total.value > 0 && <CheckoutPayProviderHandoff locale={locale} />}
      <div className="space-y-6">
        <p
          role="alert"
          className="empty:sr-only text-sm font-semibold text-burned-orange"
        >
          {error}
        </p>
        <CheckoutPayConsent
          checked={checked}
          disabled={busy || expired}
          {...(disclosure.earlyStartRequest !== undefined && {
            earlyStartRequest: disclosure.earlyStartRequest,
          })}
          id={consentId}
          locale={locale}
          onCheckedChange={setChecked}
          variant="pay"
        />
        {expired ? (
          <Button type="button" onClick={onExpire}>
            {m.entryPackCheckoutRefreshQuote({}, { locale })}
          </Button>
        ) : (
          <CheckoutPaySubmitButton
            disabled={!checked || busy}
            locale={locale}
            onClick={submitPayment}
            pending={pay.isPending}
            total={price.total}
            variant="pay"
          />
        )}
      </div>
    </CheckoutPayCard>
  );
}
