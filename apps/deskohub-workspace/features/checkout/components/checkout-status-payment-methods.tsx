"use client";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { useRouter } from "next/navigation";
import type { SafeActionResult } from "next-safe-action";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { type Locale, m } from "@/features/i18n";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import {
  readSessionStorageItem,
  writeSessionStorageItem,
} from "@/shared/browser/session-storage";
import { useClientReady } from "@/shared/browser/use-client-ready";
import { Button } from "@/shared/components/ui/button";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import { CheckoutBanner } from "./checkout-banner";
import { openCheckoutPaymentWindow } from "./checkout-payment-window";
import {
  type CheckoutQrPayment,
  CheckoutQrPaymentDetails,
} from "./checkout-qr-payment-details";
import { CheckoutQrPaymentWait } from "./checkout-qr-payment-wait";
import type { CheckoutPaymentMethod } from "./use-checkout-pay-submission";

type ContinuePaymentInput = {
  readonly locale: Locale;
  readonly method: CheckoutPaymentMethod;
  readonly orderId: WorkspaceReservationId;
};

type ContinuedPayment =
  | { readonly status: "qr_pending" | "unavailable" }
  | { readonly status: "redirect"; readonly redirectUrl: string };

export type ContinueCheckoutPaymentAction = (
  input: ContinuePaymentInput
) => Promise<
  SafeActionResult<
    string,
    StandardSchemaV1<ContinuePaymentInput>,
    unknown,
    ContinuedPayment
  >
>;

export function CheckoutStatusPaymentMethods({
  continuePaymentAction,
  expiresAt,
  headline,
  locale,
  orderId,
  qrWait,
}: {
  readonly continuePaymentAction: ContinueCheckoutPaymentAction;
  readonly expiresAt: string;
  readonly headline: ReactNode;
  readonly locale: Locale;
  readonly orderId: WorkspaceReservationId;
  readonly qrWait?: {
    readonly payment: CheckoutQrPayment;
    readonly supportHref: string;
  };
}) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const expiration = Date.parse(expiresAt);
  const expired = useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        const timer = setTimeout(changed, Math.max(0, expiration - Date.now()));
        document.addEventListener("visibilitychange", changed);
        window.addEventListener("pageshow", changed);
        return () => {
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", changed);
          window.removeEventListener("pageshow", changed);
        };
      },
      [expiration]
    ),
    () => Date.now() >= expiration,
    () => false
  );
  const hasQrPayment = !!qrWait;
  const ready = useClientReady();
  const waitKey = `deskohub:checkout-qr-wait:${orderId}:${expiresAt}`;
  const [localWait, setLocalWait] = useState<{
    readonly key: string;
    readonly startedAt: number;
  }>();
  const storedStartedAt =
    ready && hasQrPayment && !expired
      ? Number(readSessionStorageItem(waitKey))
      : 0;
  const startedAt =
    localWait?.key === waitKey ? localWait.startedAt : storedStartedAt;
  const qrDetails = useRef<HTMLElement>(null);
  const focusQrDetails = useRef(false);
  const focusWaitHeading = useRef(false);
  const waitHeadingRef = useCallback((heading: HTMLHeadingElement | null) => {
    if (heading && focusWaitHeading.current) {
      focusWaitHeading.current = false;
      heading.focus();
    }
  }, []);
  useEffect(() => {
    if (hasQrPayment && focusQrDetails.current) {
      focusQrDetails.current = false;
      qrDetails.current?.focus();
    }
  }, [hasQrPayment]);
  const showError = (message?: string) =>
    setErrorMessage(message ?? m.checkoutPaySubmitError({}, { locale }));
  const { execute, isExecuting } = useWorkspaceAction<
    string,
    StandardSchemaV1<ContinuePaymentInput>,
    unknown,
    ContinuedPayment
  >(continuePaymentAction, {
    onSuccess: ({ data }) => {
      if (!data) {
        showError();
        return;
      }
      if (data.status === "redirect" && Date.now() < expiration) {
        // The current status page already owns the provider tab's return.
        if (!openCheckoutPaymentWindow(data.redirectUrl))
          router.push(data.redirectUrl);
        return;
      }
      focusQrDetails.current = data.status === "qr_pending";
      startRefresh(() => router.refresh());
    },
    onError: ({ error }) => showError(error.serverError),
    onTransportError: () => showError(),
  });
  const pending = isExecuting || refreshing;
  const continueWith = (method: CheckoutPaymentMethod) => {
    if (pending || Date.now() >= expiration) return;
    setErrorMessage(null);
    execute({ locale, method, orderId });
  };

  if (expired) return headline;
  if (
    qrWait &&
    Number.isSafeInteger(startedAt) &&
    startedAt > 0 &&
    startedAt < expiration
  ) {
    return (
      <CheckoutQrPaymentWait
        headingRef={waitHeadingRef}
        key={waitKey}
        locale={locale}
        payment={qrWait.payment}
        startedAt={startedAt}
        supportHref={qrWait.supportHref}
      />
    );
  }

  const startWaiting = () => {
    const now = Date.now();
    if (pending || now >= expiration) return;
    writeSessionStorageItem(waitKey, String(now));
    focusWaitHeading.current = true;
    setLocalWait({ key: waitKey, startedAt: now });
  };

  return (
    <>
      {headline}
      <div className="mt-6 space-y-4">
        {qrWait && (
          <section
            aria-label={m.checkoutPayMethodQr({}, { locale })}
            ref={qrDetails}
            tabIndex={-1}
          >
            <CheckoutQrPaymentDetails
              locale={locale}
              payment={qrWait.payment}
            />
          </section>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            disabled={pending}
            onClick={qrWait ? startWaiting : () => continueWith("qr")}
            size="lg"
            type="button"
            wrap={hasQrPayment}
          >
            {qrWait
              ? m.checkoutQrPaymentSent({}, { locale })
              : m.checkoutQrShow({}, { locale })}
          </Button>
          <Button
            disabled={pending}
            onClick={() => continueWith("card")}
            size="lg"
            type="button"
            tone="outline"
            variant="ghost"
            wrap={hasQrPayment}
          >
            {qrWait
              ? m.checkoutQrSwitchToCardPayment({}, { locale })
              : m.checkoutQrSwitchToCard({}, { locale })}
          </Button>
        </div>
        <div role="alert">
          {errorMessage && (
            <CheckoutBanner live={false}>{errorMessage}</CheckoutBanner>
          )}
        </div>
      </div>
    </>
  );
}
