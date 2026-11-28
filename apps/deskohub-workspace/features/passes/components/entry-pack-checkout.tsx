"use client";

import { useRef, useState } from "react";
import { getAccountSignInPath } from "@/features/account/routes";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import {
  CheckoutFlowLayout,
  CheckoutSteps,
} from "@/features/checkout/components/checkout-flow-layout";
import { type Locale, m } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  defaultReservationBillingSelection,
  type ReservationBillingSelection,
} from "@/features/reservation/reservation-billing";
import { reservationStatusPath } from "@/features/reservation/routes";
import {
  getEntryPackDetailsPath,
  getEntryPackPayPath,
} from "../entry-pack-checkout";
import { beginEntryPackCheckout } from "../entry-pack-checkout-actions";
import type { EntryPackProduct, EntryPackSize } from "../pass-offer";
import type {
  PassPurchaseBuyer,
  passPurchaseDetailsSchema,
} from "../pass-purchase-details";
import { getPassCheckoutHandoffPath } from "../routes";
import { EntryPackChoose } from "./entry-pack-choose";
import { EntryPackDetails } from "./entry-pack-details";
import { EntryPackPay } from "./entry-pack-pay";

type Step = "choose" | "details" | "pay";
const checkoutStage = {
  choose: "chooseSpace",
  details: "contact",
  pay: "pay",
} as const;
type DetailsSchema = ReturnType<typeof passPurchaseDetailsSchema>;
type CheckoutResult = Awaited<
  ReturnType<typeof beginEntryPackCheckout>
>["data"];

export type EntryPackPayState = Extract<CheckoutResult, { status: "ready" }> & {
  readonly priorPaymentAttemptId?: PaymentAttemptId;
  readonly billing: ReservationBillingSelection;
  readonly holderEmail?: string;
};

