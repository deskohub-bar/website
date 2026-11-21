"use client";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { useRouter } from "next/navigation";
import type { SafeActionResult } from "next-safe-action";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { type Locale, m } from "@/features/i18n";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { Button } from "@/shared/components/ui/button";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import { CheckoutBanner } from "./checkout-banner";
import { openCheckoutPaymentWindow } from "./checkout-payment-window";
import {
  type CheckoutQrPayment,
  CheckoutQrPaymentDetails,
} from "./checkout-qr-payment-details";
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
  locale,
  orderId,
  qrPayment,
}: {
  readonly continuePaymentAction: ContinueCheckoutPaymentAction;
  readonly expiresAt: string;
  readonly locale: Locale;
  readonly orderId: WorkspaceReservationId;
  readonly qrPayment?: CheckoutQrPayment;
}) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const expiration = Date.parse(expiresAt);
  const expired = useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        const timer = setTimeout(changed, Math.max(0, expiration - Date.now()));
        return () => clearTimeout(timer);
      },
      [expiration]
    ),
    () => Date.now() >= expiration,
    () => false
  );
  const qrDetails = useRef<HTMLElement>(null);
  const focusQrDetails = useRef(false);
  useEffect(() => {
    if (qrPayment && focusQrDetails.current) {
      focusQrDetails.current = false;
      qrDetails.current?.focus();
    }
  }, [qrPayment]);
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

  if (expired) return null;

  return (
    <div className="mt-6 space-y-4">
      {qrPayment && (
        <section
          aria-label={m.checkoutPayMethodQr({}, { locale })}
          ref={qrDetails}
          tabIndex={-1}
        >
          <CheckoutQrPaymentDetails locale={locale} payment={qrPayment} />
        </section>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        {!qrPayment && (
          <Button
            disabled={pending}
            onClick={() => continueWith("qr")}
            size="lg"
            type="button"
          >
            {m.checkoutQrShow({}, { locale })}
          </Button>
        )}
        <Button
          disabled={pending}
          onClick={() => continueWith("card")}
          size="lg"
          type="button"
          tone="outline"
          variant="ghost"
        >
          {m.checkoutQrSwitchToCard({}, { locale })}
        </Button>
      </div>
      <div role="alert">
        {errorMessage && (
          <CheckoutBanner live={false}>{errorMessage}</CheckoutBanner>
        )}
      </div>
    </div>
  );
}
