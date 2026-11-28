import "server-only";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { discountApplications, orders, passPurchases } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import {
  ensurePassHolderAccount,
  findPassHolderAccount,
  findPurchaseLoginEmail,
} from "@/features/account/backend/customer-account-by-email";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { CustomerProfileSave } from "@/features/account/contracts";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { workspaceAccountingSupplier } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { getPaymentReturnDestination } from "@/features/checkout/backend/checkout/payment-return-destination";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { startPaymentSession } from "@/features/checkout/backend/payment/payment-session";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { PaymentReturnTarget } from "@/features/checkout/payment-return-target";
import {
  getAppliedPromotionDiscountId,
  getDiscountCommitmentPayload,
} from "@/features/discounts/commitment";
import type { CanonicalPromotionCode } from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { type Locale, m } from "@/features/i18n";
import {
  getPaymentSubmitLegalDocuments,
  getPaymentSubmitLegalEvidence,
  isCurrentPaymentSubmitLegalAcceptance,
} from "@/features/legal/payment-submit-evidence";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import {
  defaultReservationBillingSelection,
  getReservationInvoiceBuyer,
  type ReservationBillingSelection,
  reservationBillingSelectionSchema,
} from "@/features/reservation/reservation-billing";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { reservationStatusPath } from "@/features/reservation/routes";
import { moneyWithValue } from "@/shared/money/money";
import { currentInstant } from "@/shared/utils/temporal";
import type { EntryPackCheckoutPrice } from "../entry-pack-checkout";
import {
  type EntryPackProduct,
  getEntryPackPrice,
  getUnlimitedPassPrice,
  isEntryPackQuoteExpired,
  unlimitedPassCoffeePrice,
} from "../pass-offer";
import {
  type PassPurchaseQuote,
  passPurchaseQuoteCodec,
  withPassPurchaseCoffee,
} from "../pass-purchase-quote";
import { unlimitedPassRequiresEarlyStart } from "../unlimited-pass";
import {
  findOwnedEntryPackOrder,
  findOwnedPassPurchaseOrder,
} from "./entry-pack-order";
import {
  isStaleEntryPackPaymentApproval,
  isUnlimitedPassFirstDayAdmissionExpired,
} from "./entry-pack-order-payment-handler";
import { quoteEntryPack } from "./entry-pack-quote";
import {
  hasPassQuoteExpired,
  hasUnlimitedPassFirstDayEnded,
} from "./entry-pack-settlement";
import { reconfirmUnlimitedPassHolds } from "./unlimited-pass-holds";

export class EntryPackPurchaseError extends Data.TaggedError(
  "EntryPackPurchaseError"
)<{
  readonly reason:
    | "unavailable"
    | "buyer-profile-required"
    | "holder-unavailable"
    | "purchase-conflict"
    | "consent-required"
    | "terms-changed"
    | "quote-expired"
    | "payment-in-progress"
    | "holds-unavailable"
    | "billing-changed";
  readonly locale?: Locale;
  readonly earlyStartRequired?: boolean;
  readonly orderId?: OrderId;
}> {}

const decodeBilling = Schema.decodeEffect(reservationBillingSelectionSchema, {
  onExcessProperty: "error",
});
const billingMatches = Schema.toEquivalence(reservationBillingSelectionSchema);

const catalogCoffeeAmountMinor = (unlimitedCoffee?: boolean | null) =>
  unlimitedCoffee ? unlimitedPassCoffeePrice.value : null;

/** The terms of a price the buyer has seen, independent of labels and timers. */
export const getPassPurchasePriceFingerprint = (
  quote: PassPurchaseQuote,
  coffeeAmountMinor = catalogCoffeeAmountMinor(quote.unlimitedCoffee)
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        quote.discountableSubtotal,
        quote.discountedSubtotal,
        quote.discounts.map(({ discount, amount }) => [discount.id, amount]),
        quote.selection?.submittedCode,
        quote.selection?.referralCode,
        ...(coffeeAmountMinor === null ? [] : [coffeeAmountMinor]),
      ])
    )
    .digest("hex");

