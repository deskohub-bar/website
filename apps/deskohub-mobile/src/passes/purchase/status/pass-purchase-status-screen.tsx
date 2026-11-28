import type { CustomerPassPurchaseStatus } from "@deskohub/workspace-customer-api";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option, Result } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useState } from "react";
import { toCustomerViewError } from "../../../customer-api/customer-view-error";
import { sharedViewErrorMessage } from "../../../customer-api/customer-view-error-message";
import type { AppLocale } from "../../../i18n/app-locale";
import { useAppLocale } from "../../../i18n/locale-context";
import { m } from "../../../i18n/messages";
import { formatMoney } from "../../../i18n/money-format";
import { LoadingState, RefreshingIndicator } from "../../../ui/async-states";
import { Card } from "../../../ui/card";
import { Button } from "../../../ui/controls";
import { useLiveRegionAnnouncement } from "../../../ui/live-announcement";
import { Notice } from "../../../ui/notice";
import { ScrollScreen } from "../../../ui/scroll-screen";
import { Text } from "../../../ui/text";
import {
  hasPassLegalDocuments,
  PassPurchaseAgreement,
} from "../pass-purchase-agreement";
import { makePassPurchaseStatusAtoms } from "./pass-purchase-status-state";
import {
  availablePassPurchaseContinuation,
  availablePassPurchaseRetry,
  passPurchaseRetryKey,
  usePassPurchasePayment,
} from "./use-pass-purchase-payment";

const statusTitle = (
  purchase: CustomerPassPurchaseStatus,
  locale: AppLocale
) =>
  purchase.status === "paid" && purchase.gift
    ? m.pass_purchase_status_gift_paid({}, { locale })
    : {
        not_started: m.pass_purchase_status_not_started,
        pending: m.pass_purchase_status_pending,
        checking: m.pass_purchase_status_checking,
        paid: m.pass_purchase_status_paid,
        cancelled: m.pass_purchase_status_cancelled,
        expired: m.pass_purchase_status_expired,
        failed: m.pass_purchase_status_failed,
        refund_required: m.pass_purchase_status_refund_required,
        refunded: m.pass_purchase_status_refunded,
        partially_refunded: m.pass_purchase_status_partially_refunded,
        granted: m.pass_purchase_status_granted,
        grant_cancelled: m.pass_purchase_status_grant_cancelled,
      }[purchase.status]({}, { locale });

export function PassPurchaseStatusScreen({
  orderId,
  afterPayment,
  onClose,
}: {
  readonly orderId: string;
  readonly afterPayment: boolean;
  readonly onClose: () => void;
}) {
  const locale = useAppLocale();
  const [atoms] = useState(() =>
    makePassPurchaseStatusAtoms(orderId, locale, afterPayment)
  );
  const focused = useIsFocused();
  const setFocused = useAtomSet(atoms.focused);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [setFocused])
  );
  const progress = useAtomValue(atoms.status);
  const requestRefresh = useAtomSet(atoms.refresh);
  const payment = usePassPurchasePayment(orderId, locale, (kind) => {
    requestRefresh(({ revision }) => ({
      revision: revision + 1,
      kind,
    }));
  });
  const shown = Option.getOrUndefined(AsyncResult.value(progress));
  const outcome = shown?.outcome;
  const reading = shown?.reading ?? false;
  const confirmed = shown?.confirmed;
  const purchase =
    outcome && Result.isSuccess(outcome) ? outcome.success : undefined;
  const retry = confirmed && availablePassPurchaseRetry(confirmed);
  const continuation =
    confirmed && availablePassPurchaseContinuation(confirmed);
  const failure =
    outcome && Result.isFailure(outcome) ? outcome.failure : undefined;
  const title = confirmed && statusTitle(confirmed, locale);
  const unconfirmedNotice =
    shown?.unconfirmed && confirmed?.status !== "checking"
      ? m.pass_purchase_status_checking({}, { locale })
      : undefined;
  const paymentNotice =
    confirmed?.status === "paid" ? undefined : payment.notice;
  useLiveRegionAnnouncement(focused ? title : undefined, "polite");

  let message: string | undefined;
  if (failure) {
    switch (failure._tag) {
      case "CustomerPassNotFound":
        message = m.pass_purchase_status_not_found({}, { locale });
        break;
      case "CustomerPassesUnavailable":
      case "CustomerPassPurchaseRefused":
        message = m.account_error_unexpected({}, { locale });
        break;
      default:
        message = sharedViewErrorMessage(toCustomerViewError(failure), locale);
    }
  }
  const refresh = () => {
    if (!focused || !shown || reading || payment.busy) return;
    requestRefresh((current) =>
      current.revision === shown.refresh
        ? { revision: current.revision + 1, kind: "manual" }
        : current
    );
  };

  return (
    <ScrollScreen contentWidth="form">
      {outcome === undefined &&
        !confirmed &&
        !AsyncResult.isFailure(progress) && (
          <LoadingState label={m.account_loading({}, { locale })} />
        )}
      <Notice
        tone="error"
        message={
          message ??
          (failure || AsyncResult.isFailure(progress)
            ? m.account_error_unexpected({}, { locale })
            : undefined)
        }
      />
      <Notice tone="warning" message={unconfirmedNotice ?? paymentNotice} />
      <RefreshingIndicator
        refreshing={confirmed !== undefined && reading === "manual"}
        label={m.account_refreshing({}, { locale })}
      />
      {title !== undefined && (
        <Card>
          <Text
            variant="title"
            role="status"
            aria-live="polite"
            accessibilityLiveRegion="polite"
          >
            {title}
          </Text>
        </Card>
      )}
      {(outcome || confirmed) && failure?._tag !== "CustomerPassNotFound" && (
        <Button
          variant="secondary"
          label={m.pass_purchase_status_check_again({}, { locale })}
          onPress={refresh}
          disabled={Boolean(reading) || payment.busy}
        />
      )}
      {retry && (
        <RetryConsent
          key={passPurchaseRetryKey(retry)}
          retry={retry}
          locale={locale}
          busy={payment.busy}
          disabled={!purchase}
          onPay={payment.retry}
        />
      )}
      {continuation && (
        <Button
          label={
            continuation.kind === "resume"
              ? m.booking_continue({}, { locale })
              : m.booking_checkout_payment_reopen({}, { locale })
          }
          busy={payment.busy}
          disabled={!purchase}
          onPress={() => void payment.continuePayment(continuation.kind)}
        />
      )}
      <Button
        label={m.pass_purchase_status_done({}, { locale })}
        variant="quiet"
        onPress={() => {
          payment.abandon();
          onClose();
        }}
      />
    </ScrollScreen>
  );
}

function RetryConsent({
  retry,
  locale,
  busy,
  disabled,
  onPay,
}: {
  readonly retry: NonNullable<CustomerPassPurchaseStatus["retry"]>;
  readonly locale: AppLocale;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPay: (
    retry: NonNullable<CustomerPassPurchaseStatus["retry"]>
  ) => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const canPay = checked && hasPassLegalDocuments(retry.disclosure);
  return (
    <>
      <Card>
        <PassPurchaseAgreement
          disclosure={retry.disclosure}
          checked={checked}
          disabled={busy || disabled}
          onToggle={() => setChecked((previous) => !previous)}
          locale={locale}
        />
      </Card>
      <Button
        label={m.booking_checkout_pay(
          { amount: formatMoney(retry.price.total, locale) },
          { locale }
        )}
        busy={busy}
        disabled={disabled || (!busy && !canPay)}
        onPress={() => {
          if (!canPay) return;
          setChecked(false);
          void onPay(retry);
        }}
      />
    </>
  );
}
