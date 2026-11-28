import type {
  CustomerPassPurchaseStatus,
  SubmitCustomerPassPurchase,
} from "@deskohub/workspace-customer-api";
import { useAtomSet } from "@effect/atom-react";
import { Cause, Data, Effect, Exit, Option } from "effect";
import type { Atom } from "effect/reactivity";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { apiOrigin } from "../../../auth/auth-client";
import { checkoutReturnTarget } from "../../../booking/checkout/checkout-commands";
import { customerDataRuntime } from "../../../customer-api/customer-data-runtime";
import type { AppLocale } from "../../../i18n/app-locale";
import { m } from "../../../i18n/messages";
import { openSitePage } from "../../../routing/open-site-page";
import { hasPassLegalDocuments } from "../pass-purchase-agreement";
import {
  confirmPassPurchaseScope,
  openPassPaymentAtom,
  submitPassPurchaseAtom,
} from "../pass-purchase-requests";
import {
  type PassPurchaseStatusCheck,
  readPassPurchaseStatus,
} from "./pass-purchase-status-state";

type RetryDetails = NonNullable<CustomerPassPurchaseStatus["retry"]>;

type PurchaseContinuation =
  | { readonly kind: "resume"; readonly path: string }
  | { readonly kind: "reopen"; readonly url: string };

export const availablePassPurchaseContinuation = (
  purchase: CustomerPassPurchaseStatus
): PurchaseContinuation | undefined => {
  if (purchase.status === "not_started" && purchase.resumePath) {
    return { kind: "resume", path: purchase.resumePath };
  }
  if (purchase.status === "pending" && purchase.paymentUrl) {
    return { kind: "reopen", url: purchase.paymentUrl };
  }
  return undefined;
};

export const availablePassPurchaseRetry = (
  purchase: CustomerPassPurchaseStatus
) =>
  purchase.status === "cancelled" ||
  purchase.status === "expired" ||
  purchase.status === "failed"
    ? purchase.retry
    : undefined;

/** The attempt, price, and disclosure approved together on the screen. */
export const passPurchaseRetryKey = ({
  priorPaymentAttemptId,
  price,
  disclosure,
}: RetryDetails) =>
  JSON.stringify([priorPaymentAttemptId, price.fingerprint, disclosure]);

export const confirmedRetryPayload = (
  purchase: CustomerPassPurchaseStatus,
  approved: RetryDetails,
  returnTarget: NonNullable<SubmitCustomerPassPurchase["returnTarget"]>
): SubmitCustomerPassPurchase | undefined => {
  const retry = availablePassPurchaseRetry(purchase);
  if (
    !retry ||
    !hasPassLegalDocuments(retry.disclosure) ||
    passPurchaseRetryKey(approved) !== passPurchaseRetryKey(retry)
  ) {
    return undefined;
  }
  return {
    productKind: purchase.productKind,
    priorPaymentAttemptId: retry.priorPaymentAttemptId,
    displayedPriceFingerprint: retry.price.fingerprint,
    accepted: true,
    acceptedDocuments: retry.disclosure.documents.map(({ key, hash }) => ({
      key,
      hash,
    })),
    ...(purchase.productKind === "unlimited" &&
      retry.disclosure.earlyStartRequest !== undefined && {
        unlimitedEarlyStartAccepted: true,
      }),
    returnTarget,
  };
};

const checkPurchaseAtom = customerDataRuntime.fn(
  ({ orderId, locale }: { orderId: string; locale: AppLocale }) =>
    readPassPurchaseStatus(orderId, locale)
);

class PassPurchaseResumeUnavailable extends Data.TaggedError(
  "PassPurchaseResumeUnavailable"
) {}

export const passPurchaseResumeUrl = (path: string, origin: string) => {
  if (!path.startsWith("/") || path.startsWith("//")) return;
  const workspaceOrigin = new URL(origin).origin;
  const url = new URL(path, workspaceOrigin);
  return url.origin === workspaceOrigin ? url.href : undefined;
};

const resumePassPurchaseAtom = customerDataRuntime.fn(
  ({
    path,
    owns,
    onAndroidOpen,
  }: {
    path: string;
    owns: () => boolean;
    onAndroidOpen: () => void;
  }) =>
    confirmPassPurchaseScope.pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: async () => {
            const url = passPurchaseResumeUrl(path, apiOrigin);
            if (!url) throw new PassPurchaseResumeUnavailable();
            if (!owns()) return;
            if (Platform.OS === "web") {
              globalThis.location.assign(url);
              return "external" as const;
            }
            const android = Platform.OS === "android";
            if (android) onAndroidOpen();
            const browser = await openSitePage(url);
            return android && browser.type === "opened"
              ? ("external" as const)
              : undefined;
          },
          catch: () => new PassPurchaseResumeUnavailable(),
        })
      )
    )
);

type RetryFailure = Atom.Failure<typeof submitPassPurchaseAtom>;