export const displayPassPurchasePrice = (
  quote: PassPurchaseQuote,
  coffeeAmountMinor = catalogCoffeeAmountMinor(quote.unlimitedCoffee)
): EntryPackCheckoutPrice => ({
  fingerprint: getPassPurchasePriceFingerprint(quote, coffeeAmountMinor),
  subtotal: withPassPurchaseCoffee(
    quote.discountableSubtotal,
    coffeeAmountMinor
  ),
  total: withPassPurchaseCoffee(quote.discountedSubtotal, coffeeAmountMinor),
  ...(coffeeAmountMinor !== null && {
    coffeePrice: moneyWithValue(coffeeAmountMinor, quote.discountedSubtotal),
  }),
  ...(quote.selection?.submittedCode !== undefined &&
    quote.discounts.some(
      ({ discount }) => discount.id === quote.submittedCodeDiscountId
    ) && { appliedDiscountCode: quote.selection.submittedCode }),
  discounts: quote.discounts.map(({ discount, amount }) => ({
    id: discount.id,
    label: discount.label,
    amount,
  })),
});

export const requirePassPurchasesEnabled = Effect.fn(
  "requirePassPurchasesEnabled"
)(function* () {
  const flags = yield* WorkspaceFeatureFlagService;
  if (!(yield* flags.isEnabled("cowork_passes"))) {
    return yield* new EntryPackPurchaseError({ reason: "unavailable" });
  }
});

const readPurchase = Effect.fn("readEntryPackPurchase")(function* (
  id: OrderId
) {
  const { db } = yield* WorkspaceDatabase;
  const [purchase] = yield* db
    .select()
    .from(passPurchases)
    .where(eq(passPurchases.id, id));
  if (purchase?.product === "entry-pack" && purchase.entryCount !== null) {
    return { ...purchase, entryCount: purchase.entryCount };
  }
});

const verifyRetry = Effect.fn("verifyEntryPackPurchaseRetry")(function* (
  purchase: typeof passPurchases.$inferSelect,
  input: {
    readonly buyerAccountId: CustomerAccountId;
    readonly product: EntryPackProduct;
    readonly holderEmail: string | null;
  }
) {
  if (
    purchase.product !== "entry-pack" ||
    purchase.entryCount === null ||
    purchase.buyerAccountId !== input.buyerAccountId ||
    purchase.tier !== input.product.tier ||
    purchase.entryCount !== input.product.size
  ) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  const holderAccountId =
    input.holderEmail === null
      ? input.buyerAccountId
      : yield* findPassHolderAccount(input.holderEmail);
  if (purchase.holderAccountId !== holderAccountId) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  return { ...purchase, entryCount: purchase.entryCount };
});

/** Continue creates the order and pending pack in one transaction. Reuse its ID on retry. */
export const beginEntryPackPurchase = Effect.fn("beginEntryPackPurchase")(
  function* (input: {
    readonly orderId: OrderId;
    readonly product: EntryPackProduct;
    readonly locale: Locale;
    readonly holderEmail?: string;
    readonly buyerProfile?: CustomerProfileSave;
    readonly submittedCode?: CanonicalPromotionCode;
    readonly referralCode?: CanonicalPromotionCode;
  }) {
    yield* requirePassPurchasesEnabled();
    const current = yield* CurrentCustomerAccount;
    const session = yield* current.requireActive;
    const accounts = yield* CustomerAccountSections;
    const { db, transaction } = yield* WorkspaceDatabase;
    const contacts = yield* CustomerAccountContactService;
    const holderEmail =
      input.holderEmail === undefined
        ? null
        : yield* Schema.decodeUnknownEffect(reservationCustomerEmailSchema)(
            input.holderEmail
          );
    const giftEmail =
      holderEmail?.toLowerCase() === session.email.toLowerCase()
        ? null
        : holderEmail;
    const retry = {
      buyerAccountId: session.accountId,
      product: input.product,
      holderEmail: giftEmail,
    };

    return yield* accounts.withActiveAccount(
      session.accountId,
      Effect.gen(function* () {
        const existing = yield* readPurchase(input.orderId);
        if (existing) return yield* verifyRetry(existing, retry);

        const standing = yield* current.peek;
        let dotyposCustomerId: DotyposCustomerId | undefined;
        if (standing.kind === "linked") {
          dotyposCustomerId = standing.account.dotyposCustomerId;
        } else if (standing.kind === "unlinked" && input.buyerProfile) {
          const contact = yield* contacts.completeProfile(
            session,
            input.buyerProfile
          );
          dotyposCustomerId = contact?.dotyposCustomerId;
        } else if (standing.kind === "unavailable") {
          return yield* standing.failure;
        }
        if (!dotyposCustomerId) {
          return yield* new EntryPackPurchaseError({
            reason: "buyer-profile-required",
          });
        }

        const purchasedAt = yield* currentInstant;
        const { quote, validFrom, validUntil } = yield* quoteEntryPack({
          ...input,
          buyer: dotyposCustomerId,
          purchasedAt,
        });
        const acceptedQuote = yield* Schema.encodeEffect(
          passPurchaseQuoteCodec
        )({
          ...quote,
          selection: {
            ...(input.submittedCode !== undefined && {
              submittedCode: input.submittedCode,
            }),
            ...(input.referralCode !== undefined && {
              referralCode: input.referralCode,
            }),
          },
        });

        return yield* transaction(
          Effect.gen(function* () {
            const [order] = yield* db
              .insert(orders)
              .values({
                id: input.orderId,
                kind: "pass-purchase",
                dotyposCustomerId,
                paymentState: "not_started",
                fulfillmentState: "not_started",
              })
              .onConflictDoNothing({ target: orders.id })
              .returning({ id: orders.id });

            if (!order) {
              const competing = yield* readPurchase(input.orderId);
              if (!competing) {
                return yield* new EntryPackPurchaseError({
                  reason: "purchase-conflict",
                });
              }
              return yield* verifyRetry(competing, retry);
            }

            const holderAccountId =
              giftEmail === null
                ? session.accountId
                : yield* ensurePassHolderAccount(giftEmail);
            if (!holderAccountId) {
              return yield* new EntryPackPurchaseError({
                reason: "holder-unavailable",
              });
            }

            const [purchase] = yield* db
              .insert(passPurchases)
              .values({
                id: order.id,
                buyerAccountId: session.accountId,
                holderAccountId,
                product: input.product.kind,
                tier: input.product.tier,
                entryCount: input.product.size,
                quote: acceptedQuote,
                status: "pending_payment",
                validFrom,
                validUntil,
                locale: input.locale,
                createdAt: purchasedAt,
              })
              .returning();

            if (!purchase || purchase.entryCount === null)
              return yield* Effect.die("Entry pack insert returned no row.");
            return { ...purchase, entryCount: purchase.entryCount };
          })
        );
      })
    );
  }
);