export function EntryPackCheckout({
  buyer,
  locale,
  initialProduct,
  initialStep,
  validity,
  discountCodeEntryEnabled,
  continuation,
  initialPayment,
}: {
  readonly buyer: PassPurchaseBuyer;
  readonly locale: Locale;
  readonly initialProduct: EntryPackProduct;
  readonly initialStep: Exclude<Step, "pay">;
  readonly validity: Partial<Record<EntryPackSize, string>>;
  readonly discountCodeEntryEnabled: boolean;
  readonly continuation?: {
    readonly orderId: OrderId;
    readonly holderEmail?: string;
    readonly validUntil?: string;
    readonly handoffToken?: string;
  };
  readonly initialPayment?: {
    readonly orderId: OrderId;
    readonly state: EntryPackPayState;
  };
}) {
  const retryingPayment =
    initialPayment?.state.priorPaymentAttemptId !== undefined;
  const [product, setProduct] = useState(initialProduct);
  const [savedOrderId, setSavedOrderId] = useState(continuation?.orderId);
  const [confirmedValidity, setConfirmedValidity] = useState(
    continuation?.validUntil
  );
  const displayedValidity = confirmedValidity
    ? { ...validity, [product.size]: confirmedValidity }
    : validity;
  const [step, setStep] = useState<Step>(initialPayment ? "pay" : initialStep);
  const [details, setDetails] = useState<DetailsSchema["Encoded"] | undefined>(
    continuation?.holderEmail === undefined
      ? undefined
      : {
          holderEmail: continuation.holderEmail,
          billing: defaultReservationBillingSelection,
        }
  );
  const [payment, setPayment] = useState<
    | {
        orderId: OrderId;
        state: EntryPackPayState;
      }
    | undefined
  >(initialPayment);
  const [error, setError] = useState<string>();
  const [paymentRequested, setPaymentRequested] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailsRevision = useRef(0);
  const attempt = useRef<{ orderId: OrderId; holderEmail?: string }>(
    continuation
  );

  const moveTo = (next: Step) => {
    detailsRevision.current += 1;
    setError(undefined);
    setStep(next);
    // Focus the next heading after React commits the selected step.
    requestAnimationFrame(() => heading.current?.focus());
  };

  const submitDetails = async (values: DetailsSchema["Type"]) => {
    if (buyer.kind !== "linked" && buyer.kind !== "profile-required") return;
    setError(undefined);
    const holderEmail =
      values.holderEmail?.toLowerCase() === buyer.email.toLowerCase()
        ? undefined
        : values.holderEmail;
    if (!attempt.current || attempt.current.holderEmail !== holderEmail) {
      attempt.current = {
        orderId: orderIdSchema.make(crypto.randomUUID()),
        ...(holderEmail !== undefined && { holderEmail }),
      };
    }
    const { orderId } = attempt.current;
    const handoffToken =
      !payment && continuation?.orderId === orderId
        ? continuation.handoffToken
        : undefined;
    const revision = ++detailsRevision.current;
    try {
      const result = await beginEntryPackCheckout({
        orderId,
        product,
        locale,
        buyerEmail: buyer.email,
        ...(handoffToken && { handoffToken }),
        ...(holderEmail !== undefined && { holderEmail }),
        ...(values.buyerProfile !== undefined && {
          buyerProfile: values.buyerProfile,
        }),
      });
      if (detailsRevision.current !== revision) return;
      if (result.data?.status === "signed_out") {
        window.location.assign(
          getAccountSignInPath(
            locale,
            handoffToken
              ? getPassCheckoutHandoffPath(locale, "entry-pack", handoffToken)
              : getEntryPackDetailsPath(
                  locale,
                  product,
                  savedOrderId === orderId ? savedOrderId : undefined
                )
          )
        );
        return;
      }
      if (result.data?.status === "status") {
        window.location.assign(result.data.statusPath);
        return;
      }
      if (result.data?.status === "ready") {
        window.history.replaceState(
          null,
          "",
          getEntryPackDetailsPath(locale, result.data.product, orderId)
        );
        setSavedOrderId(orderId);
        setDetails(values);
        setConfirmedValidity(result.data.lastUsableDate);
        setPaymentRequested(false);
        setPayment({
          orderId,
          state: {
            ...result.data,
            billing: values.billing,
            ...(holderEmail !== undefined && { holderEmail }),
          },
        });
        moveTo("pay");
        return;
      }
      setError(
        result.serverError ?? m.actionFailedUnexpectedly({}, { locale })
      );
    } catch {
      if (detailsRevision.current === revision) {
        setError(m.actionFailedUnexpectedly({}, { locale }));
      }
    }
  };

  const stage = checkoutStage[step];
  return (
    <CheckoutFlowLayout
      activeStepKey={stage}
      locale={locale}
      steps={
        <CheckoutSteps
          activeStepKey={stage}
          label={m.entryPackCheckoutSteps({}, { locale })}
          labels={{
            chooseSpace: m.entryPackCheckoutChoose({}, { locale }),
            contact: m.entryPackCheckoutDetails({}, { locale }),
          }}
          locale={locale}
          stepLinks={{
            ...(step === "details" && {
              chooseSpace: { onSelect: () => moveTo("choose") },
            }),
            ...(step === "pay" &&
              !retryingPayment &&
              !paymentRequested && {
                contact: {
                  onSelect: () => {
                    if (initialPayment && payment) {
                      window.history.replaceState(
                        null,
                        "",
                        getEntryPackDetailsPath(
                          locale,
                          product,
                          payment.orderId
                        )
                      );
                    }
                    moveTo("details");
                  },
                },
              }),
          }}
        />
      }
    >
      {step !== "pay" && (
        <h1
          className="text-4xl leading-tight text-balance sm:text-5xl"
          ref={heading}
          tabIndex={-1}
        >
          {m.entryPackCheckoutTitle({}, { locale })}
        </h1>
      )}
      {step === "choose" && (
        <EntryPackChoose
          locale={locale}
          product={product}
          validity={displayedValidity}
          onChange={(next) => {
            attempt.current = undefined;
            setSavedOrderId(undefined);
            setConfirmedValidity(undefined);
            window.history.replaceState(
              null,
              "",
              getEntryPackDetailsPath(locale, next)
            );
            setProduct(next);
          }}
          onContinue={() => moveTo("details")}
        />
      )}
      {step === "details" && (
        <EntryPackDetails
          buyer={buyer}
          locale={locale}
          product={product}
          validUntil={displayedValidity[product.size]}
          initialValues={details}
          orderId={savedOrderId}
          error={error}
          onChangeSelection={() => moveTo("choose")}
          onSubmit={submitDetails}
        />
      )}
      {step === "pay" && payment && (
        <EntryPackPay
          locale={locale}
          orderId={payment.orderId}
          state={payment.state}
          discountCodeEntryEnabled={
            discountCodeEntryEnabled && !retryingPayment
          }
          continuationPath={
            initialPayment
              ? getEntryPackPayPath(locale, payment.orderId)
              : undefined
          }
          headingRef={heading}
          onRequestPayment={() => setPaymentRequested(true)}
          onExpire={() => {
            if (retryingPayment) {
              window.location.replace(
                `/${locale}${reservationStatusPath}/${payment.orderId}`
              );
              return;
            }
            attempt.current = undefined;
            setSavedOrderId(undefined);
            setConfirmedValidity(undefined);
            window.history.replaceState(
              null,
              "",
              getEntryPackDetailsPath(locale, product)
            );
            moveTo("details");
          }}
        />
      )}
    </CheckoutFlowLayout>
  );
}
