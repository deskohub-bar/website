import "server-only";

import { Effect, Option, Schema } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountSession } from "@/features/account/backend/customer-authentication.service";
import type { CustomerProfileSave } from "@/features/account/contracts";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import type { CanonicalPromotionCode } from "@/features/discounts/contracts";
import { normalizeSubmittedPromotionCode } from "@/features/discounts/promotion-code";
import type { Locale } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { findOrderKind } from "@/features/order/backend/order-kind";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { currentInstant, type PlainDate } from "@/shared/utils/temporal";
import { getEntryPackPayPath } from "../entry-pack-checkout";
import {
  getEntryPackLastUsableDate,
  isEntryPackQuoteExpired,
} from "../pass-offer";
import { unlimitedGiftRecipientNameSchema } from "../pass-purchase-details";
import { passPurchaseQuoteCodec } from "../pass-purchase-quote";
import {
  getPassCheckoutHandoffPath,
  getPassPurchaseStatusPath,
} from "../routes";
import {
  type UnlimitedPassSelection,
  unlimitedPassRequiresEarlyStart,
} from "../unlimited-pass";
import { getUnlimitedPassPayPath } from "../unlimited-pass-checkout";
import {
  findOwnedPassPurchaseOrder,
  hasPassPurchasePaymentStarted,
} from "./entry-pack-order";
import {
  beginEntryPackPurchase,
  displayPassPurchasePrice,
  EntryPackPurchaseError,
  getEntryPackPaymentDisclosure,
  payForEntryPack,
  repriceEntryPackPurchase,
  requirePassPurchasesEnabled,
} from "./entry-pack-purchase";
import { loadEntryPackStatus } from "./entry-pack-status";
import {
  type PassPurchaseProduct,
  sealPassCheckoutHandoff,
} from "./pass-checkout-handoff";
import {
  beginUnlimitedPassPurchase,
  getUnlimitedPassPaymentDisclosure,
} from "./unlimited-pass-purchase";
import { readUnlimitedPassStartDates } from "./unlimited-pass-start-dates";

export type { PassPurchaseProduct } from "./pass-checkout-handoff";

export type BeginPassPurchaseInput = {
  readonly orderId: OrderId;
  readonly locale: Locale;
  readonly product: PassPurchaseProduct;
  readonly holderEmail?: string;
  readonly recipientName?: string;
  readonly buyerProfile?: CustomerProfileSave;
  readonly referralCode?: CanonicalPromotionCode;
  readonly supersedeOrderId?: OrderId;
};

const readPaymentDisclosure = Effect.fn("passes.readPaymentDisclosure")(
  function* (
    product: PassPurchaseProduct["kind"],
    locale: Locale,
    validFrom: PlainDate
  ) {
    if (product === "entry-pack") return getEntryPackPaymentDisclosure(locale);
    return getUnlimitedPassPaymentDisclosure(
      locale,
      unlimitedPassRequiresEarlyStart(
        validFrom,
        getCurrentWorkspaceDate(yield* currentInstant)
      )
    );
  }
);

const beginUnlimitedOrder = Effect.fn("passes.beginUnlimitedOrder")(function* (
  input: BeginPassPurchaseInput,
  selection: UnlimitedPassSelection,
  { accountId }: CustomerAccountSession
) {
  const { orderId, supersedeOrderId } = input;
  if (
    supersedeOrderId &&
    supersedeOrderId.toLowerCase() !== orderId.toLowerCase() &&
    !(yield* findOwnedPassPurchaseOrder(
      supersedeOrderId,
      accountId,
      "unlimited"
    ))
  ) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  const holderEmail =
    input.holderEmail === undefined
      ? undefined
      : yield* Schema.decodeEffect(reservationCustomerEmailSchema)(
          input.holderEmail
        );
  const recipientName =
    input.recipientName === undefined
      ? undefined
      : yield* Schema.decodeEffect(
          unlimitedGiftRecipientNameSchema(input.locale)
        )(input.recipientName);
  const { outcome } = yield* beginUnlimitedPassPurchase({
    ...input,
    selection,
    requireGiftRecipientName: true,
    ...(holderEmail !== undefined && { holderEmail }),
    ...(recipientName !== undefined && { recipientName }),
  });
  return yield* Effect.fromResult(outcome).pipe(
    Effect.catchTag("UnlimitedPassAdmissionError", ({ reason }) =>
      Effect.fail(
        new EntryPackPurchaseError({
          reason:
            reason === "holder-unavailable" ? reason : "purchase-conflict",
        })
      )
    )
  );
});