export const getEntryPackPaymentDisclosure = (locale: Locale) => ({
  documents: getPaymentSubmitLegalDocuments(locale),
  earlyStartRequest: m.passEarlyStartConsent({}, { locale }),
});

const readOwnedPurchaseOrder = Effect.fn("readOwnedEntryPackPurchaseOrder")(
  function* (orderId: OrderId, buyerAccountId: CustomerAccountId) {
    const entry = yield* findOwnedEntryPackOrder(orderId, buyerAccountId);
    if (!entry)
      return yield* new EntryPackPurchaseError({ reason: "unavailable" });
    return entry;
  }
);

type PassPurchase = typeof passPurchases.$inferSelect;

const readOwnedPayablePass = Effect.fn("readOwnedPayablePass")(function* (
  orderId: OrderId,
  buyer: CustomerAccountId,
  productKind: PassPurchase["product"]
) {
  const entry = yield* findOwnedPassPurchaseOrder(orderId, buyer, productKind);
  if (!entry)
    return yield* new EntryPackPurchaseError({ reason: "unavailable" });
  const { purchase } = entry;
  if (purchase.product === "unlimited") {
    const product = { kind: "unlimited", tier: purchase.tier } as const;
    return {
      ...entry,
      product,
      discountableSubtotal: getUnlimitedPassPrice(product),
    };
  }
  if (purchase.entryCount === null) {
    return yield* new EntryPackPurchaseError({ reason: "unavailable" });
  }
  const product = {
    kind: "entry-pack",
    tier: purchase.tier,
    size: purchase.entryCount,
  } as const;
  return {
    ...entry,
    product,
    discountableSubtotal: getEntryPackPrice(product),
  };
});

const requireOpenUnlimitedPassQuote = Effect.fnUntraced(function* (
  purchase: PassPurchase
) {
  if (
    purchase.product === "unlimited" &&
    hasPassQuoteExpired(yield* currentInstant, purchase)
  ) {
    return yield* new EntryPackPurchaseError({ reason: "quote-expired" });
  }
});

const hasEndedUnpaidAttempt = ({
  order,
  activeAttempt,
}: Pick<
  Effect.Success<ReturnType<typeof readOwnedPurchaseOrder>>,
  "order" | "activeAttempt"
>) =>
  isEndedUnpaidPaymentState(order.paymentState) &&
  activeAttempt !== null &&
  isEndedUnpaidPaymentState(activeAttempt.state) &&
  activeAttempt.refundState === "not_required";

