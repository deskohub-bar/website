"use client";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { useRouter } from "next/navigation";
import type { SafeActionResult } from "next-safe-action";
import { useState } from "react";
import { openCheckoutPaymentWindow } from "@/features/checkout/components/checkout-payment-window";
import { type Locale, m } from "@/features/i18n";
import { submitReservation } from "@/features/reservation/actions/submit-reservation";
import type { SubmitReservationInput } from "@/features/reservation/actions/submit-reservation-input";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";

type HostedSubmission = NonNullable<
  Awaited<ReturnType<typeof submitReservation>>
>["data"];

export type CheckoutPaymentMethod = "card" | "qr";

type PaySubmissionInput = SubmitReservationInput & {
  readonly method?: CheckoutPaymentMethod;
};

type SubmittedReservation =
  | HostedSubmission
  | {
      readonly status: "qr_pending";
      readonly statusUrl: string;
    };

export type StartCheckoutPaymentAction = (
  input: SubmitReservationInput & { readonly method: CheckoutPaymentMethod }
) => Promise<
  SafeActionResult<
    string,
    StandardSchemaV1<PaySubmissionInput>,
    unknown,
    Exclude<SubmittedReservation, undefined>
  >
>;

/**
 * Continues a submitted reservation and returns where this tab goes next: the
 * fresh Pay page after a price change, the status page once the gateway opens
 * in a new tab, or the gateway itself. Returns undefined when the submission
 * can't continue.
 */
const continueSubmittedReservation = (
  data: SubmittedReservation
): string | undefined => {
  if (!data) return undefined;
  if (data.status === "qr_pending") return data.statusUrl;
  if (data.status === "pricing_changed") return data.freshPayUrl;
  if (data.status === "in_progress" || !data.redirectUrl) return undefined;

  return data.statusUrl &&
    openCheckoutPaymentWindow(data.redirectUrl, data.statusUrl)
    ? data.statusUrl
    : data.redirectUrl;
};

/**
 * The Pay page's reservation submission: the customer's legal consent, the
 * pending state while the checkout starts or redirects, and the error the
 * page shows when it can't.
 */
export function useCheckoutPaySubmission({
  earlyPerformanceRequestRequired,
  locale,
  payStateToken,
  startPaymentAction,
}: {
  readonly earlyPerformanceRequestRequired: boolean;
  readonly locale: Locale;
  readonly payStateToken: string | undefined;
  readonly startPaymentAction?: StartCheckoutPaymentAction;
}) {
  const router = useRouter();
  const [legalConsent, setLegalConsent] = useState(false);
  const [submittedMethod, setSubmittedMethod] =
    useState<CheckoutPaymentMethod>("card");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const showSubmitError = () =>
    setErrorMessage(m.checkoutPaySubmitError({}, { locale }));
  const { execute, isExecuting, result } = useWorkspaceAction<
    string,
    StandardSchemaV1<PaySubmissionInput>,
    unknown,
    Exclude<SubmittedReservation, undefined>
  >(
    async ({ method, ...input }) =>
      startPaymentAction && method
        ? startPaymentAction({ ...input, method })
        : submitReservation(input),
    {
      onSuccess: ({ data }) => {
        const nextUrl = continueSubmittedReservation(data);
        if (nextUrl === undefined) {
          showSubmitError();
          return;
        }
        router.push(nextUrl);
      },
      onError: ({ error }) => {
        setErrorMessage(
          error.serverError || m.checkoutPaySubmitError({}, { locale })
        );
      },
      onTransportError: showSubmitError,
    }
  );
  const hasCheckoutRedirect =
    result.data?.status === "pricing_changed" ||
    result.data?.status === "qr_pending" ||
    result.data?.status === "redirect";
  const isSubmitPending = isExecuting || hasCheckoutRedirect;

  const submit = (method: CheckoutPaymentMethod) => {
    if (!legalConsent || isSubmitPending) return;

    setErrorMessage(null);
    if (!payStateToken) {
      showSubmitError();
      return;
    }

    setSubmittedMethod(method);
    const input = {
      locale,
      payStateToken,
      legalConsent,
      ...(startPaymentAction && { method }),
    };
    execute(
      earlyPerformanceRequestRequired
        ? { ...input, earlyPerformanceConsent: legalConsent }
        : input
    );
  };

  return {
    errorMessage,
    isSubmitPending,
    legalConsent,
    pendingMethod: isSubmitPending ? submittedMethod : undefined,
    setLegalConsent,
    submit,
  };
}