const retryFailureMessage = (
  failure: RetryFailure | undefined,
  locale: AppLocale
) => {
  switch (failure?._tag) {
    case "CustomerPassPurchaseRefused":
      switch (failure.reason) {
        case "payment-in-progress":
          return m.reservations_payment_retry_settling({}, { locale });
        case "consent-required":
          return m.pass_purchase_status_retry_changed({}, { locale });
        case "quote-expired":
          return m.pass_purchase_status_quote_expired({}, { locale });
        case "holds-unavailable":
          return m.pass_purchase_status_hold_unavailable({}, { locale });
        default:
          return m.booking_checkout_retry_service_unavailable({}, { locale });
      }
    case "CustomerPassNotFound":
      return m.pass_purchase_status_not_found({}, { locale });
    case "CustomerRateLimited":
      return m.booking_checkout_retry_rate_limited({}, { locale });
    case "CustomerSessionRequired":
      return m.booking_checkout_retry_session_required({}, { locale });
    default:
      return m.booking_checkout_retry_service_unavailable({}, { locale });
  }
};

/** Act on the current owned order and only while its screen owns the action. */
export function usePassPurchasePayment(
  orderId: string,
  locale: AppLocale,
  checkStatus: (kind: PassPurchaseStatusCheck) => void
) {
  const confirm = useAtomSet(checkPurchaseAtom, { mode: "promiseExit" });
  const submit = useAtomSet(submitPassPurchaseAtom, { mode: "promiseExit" });
  const open = useAtomSet(openPassPaymentAtom, { mode: "promiseExit" });
  const resume = useAtomSet(resumePassPurchaseAtom, { mode: "promiseExit" });
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const focus = useRef<symbol | undefined>(undefined);
  const inFlight = useRef(false);
  const draftReturn = useRef<(() => void) | undefined>(undefined);
  const abandon = useCallback(() => {
    focus.current = undefined;
    draftReturn.current?.();
  }, []);
  useFocusEffect(
    useCallback(() => {
      focus.current = Symbol();
      return abandon;
    }, [abandon])
  );

  const run = async (
    action: (
      purchase: CustomerPassPurchaseStatus,
      owns: () => boolean
    ) => Promise<void>
  ) => {
    const owner = focus.current;
    if (!owner || inFlight.current) return;
    const owns = () => focus.current === owner;
    inFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const current = await confirm({ orderId, locale });
      if (!owns()) return;
      if (Exit.isFailure(current)) {
        checkStatus("manual");
        return;
      }
      await action(current.value, owns);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const browserNotice = () =>
    setNotice(m.booking_checkout_retry_payment_browser({}, { locale }));

  const retry = (approved: RetryDetails) =>
    run(async (purchase, owns) => {
      const payload = confirmedRetryPayload(
        purchase,
        approved,
        checkoutReturnTarget(Platform.OS)
      );
      if (!payload) {
        if (availablePassPurchaseRetry(purchase)) {
          setNotice(m.pass_purchase_status_retry_changed({}, { locale }));
        }
        checkStatus("manual");
        return;
      }
      const payment = await submit({ orderId, payload, owns });
      if (!owns()) return;
      if (Exit.isFailure(payment)) {
        const failure = Option.getOrUndefined(
          Cause.findErrorOption(payment.cause)
        );
        if (failure?._tag === "CustomerWriteUnconfirmed") {
          checkStatus("unconfirmed");
        } else {
          setNotice(retryFailureMessage(failure, locale));
          if (failure?._tag === "CustomerPassPurchaseRefused")
            checkStatus("manual");
        }
        return;
      }
      switch (payment.value.status) {
        case "pricing_changed":
        case "terms_changed":
          setNotice(m.pass_purchase_status_retry_changed({}, { locale }));
          checkStatus("manual");
          return;
        case "hosted": {
          const opened = await open({
            orderId,
            redirectUrl: payment.value.redirectUrl,
            owns,
          });
          if (!owns()) return;
          if (Exit.isFailure(opened)) browserNotice();
          break;
        }
        case "paid":
        case "pending":
          break;
      }
      checkStatus("after-payment");
    });

  const continuePayment = (kind: PurchaseContinuation["kind"]) =>
    run(async (purchase, owns) => {
      const action = availablePassPurchaseContinuation(purchase);
      if (!action || action.kind !== kind) {
        checkStatus("manual");
        return;
      }
      const opened =
        action.kind === "resume"
          ? await resume({
              path: action.path,
              owns,
              onAndroidOpen: () => {
                draftReturn.current?.();
                // Android reports `opened` at launch. Wait until the buyer
                // has left the app and returned before reading the draft.
                let backgrounded = AppState.currentState === "background";
                const subscription = AppState.addEventListener(
                  "change",
                  (state) => {
                    if (state === "background") backgrounded = true;
                    if (state !== "active" || !backgrounded) return;
                    draftReturn.current?.();
                    if (owns()) checkStatus("after-payment");
                  }
                );
                draftReturn.current = () => {
                  subscription.remove();
                  draftReturn.current = undefined;
                };
              },
            })
          : await open({ orderId, redirectUrl: action.url, owns });
      if (!owns()) return;
      if (opened._tag === "Success" && opened.value === "external") return;
      draftReturn.current?.();
      if (opened._tag === "Failure") browserNotice();
      checkStatus("after-payment");
    });

  return { busy, notice, retry, continuePayment, abandon };
}