export const readEntryPackCheckoutDraft = Effect.fn(
  "readEntryPackCheckoutDraft"
)(function* (orderId: OrderId) {
  const current = yield* CurrentCustomerAccount;
  const { accountId } = yield* current.requireActive;
  const { order, purchase } = yield* readOwnedPurchaseOrder(orderId, accountId);
  if (order.paymentState !== "not_started" || order.activePaymentAttemptId) {
    return { kind: "status" as const };
  }
  const now = yield* currentInstant;
  if (isEntryPackQuoteExpired(now, purchase.validUntil)) {
    return { kind: "expired" as const };
  }
  const holderEmail =
    purchase.holderAccountId === accountId
      ? undefined
      : yield* findPurchaseLoginEmail(purchase.holderAccountId);
  if (purchase.holderAccountId !== accountId && !holderEmail) {
    return { kind: "status" as const };
  }
  return {
    kind: "draft" as const,
    locale: purchase.locale,
    product: {
      kind: "entry-pack",
      tier: purchase.tier,
      size: purchase.entryCount,
    } satisfies EntryPackProduct,
    validUntil: purchase.validUntil.toString(),
    holderEmail,
  };
});

export const readEntryPackPaymentRetry = Effect.fn("readEntryPackPaymentRetry")(
  function* (orderId: OrderId) {
    const account = yield* CurrentCustomerAccount;
    const { accountId } = yield* account.requireActive;
    const original = yield* readOwnedPurchaseOrder(orderId, accountId);
    const { order, purchase } = original;
    const paymentAttemptId = order.activePaymentAttemptId;
    const now = yield* currentInstant;
    if (
      !paymentAttemptId ||
      !hasEndedUnpaidAttempt(original) ||
      isEntryPackQuoteExpired(now, purchase.validUntil)
    )
      return { kind: "status" as const, locale: purchase.locale };

    const verification = yield* LatePaymentVerificationService;
    const outcome = yield* verification.startRecoveryIfSettled({
      orderId,
      expectedPaymentAttemptId: paymentAttemptId,
      verificationDeadline: "40 seconds",
    });
    if (outcome !== "confirmed_unpaid") {
      return { kind: "status" as const, locale: purchase.locale };
    }
    const snapshots = yield* AccountingDocumentSnapshots;
    const snapshot = yield* snapshots.findPassPurchase(paymentAttemptId);
    if (snapshot?.product.kind !== "entry-pack")
      return { kind: "status" as const, locale: purchase.locale };
    const current = yield* readOwnedPurchaseOrder(orderId, accountId);
    if (
      current.order.activePaymentAttemptId !== paymentAttemptId ||
      !hasEndedUnpaidAttempt(current)
    )
      return { kind: "status" as const, locale: purchase.locale };

    const holderEmail =
      purchase.holderAccountId === accountId
        ? undefined
        : yield* findPurchaseLoginEmail(purchase.holderAccountId);
    return {
      kind: "retry" as const,
      priorPaymentAttemptId: paymentAttemptId,
      locale: purchase.locale,
      product: snapshot.product,
      billing: snapshot.billing,
      holderEmail,
      quote: yield* Schema.decodeEffect(passPurchaseQuoteCodec)(purchase.quote),
      validFrom: purchase.validFrom,
      validUntil: purchase.validUntil,
    };
  }
);

export const readEntryPackCheckoutPayment = Effect.fn(
  "readEntryPackCheckoutPayment"
)(function* (orderId: OrderId) {
  const account = yield* CurrentCustomerAccount;
  const { accountId } = yield* account.requireActive;
  const { order, purchase } = yield* readOwnedPurchaseOrder(orderId, accountId);
  if (order.paymentState !== "not_started" || order.activePaymentAttemptId) {
    return yield* readEntryPackPaymentRetry(orderId);
  }
  const now = yield* currentInstant;
  if (
    purchase.status !== "pending_payment" ||
    isEntryPackQuoteExpired(now, purchase.validUntil)
  ) {
    return { kind: "status" as const, locale: purchase.locale };
  }
  const gift = purchase.holderAccountId !== accountId;
  const holderEmail = gift
    ? yield* findPurchaseLoginEmail(purchase.holderAccountId)
    : undefined;
  if (gift && !holderEmail) {
    return { kind: "status" as const, locale: purchase.locale };
  }
  return {
    kind: "ready" as const,
    locale: purchase.locale,
    product: {
      kind: "entry-pack" as const,
      tier: purchase.tier,
      size: purchase.entryCount,
    },
    billing: defaultReservationBillingSelection,
    holderEmail,
    quote: yield* Schema.decodeEffect(passPurchaseQuoteCodec)(purchase.quote),
    validFrom: purchase.validFrom,
    validUntil: purchase.validUntil,
  };
});