const beginPassOrder = Effect.fn("passes.beginPassOrder")(function* (
  input: BeginPassPurchaseInput
) {
  yield* requirePassPurchasesEnabled();
  const actor = yield* CurrentCustomerAccount;
  const session = yield* actor.requireActive;
  const { product, orderId } = input;
  const existingKind = yield* findOrderKind(orderId);
  if (
    existingKind &&
    (existingKind !== "pass-purchase" ||
      !(yield* findOwnedPassPurchaseOrder(
        orderId,
        session.accountId,
        product.kind
      )))
  ) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  if (product.kind === "unlimited") {
    return yield* beginUnlimitedOrder(input, product.selection, session);
  }
  if (input.supersedeOrderId) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  const purchase = yield* beginEntryPackPurchase({ ...input, product });
  const owned = yield* findOwnedPassPurchaseOrder(
    purchase.id,
    session.accountId,
    product.kind
  );
  if (!owned) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  if (hasPassPurchasePaymentStarted(owned.order)) {
    return yield* new EntryPackPurchaseError({ reason: "payment-in-progress" });
  }
  if (
    owned.purchase.status !== "pending_payment" ||
    isEntryPackQuoteExpired(yield* currentInstant, owned.purchase.validUntil)
  ) {
    return yield* new EntryPackPurchaseError({ reason: "quote-expired" });
  }
  return owned.purchase;
});

/** Creates a payable draft and projects what the buyer needs to approve it. */
export const beginPurchase = Effect.fn("passes.beginPurchase")(
  (input: BeginPassPurchaseInput) =>
    Effect.succeed(input).pipe(
      Effect.bind("purchase", beginPassOrder),
      Effect.bind("quote", ({ purchase }) =>
        Schema.decodeEffect(passPurchaseQuoteCodec)(purchase.quote)
      ),
      Effect.bind("disclosure", ({ purchase, product }) =>
        readPaymentDisclosure(product.kind, purchase.locale, purchase.validFrom)
      ),
      Effect.map(({ product, purchase, quote, disclosure }) => ({
        orderId: purchase.id,
        product,
        payPath:
          product.kind === "entry-pack"
            ? getEntryPackPayPath(purchase.locale, purchase.id)
            : getUnlimitedPassPayPath(purchase.locale, purchase.id),
        statusPath: getPassPurchaseStatusPath(purchase.locale, purchase.id),
        price: displayPassPurchasePrice(quote),
        validFrom: purchase.validFrom,
        lastUsableDate: getEntryPackLastUsableDate(
          purchase.validUntil
        ).toString(),
        disclosure,
      }))
    )
);

const startPurchaseDetails = Effect.fn("passes.startPurchaseDetails")(
  function* ({
    locale,
    orderId,
    product,
    holderEmail,
    referralCode,
    supersedeOrderId,
  }: BeginPassPurchaseInput) {
    const actor = yield* CurrentCustomerAccount;
    const { accountId, email } = yield* actor.requireActive;
    const giftRecipient = holderEmail?.trim().toLowerCase();
    const token = yield* sealPassCheckoutHandoff({
      buyerAccountId: accountId,
      orderId,
      product,
      ...(referralCode && { referralCode }),
      ...(supersedeOrderId && {
        predecessorOrderIds: [
          orderIdSchema.make(supersedeOrderId.toLowerCase()),
        ],
      }),
      ...(giftRecipient &&
        giftRecipient !== email.toLowerCase() && {
          holderEmail: giftRecipient,
        }),
    });
    return {
      status: "details_required" as const,
      checkoutPath: getPassCheckoutHandoffPath(locale, product.kind, token),
    };
  }
);

const startPurchaseStatus = Effect.fn("passes.startPurchaseStatus")(function* (
  orderId: OrderId,
  productKind: PassPurchaseProduct["kind"]
) {
  const actor = yield* CurrentCustomerAccount;
  const { accountId } = yield* actor.requireActive;
  const owned = yield* findOwnedPassPurchaseOrder(
    orderId,
    accountId,
    productKind
  );
  if (!owned) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  const statusPath = getPassPurchaseStatusPath(
    owned.purchase.locale,
    owned.order.id
  );
  return {
    status: "status" as const,
    orderId: owned.order.id,
    checkoutPath: statusPath,
    statusPath,
  };
});

/** Starts a website checkout from a signed-in customer channel. */
export const startPurchase = Effect.fn("passes.startPurchase")(
  (input: BeginPassPurchaseInput) =>
    beginPurchase(input).pipe(
      Effect.map(({ orderId, payPath, statusPath }) => ({
        status: "ready" as const,
        orderId,
        checkoutPath: payPath,
        statusPath,
      })),
      Effect.catchTag(
        "EntryPackPurchaseError",
        Effect.fnUntraced(function* (error: EntryPackPurchaseError) {
          switch (error.reason) {
            case "buyer-profile-required":
            case "holder-unavailable":
              return yield* startPurchaseDetails(input);
            case "payment-in-progress":
              return yield* startPurchaseStatus(
                error.orderId ?? input.orderId,
                input.product.kind
              );
            default:
              return yield* error;
          }
        })
      )
    )
);

