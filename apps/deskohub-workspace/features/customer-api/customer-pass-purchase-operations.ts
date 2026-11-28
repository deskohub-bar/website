import {
  type BeginCustomerPassPurchase,
  type CustomerPassPayment,
  type CustomerPassPurchase,
  CustomerPassPurchaseRefused,
  type CustomerPassPurchaseStatus,
  type CustomerUnlimitedStartDates,
  type SubmitCustomerPassPurchase,
  type UpdateCustomerPassPurchasePrice,
} from "@deskohub/workspace-customer-api";
import { Effect, Schema } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { updateCustomerProfileSchema } from "@/features/account/contracts";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { Locale } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { HeldPassNotFound } from "@/features/passes/backend/customer-pass-reads";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import { getEntryPackPayPath } from "@/features/passes/entry-pack-checkout";
import { getEntryPackLastUsableDate } from "@/features/passes/pass-offer";
import { unlimitedPassSelectionSchema } from "@/features/passes/unlimited-pass";
import { getUnlimitedPassPayPath } from "@/features/passes/unlimited-pass-checkout";
import { reservationBillingSelectionSchema } from "@/features/reservation/reservation-billing";
import { reservationStatusPath } from "@/features/reservation/routes";
import { plainDateStringSchema } from "@/shared/utils/temporal";

const unavailableDates = (dates: readonly (string | Temporal.PlainDate)[]) =>
  new CustomerPassPurchaseRefused({
    reason: "holds-unavailable",
    blockingDates: dates.map((date) => date.toString()),
  });

export const beginCustomerPassPurchase = Effect.fn(
  "customerApi.beginPassPurchase"
)(function* (input: BeginCustomerPassPurchase) {
  const {
    expectedBuyerAccountId,
    product,
    buyerProfile,
    orderId,
    supersedeOrderId,
    ...details
  } = input;
  if (expectedBuyerAccountId !== undefined) {
    const account = yield* CurrentCustomerAccount;
    const { accountId } = yield* account.requireActive;
    if (accountId !== expectedBuyerAccountId) {
      return yield* new CustomerPassPurchaseRefused({
        reason: "purchase-conflict",
      });
    }
  }
  const selected =
    product.kind === "entry-pack"
      ? product
      : {
          kind: product.kind,
          selection: yield* Schema.decodeUnknownEffect(
            unlimitedPassSelectionSchema
          )(product.selection),
        };
  const profile = buyerProfile
    ? yield* Schema.decodeUnknownEffect(
        updateCustomerProfileSchema(input.locale)
      )(buyerProfile)
    : undefined;
  const passes = yield* CustomerPasses;
  const result: CustomerPassPurchase = yield* passes
    .beginPurchase({
      ...details,
      orderId: orderIdSchema.make(orderId),
      product: selected,
      ...(profile && { buyerProfile: profile }),
      ...(supersedeOrderId && {
        supersedeOrderId: orderIdSchema.make(supersedeOrderId),
      }),
    })
    .pipe(
      Effect.catchTags({
        EntryPackPurchaseError: (error) =>
          error.reason === "payment-in-progress" && error.orderId
            ? Effect.fail(
                new CustomerPassPurchaseRefused({
                  reason: error.reason,
                  orderId: error.orderId,
                })
              )
            : Effect.fail(error),
        UnlimitedPassCapacityUnavailable: ({ blockingDates }) =>
          Effect.fail(unavailableDates(blockingDates)),
        UnlimitedPassDraftVoided: ({ blockingDates }) =>
          Effect.fail(unavailableDates(blockingDates)),
      })
    );
  return result;
});

export const loadCustomerUnlimitedStartDates = Effect.fn(
  "customerApi.getUnlimitedStartDates"
)(function* (query: {
  readonly startsOn?: string;
  readonly supersedeOrderId?: string;
}) {
  const startsOn =
    query.startsOn === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(plainDateStringSchema)(
          query.startsOn
        );
  const supersedeOrderId =
    query.supersedeOrderId && orderIdSchema.make(query.supersedeOrderId);
  const passes = yield* CustomerPasses;
  const dates = yield* passes.purchaseStartDates({
    ...(startsOn && { startsOn }),
    ...(supersedeOrderId && { supersedeOrderId }),
  });
  if (dates.status !== "ready") {
    return yield* new CustomerPassPurchaseRefused({
      reason: "invalid-selection",
    });
  }
  const { today, lastStartDate, starts } = dates;
  const result: CustomerUnlimitedStartDates = { today, lastStartDate, starts };
  return result;
});

export const loadCustomerPassPurchaseStatus = Effect.fn(
  "customerApi.getPassPurchaseStatus"
)(function* (orderId: OrderId, locale: Locale) {
  const passes = yield* CustomerPasses;
  const view = yield* passes.purchaseStatus(orderId);
  if (view.status === "not_found" || view.status === "sign_in") {
    return yield* new HeldPassNotFound({});
  }
  const retry =
    "price" in view &&
    "disclosure" in view &&
    "priorPaymentAttemptId" in view &&
    view.priorPaymentAttemptId
      ? {
          priorPaymentAttemptId: view.priorPaymentAttemptId,
          price: view.price,
          disclosure: view.disclosure,
        }
      : undefined;
  const result: CustomerPassPurchaseStatus = {
    orderId,
    status: view.status,
    productKind: view.entryCount === null ? "unlimited" : "entry-pack",
    tier: view.tier,
    statusPath: `/${locale}${reservationStatusPath}/${orderId}`,
    ...(view.status === "not_started" && {
      resumePath:
        view.entryCount === null
          ? getUnlimitedPassPayPath(locale, orderId)
          : getEntryPackPayPath(locale, orderId),
    }),
    ...(view.status === "pending" &&
      view.paymentPage && { paymentUrl: view.paymentPage }),
    ...("validFrom" in view && { validFrom: view.validFrom }),
    ...("validUntil" in view && {
      lastUsableDate: getEntryPackLastUsableDate(view.validUntil).toString(),
    }),
    ...(view.status === "paid" && { gift: view.gift }),
    ...(retry && { retry }),
  };
  return result;
});

export const updateCustomerPassPurchasePrice = (
  orderId: OrderId,
  input: UpdateCustomerPassPurchasePrice
) =>
  Effect.flatMap(CustomerPasses, (passes) =>
    passes.repricePurchase({ orderId, ...input })
  );

export const submitCustomerPassPurchase = Effect.fn(
  "customerApi.submitPassPurchase"
)(function* (orderId: OrderId, input: SubmitCustomerPassPurchase) {
  const { billing, priorPaymentAttemptId, ...details } = input;
  const selectedBilling = billing
    ? yield* Schema.decodeUnknownEffect(reservationBillingSelectionSchema)(
        billing
      )
    : undefined;
  const passes = yield* CustomerPasses;
  const result: CustomerPassPayment = yield* passes.payPurchase({
    ...details,
    orderId,
    ...(selectedBilling && { billing: selectedBilling }),
    ...(priorPaymentAttemptId && {
      priorPaymentAttemptId: paymentAttemptIdSchema.make(priorPaymentAttemptId),
    }),
  });
  return result;
});