const savePassPurchaseQuote = Effect.fn("savePassPurchaseQuote")(function* (
  purchase: Pick<PassPurchase, "id" | "product">,
  quote: PassPurchaseQuote
) {
  const { db } = yield* WorkspaceDatabase;
  const encoded = yield* Schema.encodeEffect(passPurchaseQuoteCodec)(quote);
  const unlimited = purchase.product === "unlimited";
  const [saved] = yield* db
    .update(passPurchases)
    .set({ quote: encoded })
    .where(
      and(
        eq(passPurchases.id, purchase.id),
        unlimited ? eq(passPurchases.status, "pending_payment") : undefined
      )
    )
    .returning({ id: passPurchases.id });
  if (unlimited && !saved) {
    return yield* new EntryPackPurchaseError({ reason: "quote-expired" });
  }
});

/** Reprices an unpaid pass without making a payment attempt. */
export const repriceEntryPackPurchase = Effect.fn("repriceEntryPackPurchase")(
  function* (input: {
    readonly orderId: OrderId;
    readonly displayedPriceFingerprint: string;
    readonly productKind?: PassPurchase["product"];
    readonly submittedCode?: CanonicalPromotionCode;
    readonly referralCode?: CanonicalPromotionCode;
    readonly preserveReferral?: true;
  }) {
    yield* requirePassPurchasesEnabled();
    const current = yield* CurrentCustomerAccount;
    const session = yield* current.requireActive;
    const accounts = yield* CustomerAccountSections;

    return yield* accounts.withActiveAccount(
      session.accountId,
      Effect.gen(function* () {
        const { order, purchase, product, discountableSubtotal } =
          yield* readOwnedPayablePass(
            input.orderId,
            session.accountId,
            input.productKind ?? "entry-pack"
          );
        if (
          order.paymentState !== "not_started" ||
          order.activePaymentAttemptId
        ) {
          return yield* new EntryPackPurchaseError({
            reason: "payment-in-progress",
          });
        }
        const bookedAt = yield* currentInstant;
        if (hasPassQuoteExpired(bookedAt, purchase)) {
          return yield* new EntryPackPurchaseError({ reason: "quote-expired" });
        }
        const storedQuote = yield* Schema.decodeUnknownEffect(
          passPurchaseQuoteCodec
        )(purchase.quote);
        if (
          input.displayedPriceFingerprint !==
          getPassPurchasePriceFingerprint(storedQuote)
        ) {
          return { status: "pricing_changed" as const, quote: storedQuote };
        }

        const discounts = yield* DiscountService;
        const referralCode =
          input.referralCode ??
          (input.preserveReferral
            ? storedQuote.selection?.referralCode
            : undefined);
        const discountInput = {
          product,
          discountableSubtotal,
          firstServiceDate: purchase.validFrom,
          lastServiceDate: purchase.validFrom,
          bookedAt,
          dotyposCustomerId: order.dotyposCustomerId,
          locale: purchase.locale,
          ...(referralCode !== undefined && { referralCode }),
        };
        const baseQuote = yield* discounts.quote(discountInput);
        const appliedCode = input.submittedCode
          ? yield* discounts.applyDiscountCode({
              ...discountInput,
              baseQuote,
              submittedCode: input.submittedCode,
            })
          : undefined;
        const quote = appliedCode?.quote ?? baseQuote;
        const submittedCodeDiscountId = appliedCode?.application.discount.id;

        const selectedQuote = {
          ...quote,
          ...(purchase.unlimitedCoffee && { unlimitedCoffee: true as const }),
          ...(submittedCodeDiscountId !== undefined &&
            quote.discounts.some(
              ({ discount }) => discount.id === submittedCodeDiscountId
            ) && { submittedCodeDiscountId }),
          selection: {
            ...(input.submittedCode !== undefined && {
              submittedCode: input.submittedCode,
            }),
            ...(referralCode !== undefined && { referralCode }),
          },
        };
        yield* requireOpenUnlimitedPassQuote(purchase);
        yield* savePassPurchaseQuote(purchase, selectedQuote);
        return { status: "ready" as const, quote: selectedQuote };
      })
    );
  }
);