export const purchaseStartDates = Effect.fn("passes.purchaseStartDates")(
  function* (input: {
    readonly startsOn?: PlainDate;
    readonly supersedeOrderId?: OrderId;
  }) {
    yield* requirePassPurchasesEnabled();
    const actor = yield* CurrentCustomerAccount;
    const { accountId } = yield* actor.requireActive;
    return yield* readUnlimitedPassStartDates({
      ...input,
      buyerAccountId: accountId,
      ...(input.supersedeOrderId && {
        predecessorOrderIds: [input.supersedeOrderId],
      }),
    });
  }
);

export type PayPassPurchaseInput = Parameters<typeof payForEntryPack>[0] & {
  readonly productKind: PassPurchaseProduct["kind"];
  readonly displayedPriceFingerprint: string;
};

export const repricePurchase = Effect.fn("CustomerPasses.repricePurchase")(
  (input: {
    readonly orderId: OrderId;
    readonly productKind: PassPurchaseProduct["kind"];
    readonly displayedPriceFingerprint: string;
    readonly submittedCode?: string;
  }) =>
    normalizeSubmittedPromotionCode({
      submittedCode: input.submittedCode,
    }).pipe(
      Effect.flatMap((code) =>
        repriceEntryPackPurchase({
          orderId: input.orderId,
          productKind: input.productKind,
          displayedPriceFingerprint: input.displayedPriceFingerprint,
          preserveReferral: true,
          ...(Option.isSome(code) && { submittedCode: code.value }),
        })
      ),
      Effect.map(({ status, quote }) => ({
        status,
        price: displayPassPurchasePrice(quote),
      })),
      Effect.catchTag("PromotionCodeUnavailableError", () =>
        Effect.succeed({ status: "code_unavailable" as const })
      )
    )
);

export const payPurchase = Effect.fn("passes.payPurchase")(
  (input: PayPassPurchaseInput) =>
    payForEntryPack(input).pipe(
      Effect.map((result) =>
        result.status === "pricing_changed"
          ? {
              status: result.status,
              price: displayPassPurchasePrice(
                result.quote,
                result.coffeeAmountMinor
              ),
            }
          : result
      ),
      Effect.catchTag("EntryPackPurchaseError", (error) =>
        error.reason === "terms-changed" && error.locale
          ? Effect.succeed({
              status: "terms_changed" as const,
              disclosure:
                input.productKind === "entry-pack"
                  ? getEntryPackPaymentDisclosure(error.locale)
                  : getUnlimitedPassPaymentDisclosure(
                      error.locale,
                      error.earlyStartRequired ?? false
                    ),
            })
          : Effect.fail(error)
      )
    )
);

export const purchaseStatus = Effect.fn("passes.purchaseStatus")(function* (
  orderId: OrderId
) {
  yield* requirePassPurchasesEnabled();
  const result = yield* loadEntryPackStatus(orderId, "buyer");
  if (result.status === "paid" && result.gift) {
    const { maskedHolderEmail: _, ...status } = result;
    return status;
  }
  if (!("priorPaymentAttemptId" in result) || !result.priorPaymentAttemptId) {
    return result;
  }
  const { priorPaymentAttemptId } = result;
  const actor = yield* CurrentCustomerAccount;
  const { accountId } = yield* actor.requireActive;
  const product = result.entryCount === null ? "unlimited" : "entry-pack";
  const current = yield* findOwnedPassPurchaseOrder(
    orderId,
    accountId,
    product
  );
  const ownsAttempt =
    current?.order.activePaymentAttemptId === priorPaymentAttemptId;
  const snapshot =
    product === "unlimited" && ownsAttempt
      ? yield* AccountingDocumentSnapshots.use((snapshots) =>
          snapshots.findPassPurchase(priorPaymentAttemptId)
        )
      : null;
  if (!ownsAttempt || (product === "unlimited" && !snapshot)) {
    return {
      orderId,
      tier: result.tier,
      entryCount: result.entryCount,
      status: "checking" as const,
    };
  }
  const { purchase } = current;
  const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
    purchase.quote
  );
  return {
    ...result,
    price: displayPassPurchasePrice(quote, snapshot?.coffeeAmountMinor ?? null),
    disclosure: yield* readPaymentDisclosure(
      product,
      purchase.locale,
      purchase.validFrom
    ),
  };
});