/** Pay records the versions and the buyer's express request before starting payment. */
const prepareEntryPackPaymentConsent = Effect.fn(
  "prepareEntryPackPaymentConsent"
)(function* (
  input: {
    readonly accepted: boolean;
    readonly acceptedDocuments: ReadonlyArray<{
      readonly key: string;
      readonly hash: string;
    }>;
    readonly unlimitedEarlyStartAccepted?: boolean;
  },
  locale: Locale,
  orderId: OrderId,
  productKind: PassPurchase["product"],
  earlyStartRequired: boolean
) {
  if (!input.accepted) {
    return yield* new EntryPackPurchaseError({ reason: "consent-required" });
  }
  if (
    !isCurrentPaymentSubmitLegalAcceptance(locale, input.acceptedDocuments) ||
    (productKind === "unlimited" &&
      Boolean(input.unlimitedEarlyStartAccepted) !== earlyStartRequired)
  ) {
    return yield* new EntryPackPurchaseError({
      reason: "terms-changed",
      locale: locale,
      ...(productKind === "unlimited" && { earlyStartRequired }),
    });
  }

  const evidence = yield* LegalEvidenceEventRepository;
  return Effect.gen(function* () {
    const acceptedAt = yield* currentInstant;
    yield* evidence.recordMany(
      Object.values(
        getPaymentSubmitLegalEvidence({
          acceptedAt: acceptedAt.toString(),
          locale,
          earlyPerformanceConsent:
            productKind === "entry-pack" || earlyStartRequired,
          ...(productKind === "entry-pack"
            ? { entryPackEarlyStartRequested: true }
            : earlyStartRequired && { unlimitedPassEarlyStartRequested: true }),
        })
      ).map((record) => ({ orderId, evidence: record }))
    );
  }).pipe(Effect.catchTag("LegalEvidenceEventInputError", Effect.die));
});

/** Starts the payment for the authenticated buyer after reconfirming the displayed quote. */
export const payForEntryPack = Effect.fn("payForEntryPack")(function* (
  input: Parameters<typeof prepareEntryPackPaymentConsent>[0] & {
    readonly orderId: OrderId;
    readonly productKind?: PassPurchase["product"];
    readonly priorPaymentAttemptId?: PaymentAttemptId;
    readonly submittedCode?: CanonicalPromotionCode;
    readonly referralCode?: CanonicalPromotionCode;
    readonly billing?: ReservationBillingSelection;
    readonly displayedPriceFingerprint?: string;
    readonly returnTarget?: PaymentReturnTarget;
  }
) {
  yield* requirePassPurchasesEnabled();
  const current = yield* CurrentCustomerAccount;
  const session = yield* current.requireActive;
  const accounts = yield* CustomerAccountSections;
  const handlers = yield* OrderPaymentHandlers;
  const handler = handlers.byKind["pass-purchase"];
  if (!handler)
    return yield* new EntryPackPurchaseError({ reason: "unavailable" });

  // Recovery can take the order section for fulfillment. Verify before
  // holding the account section, then fence the result to the same attempt.
  const productKind = input.productKind ?? "entry-pack";
  const prior = yield* readOwnedPayablePass(
    input.orderId,
    session.accountId,
    productKind
  );
  const approvedAfterAttemptId = input.priorPaymentAttemptId ?? null;
  let confirmedUnpaid = false;
  if (
    approvedAfterAttemptId &&
    prior.order.activePaymentAttemptId === approvedAfterAttemptId &&
    hasEndedUnpaidAttempt(prior)
  ) {
    const verification = yield* LatePaymentVerificationService;
    const outcome = yield* verification.startRecoveryIfSettled({
      orderId: input.orderId,
      expectedPaymentAttemptId: approvedAfterAttemptId,
    });
    confirmedUnpaid = outcome === "confirmed_unpaid";
  }

  const result = yield* accounts.withActiveAccount(
    session.accountId,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const currentPurchase = yield* readOwnedPayablePass(
        input.orderId,
        session.accountId,
        productKind
      );
      const { order, purchase, product, discountableSubtotal } =
        currentPurchase;
      const statusUrl = input.returnTarget
        ? yield* getPaymentReturnDestination({
            kind: "pass-purchase",
            target: input.returnTarget,
            orderId: order.id,
          })
        : `/${purchase.locale}${reservationStatusPath}/${order.id}`;
      if (order.paymentState === "paid") {
        return { status: "paid" as const, statusUrl };
      }
      if (
        order.activePaymentAttemptId !== approvedAfterAttemptId ||
        (approvedAfterAttemptId
          ? !confirmedUnpaid || !hasEndedUnpaidAttempt(currentPurchase)
          : order.paymentState !== "not_started")
      )
        return { status: "pending" as const, statusUrl };
      yield* requireOpenUnlimitedPassQuote(purchase);
      const accepted = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
        purchase.quote
      );
      const snapshots = yield* AccountingDocumentSnapshots;
      const frozen = order.activePaymentAttemptId
        ? yield* snapshots.findPassPurchase(order.activePaymentAttemptId)
        : undefined;
      if (order.activePaymentAttemptId && !frozen) {
        return yield* new EntryPackPurchaseError({ reason: "billing-changed" });
      }
      const coffeeAmountMinor = frozen
        ? (frozen.coffeeAmountMinor ?? null)
        : catalogCoffeeAmountMinor(purchase.unlimitedCoffee);
      const acceptedFingerprint = getPassPurchasePriceFingerprint(
        accepted,
        coffeeAmountMinor
      );
      const stalePrice =
        input.displayedPriceFingerprint !== undefined &&
        input.displayedPriceFingerprint !== acceptedFingerprint;
      if (stalePrice) {
        return {
          status: "pricing_changed" as const,
          quote: accepted,
          coffeeAmountMinor,
        };
      }
      const billing = yield* decodeBilling(
        input.billing ?? frozen?.billing ?? defaultReservationBillingSelection
      );
      if (frozen && !billingMatches(frozen.billing, billing)) {
        return yield* new EntryPackPurchaseError({ reason: "billing-changed" });
      }
      const now = yield* currentInstant;
      if (hasPassQuoteExpired(now, purchase)) {
        return yield* new EntryPackPurchaseError({
          reason:
            productKind === "entry-pack" && order.activePaymentAttemptId
              ? "payment-in-progress"
              : "quote-expired",
        });
      }
      if (productKind === "unlimited") {
        yield* reconfirmUnlimitedPassHolds(purchase).pipe(
          Effect.catchTag("UnlimitedPassHoldsUnavailable", () =>
            Effect.flatMap(currentInstant, (checkedAt) =>
              Effect.fail(
                new EntryPackPurchaseError({
                  reason: hasUnlimitedPassFirstDayEnded(purchase, checkedAt)
                    ? "quote-expired"
                    : "holds-unavailable",
                })
              )
            )
          )
        );
      }

      const discountService = yield* DiscountService;
      const selection = accepted.selection ?? {
        ...(input.submittedCode !== undefined && {
          submittedCode: input.submittedCode,
        }),
        ...(input.referralCode !== undefined && {
          referralCode: input.referralCode,
        }),
      };
      const { quote, commitment } =
        yield* discountService.affirmDisplayedDiscounts({
          product,
          discountableSubtotal,
          firstServiceDate: purchase.validFrom,
          lastServiceDate: purchase.validFrom,
          bookedAt: now,
          dotyposCustomerId: order.dotyposCustomerId,
          locale: purchase.locale,
          displayedDiscountIds: accepted.discounts.map(
            ({ discount }) => discount.id
          ),
          ...selection,
        });
      yield* requireOpenUnlimitedPassQuote(purchase);
      const submittedCodeDiscountId = getAppliedPromotionDiscountId(
        quote,
        getDiscountCommitmentPayload(commitment).applications
      );
      const refreshedQuote = {
        ...quote,
        ...(purchase.unlimitedCoffee && { unlimitedCoffee: true as const }),
        ...(accepted.selection && { selection }),
        ...(submittedCodeDiscountId !== undefined && {
          submittedCodeDiscountId,
        }),
      };
      const currentFingerprint = getPassPurchasePriceFingerprint(
        refreshedQuote,
        coffeeAmountMinor
      );
      if (acceptedFingerprint !== currentFingerprint) {
        // An ended attempt may still settle late at its original price.
        if (order.activePaymentAttemptId) {
          return yield* new EntryPackPurchaseError({
            reason: "payment-in-progress",
          });
        }
        yield* savePassPurchaseQuote(purchase, refreshedQuote);
        return {
          status: "pricing_changed" as const,
          quote: refreshedQuote,
          coffeeAmountMinor,
        };
      }

      if (order.activePaymentAttemptId) {
        // A code can be renamed or reassigned without changing its displayed
        // text or price. Use the sources recorded when the first charge started.
        const priorSources = yield* db
          .select({
            namespace: sql<
              string | null
            >`${discountApplications.provenance}->>'providerNamespace'`,
            reference: sql<
              string | null
            >`${discountApplications.provenance}->>'providerReference'`,
          })
          .from(discountApplications)
          .where(
            eq(
              discountApplications.paymentAttemptId,
              order.activePaymentAttemptId
            )
          )
          .orderBy(discountApplications.sequence);
        const { applications } = getDiscountCommitmentPayload(commitment);
        if (
          priorSources.length !== applications.length ||
          priorSources.some((source, index) => {
            const next = applications[index]?.provenance;
            return (
              source.namespace !== next?.providerNamespace ||
              source.reference !== next?.providerReference
            );
          })
        ) {
          return yield* new EntryPackPurchaseError({
            reason: "payment-in-progress",
          });
        }
      }

      const contacts = yield* CustomerAccountContactService;
      const contact = yield* contacts.linkedContact({
        accountId: session.accountId,
        email: session.email,
        dotyposCustomerId: order.dotyposCustomerId,
      });
      if (!contact)
        return yield* new EntryPackPurchaseError({
          reason: "buyer-profile-required",
        });
      const buyer = frozen?.buyer ??
        getReservationInvoiceBuyer({
          billing,
          customerName: contact.name,
        }) ?? { kind: "person" as const, legalName: contact.name };
      const admission = {
        orderId: order.id,
        amount: withPassPurchaseCoffee(
          quote.discountedSubtotal,
          coffeeAmountMinor
        ),
        locale: purchase.locale,
        details: {
          approvedAfterAttemptId,
          commitment,
          recordConsent: yield* prepareEntryPackPaymentConsent(
            input,
            purchase.locale,
            order.id,
            productKind,
            productKind === "unlimited" &&
              unlimitedPassRequiresEarlyStart(
                purchase.validFrom,
                getCurrentWorkspaceDate(now)
              )
          ),
          snapshot: {
            orderId: order.id,
            dotyposCustomerId: order.dotyposCustomerId,
            locale: purchase.locale,
            supplier: workspaceAccountingSupplier,
            buyer,
            billing,
            delivery: frozen?.delivery ?? { email: session.email },
            serviceDate: purchase.validFrom,
            product,
            ...(coffeeAmountMinor !== null && { coffeeAmountMinor }),
            quote: frozen?.quote ?? quote,
          },
        },
      };
      const analytics = yield* CheckoutAnalytics;
      if (admission.amount.value === 0) {
        const payment = yield* handler.admitInternal(admission).pipe(
          Effect.catchIf(isUnlimitedPassFirstDayAdmissionExpired, () =>
            Effect.fail(new EntryPackPurchaseError({ reason: "quote-expired" }))
          ),
          Effect.catchIf(isStaleEntryPackPaymentApproval, () =>
            Effect.succeed(undefined)
          )
        );
        if (!payment) return { status: "pending" as const, statusUrl };
        if (payment.changed)
          yield* analytics.paymentCompleted({
            attempt: payment.attempt,
            timestamp: payment.timestamp,
          });
        return { status: "paid" as const, statusUrl };
      }

      const payment = yield* startPaymentSession({
        ...admission,
        kind: "pass-purchase",
        ...(input.returnTarget && { passReturnTarget: input.returnTarget }),
        correlationId: order.correlationId,
        customer: { name: contact.name, email: session.email },
        beforeAttempt: Effect.void,
      }).pipe(
        Effect.scoped,
        Effect.catchIf(isUnlimitedPassFirstDayAdmissionExpired, () =>
          Effect.fail(new EntryPackPurchaseError({ reason: "quote-expired" }))
        ),
        Effect.catchIf(isStaleEntryPackPaymentApproval, () =>
          Effect.succeed(undefined)
        )
      );
      if (!payment) return { status: "pending" as const, statusUrl };
      const { hostedPaymentPage, attachedAttempt } = payment;
      yield* analytics.paymentStarted({
        attempt: attachedAttempt,
        timestamp: attachedAttempt.updatedAt,
      });
      return {
        status: "hosted" as const,
        statusUrl,
        redirectUrl: hostedPaymentPage.hostedPage,
      };
    }),
    productKind === "unlimited"
      ? { passPurchaseOrderId: input.orderId }
      : undefined
  );
  // Fulfillment takes its order section after the account section ends.
  if (result.status === "paid") {
    yield* handler.scheduleFulfillment({ orderId: input.orderId });
  }
  return result;
});
