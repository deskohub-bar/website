import "server-only";

import { DotyposService } from "@deskohub/dotypos";
import { EmailConfigTag, EmailServiceTag } from "@deskohub/email";
import { and, eq, lte, ne } from "drizzle-orm";
import { Context, Data, Effect, Option, Result } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  entryPackGiftInvitations,
  orders,
  passPurchases,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { findPurchaseLoginEmail } from "@/features/account/backend/customer-account-by-email";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { PassPurchaseAccountingSnapshot } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { InvoiceRepository } from "@/features/accounting/backend/invoice.repository";
import { InvoiceEmailDeliveryRepository } from "@/features/accounting/backend/invoice-email-delivery.repository";
import { InvoiceEmailDeliveryService } from "@/features/accounting/backend/invoice-email-delivery.service";
import type {
  AdmittingOrderPaymentHandler,
  PaymentAdmission,
} from "@/features/checkout/backend/payment/order-payment-handler";
import { toPaymentAttempt } from "@/features/checkout/backend/repositories/payment-attempt.repository";
import {
  attachPaymentProviderSession,
  insertPaymentAttempt,
  markPaymentAttemptPaid,
  markPaymentAttemptTerminal,
} from "@/features/checkout/backend/repositories/payment-attempt-writes";
import type { PaymentLifecycleRepositoryError } from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import {
  persistDiscountApplications,
  reserveCommittedClaims,
  validateDiscountCommitment,
  validateInternalPaymentCommitment,
} from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import {
  lifecycleStateError,
  PaymentLifecycleStateError,
} from "@/features/checkout/backend/repositories/payment-lifecycle-state";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import {
  type DiscountCommitment,
  getDiscountCommitmentPayload,
} from "@/features/discounts/commitment";
import { PromotionClaims } from "@/features/discounts/promotion-claims";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { ReferralInvitationLedger } from "@/features/referrals/referral-invitation-ledger";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { moneyEquals } from "@/shared/money/money";
import { currentInstant } from "@/shared/utils/temporal";
import { isEntryPackQuoteExpired } from "../pass-offer";
import { withPassPurchaseAddons } from "../pass-purchase-quote";
import { recordConfirmationInvitationState } from "./entry-pack-gift";
import { deliverPendingEntryPackInvitation } from "./entry-pack-gift-delivery";
import { sendEntryPackPurchaseEmail } from "./entry-pack-purchase-email";
import {
  canConfirmUnlimitedPass,
  hasUnlimitedPassFirstDayEnded,
  isUnsolicitedPartialPassRefund,
  requireFullPassRefund,
  settlePassPurchase,
} from "./entry-pack-settlement";
import {
  confirmUnlimitedPassDays,
  readPayableUnlimitedHolds,
} from "./unlimited-pass-holds";
import { requireUnlimitedPassWindow } from "./unlimited-pass-orders";
import { prepareUnlimitedPassRecovery } from "./unlimited-pass-recovery";

class UnlimitedPassFirstDayEnded extends Data.TaggedError(
  "UnlimitedPassFirstDayEnded"
) {}

export type EntryPackPaymentAdmissionDetails = {
  readonly approvedAfterAttemptId: PaymentAttemptId | null;
  readonly recordConsent: Effect.Effect<void, PaymentLifecycleRepositoryError>;
  readonly commitment: DiscountCommitment;
  readonly snapshot: PassPurchaseAccountingSnapshot;
};

const approvalOperation =
  "PaymentLifecycleRepository.admitEntryPackPaymentApproval";
const firstDayAdmissionOperation =
  "PaymentLifecycleRepository.admitUnlimitedPassFirstDay";

export const isStaleEntryPackPaymentApproval = (
  error: Error
): error is PaymentLifecycleStateError =>
  error instanceof PaymentLifecycleStateError &&
  error.operation === approvalOperation;

const staleApproval = (orderId: OrderId) =>
  new PaymentLifecycleStateError({
    operation: approvalOperation,
    paymentReference: { type: "orderId", id: orderId },
    message: "The approved Entry pack payment attempt changed.",
  });

export const isUnlimitedPassFirstDayAdmissionExpired = (
  error: Error
): error is PaymentLifecycleStateError & {
  readonly operation: typeof firstDayAdmissionOperation;
} =>
  error instanceof PaymentLifecycleStateError &&
  error.operation === firstDayAdmissionOperation;

const firstDayAdmissionExpired = (orderId: OrderId) =>
  new PaymentLifecycleStateError({
    operation: firstDayAdmissionOperation,
    paymentReference: { type: "orderId", id: orderId },
    message:
      "The first Unlimited pass service day ended. Choose a new start date.",
  });

type Handler = AdmittingOrderPaymentHandler<EntryPackPaymentAdmissionDetails>;
type ProviderAdmission = Pick<
  Parameters<Handler["admitProvider"]>[0],
  "provider" | "providerOrderId"
>;
type Verification = Parameters<Handler["markPaid"]>[0];
type PackOrder = typeof orders.$inferSelect;
type AttemptRow = typeof paymentAttempts.$inferSelect;

const paymentError = (orderId: OrderId, message: string) =>
  lifecycleStateError(
    "entryPackPayment",
    { type: "orderId", id: orderId },
    message
  );

const transition = (
  attempt: AttemptRow,
  changed: boolean,
  timestamp = attempt.updatedAt
) => ({ attempt: toPaymentAttempt(attempt), changed, timestamp });

const setPaid = Effect.fnUntraced(function* (
  order: PackOrder,
  attempt: AttemptRow,
  paidAt: Temporal.Instant
) {
  const { db } = yield* WorkspaceTransaction;
  yield* db
    .update(orders)
    .set({
      paymentState: "paid",
      activePaymentAttemptId: attempt.id,
      paidAt,
      updatedAt: paidAt,
    })
    .where(eq(orders.id, order.id));
  yield* settlePassPurchase(order.id);
  return transition(attempt, true, paidAt);
});

const redeemClaims = Effect.fnUntraced(function* (
  order: PackOrder,
  attemptId: AttemptRow["id"],
  paidAt: Temporal.Instant,
  readmitReleased: boolean
) {
  yield* ReferralInvitationLedger.ensureFirstPaid({
    orderId: order.id,
    dotyposCustomerId: order.dotyposCustomerId,
    paymentAttemptId: attemptId,
  });
  yield* PromotionClaims.redeem({
    paymentAttemptId: attemptId,
    redeemedAt: paidAt,
    readmitReleased,
  });
  yield* ReferralInvitationLedger.redeem({
    orderId: order.id,
    paymentAttemptId: attemptId,
    redeemedAt: paidAt,
    readmitReleased,
  });
});

export const makeEntryPackOrderPaymentHandler = Effect.gen(function* () {
  const { db, transaction } = yield* WorkspaceDatabase;
  const advisoryLock = yield* WorkspaceDatabaseAdvisoryLock;
  const dotypos = yield* Effect.serviceOption(DotyposService);
  const calendarLimitations = yield* Effect.serviceOption(
    GoogleCalendarWorkspaceLimitationsService
  );
  const reservations = yield* Effect.serviceOption(
    WorkspaceReservationRepository
  );
  const customerAccounts = yield* CustomerAccountSections;
  const email = yield* EmailServiceTag;
  const emailConfig = yield* EmailConfigTag;
  const snapshots = yield* AccountingDocumentSnapshots;
  const invoices = yield* InvoiceRepository;
  const invoiceDelivery = yield* InvoiceEmailDeliveryService;
  const invoiceDeliveryLedger = yield* InvoiceEmailDeliveryRepository;
  const services = Context.make(WorkspaceDatabase, { db, transaction });
  const sendingServices = services.pipe(
    Context.add(EmailServiceTag, email),
    Context.add(EmailConfigTag, emailConfig),
    Context.add(AccountingDocumentSnapshots, snapshots)
  );

  const readOrder = (orderId: OrderId) =>
    db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.kind, "pass-purchase")));
  const readAttempt = (orderId: OrderId, id: AttemptRow["id"]) =>
    db
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.id, id))
      );

  // Take the buyer's referral locks before touching rows that other payment paths lock.
  const lockOrder = Effect.fnUntraced(function* (
    id: OrderId,
    records: Parameters<
      typeof ReferralInvitationLedger.lockFirstBooking
    >[0]["records"]
  ) {
    const [identity] = yield* readOrder(id);
    if (!identity)
      return yield* paymentError(id, "The Entry pack order was not found.");
    yield* ReferralInvitationLedger.lockFirstBooking({
      dotyposCustomerId: identity.dotyposCustomerId,
      records,
    });
    const [locked] = yield* readOrder(id).for("no key update");
    if (!locked)
      return yield* paymentError(id, "The Entry pack order was not found.");
    return locked;
  });

  const admit = Effect.fnUntraced(function* (
    input: PaymentAdmission<EntryPackPaymentAdmissionDetails>,
    providerAdmission?: ProviderAdmission
  ) {
    const commitment = getDiscountCommitmentPayload(input.details.commitment);
    const claims = yield* providerAdmission === undefined
      ? validateInternalPaymentCommitment(commitment, input.amount)
      : validateDiscountCommitment(commitment);
    const order = yield* lockOrder(
      input.orderId,
      providerAdmission === undefined
        ? { admittedInvitation: claims.referral !== undefined }
        : "nothing"
    );
    const [pack] = yield* db
      .select()
      .from(passPurchases)
      .where(eq(passPurchases.id, order.id));
    const snapshotProduct = input.details.snapshot.product;
    if (
      !pack ||
      pack.locale !== input.locale ||
      commitment.product.kind !== pack.product ||
      commitment.product.tier !== pack.tier ||
      (commitment.product.kind === "entry-pack" &&
        commitment.product.size !== pack.entryCount) ||
      commitment.firstServiceDate !== pack.validFrom ||
      snapshotProduct.kind !== pack.product ||
      snapshotProduct.tier !== pack.tier ||
      (snapshotProduct.kind === "entry-pack" &&
        snapshotProduct.size !== pack.entryCount) ||
      input.details.snapshot.serviceDate !== pack.validFrom ||
      Boolean(input.details.snapshot.unlimitedCoffee) !==
        Boolean(pack.unlimitedCoffee) ||
      !moneyEquals(
        withPassPurchaseAddons(
          pack.quote.discountedSubtotal,
          pack.unlimitedCoffee
        ),
        input.amount
      )
    ) {
      return yield* paymentError(
        order.id,
        "The Entry pack price no longer matches the purchase."
      );
    }
    if (
      order.activePaymentAttemptId !== input.details.approvedAfterAttemptId ||
      (order.activePaymentAttemptId
        ? !isEndedUnpaidPaymentState(order.paymentState)
        : order.paymentState !== "not_started")
    )
      return yield* staleApproval(order.id);

    if (order.activePaymentAttemptId) {
      const [prior] = yield* readAttempt(
        order.id,
        order.activePaymentAttemptId
      );
      if (
        !prior ||
        !isEndedUnpaidPaymentState(prior.state) ||
        prior.refundState !== "not_required"
      )
        return yield* staleApproval(order.id);
    }
    const now = yield* currentInstant;
    if (
      pack.product === "entry-pack" &&
      isEntryPackQuoteExpired(now, pack.validUntil)
    ) {
      return yield* paymentError(
        order.id,
        "The Entry pack quote expired. Request a new quote."
      );
    }
    if (pack.product === "unlimited") {
      if (hasUnlimitedPassFirstDayEnded(pack, now)) {
        return yield* firstDayAdmissionExpired(order.id);
      }
      yield* readPayableUnlimitedHolds(pack).pipe(
        Effect.catchTag("UnlimitedPassHoldsUnavailable", () =>
          Effect.fail(staleApproval(order.id))
        )
      );
    }
    yield* ReferralInvitationLedger.admitFirstBooking({
      orderId: order.id,
      dotyposCustomerId: order.dotyposCustomerId,
      admitsInvitation: claims.referral !== undefined,
    }).pipe(
      Effect.catchTag("ReferralFirstBookingAdmittedError", ({ message }) =>
        Effect.fail(paymentError(order.id, message))
      )
    );

    yield* input.details.recordConsent;
    if (
      pack.product === "unlimited" &&
      hasUnlimitedPassFirstDayEnded(pack, yield* currentInstant)
    ) {
      return yield* firstDayAdmissionExpired(order.id);
    }
    const attempt = yield* insertPaymentAttempt({
      orderId: order.id,
      workspaceReservationId: null,
      amount: input.amount,
      ...(providerAdmission ?? { provider: "internal", paidAt: now }),
    });
    yield* snapshots.recordPassPurchase({
      snapshot: input.details.snapshot,
      paymentAttemptId: attempt.id,
      orderId: order.id,
      dotyposCustomerId: order.dotyposCustomerId,
      amount: input.amount,
      locale: input.locale,
    });
    const applicationRows = yield* persistDiscountApplications({
      commitment,
      paymentAttemptId: attempt.id,
      workspaceReservationId: null,
    });
    yield* reserveCommittedClaims({
      claimedApplications: claims,
      applicationRows,
      paymentAttemptId: attempt.id,
      locale: input.locale,
      reservationCustomerId: order.dotyposCustomerId,
      reservationExpiresAt: now.add({ hours: 1 }),
      firstServiceDate: pack.validFrom,
    });
    if (!providerAdmission) {
      yield* redeemClaims(order, attempt.id, now, false);
      return yield* setPaid(order, attempt, now);
    }
    yield* db
      .update(orders)
      .set({
        activePaymentAttemptId: attempt.id,
        paymentState: "pending",
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));
    if (pack.product === "unlimited") {
      yield* db
        .update(workspaceReservations)
        .set({ paymentState: "pending", updatedAt: now })
        .where(eq(workspaceReservations.passId, order.id));
    }
    if (pack.status === "void") {
      yield* db
        .update(passPurchases)
        .set({ status: "pending_payment" })
        .where(
          and(eq(passPurchases.id, order.id), eq(passPurchases.status, "void"))
        );
    }
    return transition(attempt, true, now);
  });

  const fulfillBuyer = Effect.fn("entryPack.fulfillBuyer")(
    function* (orderId: OrderId) {
      const [paid] = yield* db
        .select({ order: orders, purchase: passPurchases })
        .from(orders)
        .innerJoin(passPurchases, eq(orders.id, passPurchases.id))
        .where(and(eq(orders.id, orderId), eq(orders.paymentState, "paid")));
      if (!paid) return;
      const {
        purchase,
        order: { paidAt, activePaymentAttemptId, fulfillmentState },
      } = paid;
      if (!paidAt || !activePaymentAttemptId)
        return yield* paymentError(
          orderId,
          "Paid Entry pack has no active payment attempt."
        );
      const gift = purchase.buyerAccountId !== purchase.holderAccountId;
      if (
        fulfillmentState !== "not_started" &&
        fulfillmentState !== "awaiting_delivery"
      ) {
        return;
      }
      const attemptIsActive = and(
        eq(orders.id, orderId),
        eq(orders.paymentState, "paid"),
        eq(orders.activePaymentAttemptId, activePaymentAttemptId)
      );
      const confirmation = yield* Effect.gen(function* () {
        if (fulfillmentState !== "not_started") return;
        const snapshot = yield* snapshots.findPassPurchase(
          activePaymentAttemptId
        );
        if (!snapshot) {
          return yield* paymentError(
            orderId,
            "Paid Entry pack has no accounting snapshot."
          );
        }
        const buyer = yield* findPurchaseLoginEmail(
          purchase.buyerAccountId
        ).pipe(Effect.provide(services));
        if (buyer) {
          const holderEmail = gift
            ? ((yield* findPurchaseLoginEmail(purchase.holderAccountId).pipe(
                Effect.provide(services)
              )) ?? null)
            : null;
          const invitationSent = gift
            ? yield* recordConfirmationInvitationState(orderId).pipe(
                Effect.provide(services)
              )
            : false;
          yield* sendEntryPackPurchaseEmail({
            purchase,
            paymentAttemptId: activePaymentAttemptId,
            buyer: { email: buyer },
            holderEmail,
            gift,
            invitationSent,
            paidAt,
            invoiceRequested: snapshot.billing.invoice !== "none",
          }).pipe(Effect.provide(sendingServices));
        }
        // Confirmation settled. Any remaining work belongs to the invoice ledger.
        yield* db
          .update(orders)
          .set({
            fulfillmentState: "awaiting_delivery",
            updatedAt: yield* currentInstant,
          })
          .where(
            and(attemptIsActive, eq(orders.fulfillmentState, "not_started"))
          );
      }).pipe(Effect.result);
      const invoicing = yield* Effect.gen(function* () {
        const invoiceId = yield* invoices.issueEntryPack({
          orderId,
          paymentAttemptId: activePaymentAttemptId,
        });
        if (!invoiceId) return true;
        const delivery = yield* invoiceDelivery.deliverByInvoiceId({
          invoiceId,
        });
        if (delivery.status === "cancelled") return true;
        const ledger = (yield* invoiceDeliveryLedger.status([invoiceId])).get(
          invoiceId
        );
        return (
          ledger?.sentTo.includes("customer") === true &&
          ledger.sentTo.includes("internal")
        );
      }).pipe(Effect.result);
      if (Result.isFailure(confirmation))
        return yield* Effect.fail(confirmation.failure);
      if (Result.isFailure(invoicing))
        return yield* Effect.fail(invoicing.failure);
      if (!invoicing.success) return;
      const now = yield* currentInstant;
      yield* db
        .update(orders)
        .set({
          fulfillmentState: "fulfilled",
          fulfilledAt: now,
          updatedAt: now,
        })
        .where(
          and(attemptIsActive, eq(orders.fulfillmentState, "awaiting_delivery"))
        );
    },
    (effect, orderId) =>
      effect.pipe(
        WorkspaceLockSections.passPurchaseFulfillment(orderId),
        Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock)
      )
  );

  const fulfillGift = Effect.fn("entryPack.fulfillGift")(function* (
    orderId: OrderId
  ) {
    const [target] = yield* db
      .select({
        generation: entryPackGiftInvitations.generation,
        holderAccountId: passPurchases.holderAccountId,
        paymentAttemptId: orders.activePaymentAttemptId,
      })
      .from(entryPackGiftInvitations)
      .innerJoin(
        passPurchases,
        eq(passPurchases.id, entryPackGiftInvitations.orderId)
      )
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.paymentState, "paid"),
          eq(
            entryPackGiftInvitations.holderAccountId,
            passPurchases.holderAccountId
          ),
          ne(passPurchases.buyerAccountId, passPurchases.holderAccountId),
          lte(entryPackGiftInvitations.nextAttemptAt, yield* currentInstant)
        )
      );
    if (!target?.paymentAttemptId) return;

    // Account deletion takes this same section. Acquire it before the order
    // section, and release it before the buyer's independent fulfillment.
    yield* customerAccounts
      .withActiveAccount(
        target.holderAccountId,
        deliverPendingEntryPackInvitation(
          orderId,
          target.paymentAttemptId
        ).pipe(
          Effect.provide(sendingServices),
          Effect.provide(SealedStateKeys.Default),
          Effect.timeout("10 seconds")
        ),
        { recheck: "active", passPurchaseOrderId: orderId }
      )
      .pipe(
        Effect.catchTag("CustomerAccountAccessError", (failure) =>
          failure.reason === "unauthenticated" ||
          failure.linkReason === "deletion-requested"
            ? db
                .update(entryPackGiftInvitations)
                .set({ nextAttemptAt: null })
                .where(
                  and(
                    eq(entryPackGiftInvitations.orderId, orderId),
                    eq(entryPackGiftInvitations.generation, target.generation),
                    eq(
                      entryPackGiftInvitations.holderAccountId,
                      target.holderAccountId
                    )
                  )
                )
                .pipe(Effect.asVoid)
            : Effect.logWarning("Entry pack gift holder could not be rechecked")
        )
      );
  });

  const fulfillUnlimited = Effect.fn("unlimitedPass.fulfillDays")(
    function* (orderId: OrderId) {
      const [purchase] = yield* db
        .select()
        .from(passPurchases)
        .where(eq(passPurchases.id, orderId));
      if (
        purchase?.product !== "unlimited" ||
        purchase.status === "active" ||
        purchase.status === "withdrawn"
      )
        return true;
      if (purchase.status !== "pending_payment") return false;
      const [order] = yield* readOrder(orderId);
      if (order?.paymentState !== "paid" || !order.activePaymentAttemptId)
        return false;
      const attemptId = order.activePaymentAttemptId;
      if (!(yield* canConfirmUnlimitedPass(orderId, attemptId))) return false;
      if (Option.isNone(dotypos))
        return yield* paymentError(
          orderId,
          "Pass day provider is unavailable."
        );
      const confirmation = yield* confirmUnlimitedPassDays(purchase).pipe(
        Effect.provideService(DotyposService, dotypos.value),
        Effect.result
      );
      if (Result.isFailure(confirmation)) {
        const cause = confirmation.failure;
        const rejected =
          cause._tag === "DotyposReservationCancelledError" ||
          (cause._tag === "DotyposRejected" && cause.reason === "not-found") ||
          (cause._tag === "UnlimitedPassHoldsUnavailable" &&
            cause.reason === "changed");
        if (!(yield* canConfirmUnlimitedPass(orderId, attemptId, rejected)))
          return false;
        return yield* paymentError(
          orderId,
          "Unlimited pass day confirmation needs reconciliation."
        );
      }
      return (yield* settlePassPurchase(orderId, attemptId)) !== undefined;
    },
    (effect, orderId) =>
      effect.pipe(
        WorkspaceLockSections.passPurchaseFulfillment(orderId),
        Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock),
        Effect.provide(services)
      )
  );

  const fulfill = Effect.fn("passPurchase.fulfill")(function* (
    orderId: OrderId
  ) {
    if (!(yield* fulfillUnlimited(orderId))) return;
    yield* fulfillGift(orderId).pipe(
      Effect.catch(() =>
        Effect.logWarning("Entry pack gift fulfillment could not complete")
      )
    );
    yield* fulfillBuyer(orderId);
  });

  const recordLateCapture = Effect.fnUntraced(function* (
    input: Verification,
    attempt: AttemptRow,
    refundRequired: boolean
  ) {
    const [paid] = yield* db
      .update(paymentAttempts)
      .set({
        state: "paid",
        refundState: refundRequired ? "required" : "not_required",
        failureCode: null,
        lastWebhookEventId: input.webhookEventId,
        lastProviderOperationId: input.providerOperationId,
        lastProviderStatus: input.providerStatus,
        updatedAt: input.paidAt,
      })
      .where(eq(paymentAttempts.id, attempt.id))
      .returning();
    if (!paid)
      return yield* paymentError(
        input.orderId,
        "The late Entry pack attempt was not found."
      );
    return paid;
  });

  const recoverEntryPack = Effect.fn("entryPack.recoverPayment")(function* (
    input: Verification
  ) {
    const order = yield* lockOrder(input.orderId, { claimOf: input.id });
    const [attempt] = yield* readAttempt(order.id, input.id).for("update");
    if (!attempt || attempt.provider === "internal") {
      return yield* paymentError(
        order.id,
        "The late Entry pack attempt was not found."
      );
    }
    if (attempt.state === "paid")
      return (
        order.activePaymentAttemptId === attempt.id &&
        order.paymentState === "paid"
      );
    if (!isEndedUnpaidPaymentState(attempt.state)) {
      return yield* paymentError(
        order.id,
        "Only a terminal attempt can be recovered."
      );
    }

    if (
      order.activePaymentAttemptId === attempt.id &&
      isEndedUnpaidPaymentState(order.paymentState)
    ) {
      const recovered = yield* transaction(
        Effect.gen(function* () {
          yield* redeemClaims(order, attempt.id, input.paidAt, true);
          const paid = yield* recordLateCapture(input, attempt, false);
          yield* setPaid(order, paid, input.paidAt);
          return true;
        }).pipe(Effect.provide(services))
      ).pipe(
        Effect.catchTag("DiscountClaimError", () => Effect.succeed(false))
      );
      if (recovered) return true;
    }
    yield* recordLateCapture(input, attempt, true);
    return false;
  });

  const finishUnlimitedRecovery = Effect.fn("unlimitedPass.finishRecovery")(
    function* (
      orderId: OrderId,
      attemptId: PaymentAttemptId,
      prep?: "ready" | "unavailable",
      verification?: Verification
    ) {
      const order = yield* lockOrder(
        orderId,
        prep === "ready" ? { claimOf: attemptId } : "nothing"
      );
      const [existing] = yield* readAttempt(orderId, attemptId).for("update");
      if (!existing || existing.provider === "internal") {
        return yield* paymentError(
          orderId,
          "The late Unlimited pass attempt was not found."
        );
      }
      if (
        existing.state !== "paid" &&
        (!verification || !isEndedUnpaidPaymentState(existing.state))
      ) {
        return yield* paymentError(
          orderId,
          "Only a verified terminal attempt can start recovery."
        );
      }
      // The attempt records the verified provider capture before any provider work.
      const newCapture = existing.state !== "paid" ? verification : undefined;
      const attempt = newCapture
        ? yield* recordLateCapture(newCapture, existing, false)
        : existing;

      const winningAttempt = order.activePaymentAttemptId === attempt.id;
      if (winningAttempt && order.paymentState === "paid")
        return "fulfill" as const;

      const canRecover =
        winningAttempt && isEndedUnpaidPaymentState(order.paymentState);
      const capturedAt = newCapture?.paidAt ?? order.paidAt;
      if (canRecover && newCapture) {
        // The order retains the winning capture time when later refund writes
        // change the attempt's updatedAt.
        yield* db
          .update(orders)
          .set({ paidAt: newCapture.paidAt })
          .where(eq(orders.id, orderId));
      }
      const refundAllowsRecovery =
        attempt.refundState === "not_required" ||
        isUnsolicitedPartialPassRefund(attempt);
      if (
        canRecover &&
        capturedAt &&
        refundAllowsRecovery &&
        prep !== "unavailable"
      ) {
        if (!prep) return "prepare" as const;
        const [purchase] = yield* db
          .select()
          .from(passPurchases)
          .where(eq(passPurchases.id, orderId));
        if (purchase?.status === "pending_payment") {
          // A failed local read or an expired replacement hold leaves the captured
          // attempt for reconciliation. A rejected claim is a definitive refusal.
          yield* readPayableUnlimitedHolds(purchase);
          const recovered = yield* transaction(
            Effect.gen(function* () {
              yield* requireUnlimitedPassWindow({
                orderId,
                holderAccountId: purchase.holderAccountId,
                validFrom: purchase.validFrom,
                validUntil: purchase.validUntil,
              });
              yield* redeemClaims(order, attempt.id, capturedAt, true);
              if (
                hasUnlimitedPassFirstDayEnded(purchase, yield* currentInstant)
              ) {
                return yield* new UnlimitedPassFirstDayEnded();
              }
              yield* setPaid(order, attempt, capturedAt);
              return true;
            }).pipe(Effect.provide(services))
          ).pipe(
            Effect.catchTags({
              DiscountClaimError: () => Effect.succeed(false),
              UnlimitedPassAdmissionError: () => Effect.succeed(false),
              UnlimitedPassFirstDayEnded: () => Effect.succeed(false),
            })
          );
          if (recovered) return "fulfill" as const;
        }
      }

      if (
        !canRecover ||
        !capturedAt ||
        prep === "unavailable" ||
        (prep === "ready" && refundAllowsRecovery)
      ) {
        yield* requireFullPassRefund(attempt, yield* currentInstant);
      }
      if (canRecover) yield* settlePassPurchase(orderId);
      return "done" as const;
    }
  );

  const recoverUnlimited = Effect.fn("unlimitedPass.recoverPayment")(
    function* (
      orderId: OrderId,
      attemptId: PaymentAttemptId,
      verification?: Verification
    ) {
      const next = yield* transaction(
        finishUnlimitedRecovery(orderId, attemptId, undefined, verification)
      );
      if (next !== "prepare") return next;
      if (
        Option.isNone(dotypos) ||
        Option.isNone(calendarLimitations) ||
        Option.isNone(reservations)
      ) {
        return yield* paymentError(
          orderId,
          "Unlimited pass recovery providers are unavailable."
        );
      }
      const ready = yield* prepareUnlimitedPassRecovery(
        orderId,
        attemptId
      ).pipe(
        Effect.provideService(DotyposService, dotypos.value),
        Effect.provideService(
          GoogleCalendarWorkspaceLimitationsService,
          calendarLimitations.value
        ),
        Effect.provideService(
          WorkspaceReservationRepository,
          reservations.value
        )
      );
      return yield* transaction(
        finishUnlimitedRecovery(
          orderId,
          attemptId,
          ready ? "ready" : "unavailable"
        )
      );
    },
    (effect, orderId) =>
      effect.pipe(
        WorkspaceLockSections.unlimitedPassRecovery(orderId),
        Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock),
        Effect.provide(services)
      )
  );

  return {
    load: (orderId) =>
      readOrder(orderId).pipe(
        Effect.map(([order]) =>
          order ? { ...order, logFields: { orderId } } : null
        )
      ),
    admitProvider: ({ provider, providerOrderId, ...input }) =>
      transaction(
        admit(input, { provider, providerOrderId }).pipe(
          Effect.provide(services)
        )
      ).pipe(Effect.map(({ attempt }) => attempt)),
    admitInternal: (input) =>
      transaction(admit(input).pipe(Effect.provide(services))),
    attachProviderSession: (input) =>
      attachPaymentProviderSession(input).pipe(Effect.provide(services)),
    markPaid: (input) =>
      transaction(
        Effect.gen(function* () {
          const order = yield* lockOrder(input.orderId, { claimOf: input.id });
          const [existing] = yield* readAttempt(order.id, input.id);
          if (existing?.state === "paid")
            return transition(
              existing,
              false,
              order.paidAt ?? existing.updatedAt
            );
          if (
            order.paymentState !== "pending" ||
            order.activePaymentAttemptId !== input.id
          ) {
            return yield* paymentError(
              order.id,
              "Only the current Entry pack attempt can mark an order paid."
            );
          }
          yield* redeemClaims(order, input.id, input.paidAt, false);
          const paid = yield* markPaymentAttemptPaid(input);
          if (!paid)
            return yield* paymentError(
              order.id,
              "The Entry pack attempt is no longer pending."
            );
          return yield* setPaid(order, paid, input.paidAt);
        }).pipe(Effect.provide(services))
      ),
    markTerminal: (input) =>
      transaction(
        Effect.gen(function* () {
          const order = yield* lockOrder(input.orderId, "nothing");
          const [existing] = yield* readAttempt(order.id, input.id);
          if (!existing)
            return yield* paymentError(
              order.id,
              "The Entry pack attempt was not found."
            );
          if (
            isEndedUnpaidPaymentState(existing.state) ||
            existing.state === "paid"
          )
            return transition(existing, false);
          const terminalAt = yield* currentInstant;
          const terminal = yield* markPaymentAttemptTerminal({
            ...input,
            terminalAt,
            fromAttemptStates: input.fromAttemptStates ?? [
              "created",
              "pending",
            ],
          });
          if (!terminal) return transition(existing, false);
          yield* PromotionClaims.release({
            paymentAttemptId: terminal.id,
            releasedAt: terminalAt,
            releaseReason: input.failureCode,
          });
          yield* ReferralInvitationLedger.release({
            paymentAttemptId: terminal.id,
            releasedAt: terminalAt,
            releaseReason: input.failureCode,
          });
          if (
            order.paymentState === "pending" &&
            order.activePaymentAttemptId === terminal.id
          ) {
            yield* db
              .update(orders)
              .set({ paymentState: input.state, updatedAt: terminalAt })
              .where(eq(orders.id, order.id));
            yield* settlePassPurchase(order.id);
          }
          return transition(terminal, true);
        }).pipe(Effect.provide(services))
      ),
    fulfill,
    scheduleFulfillment: ({ orderId }) =>
      fulfill(orderId).pipe(
        Effect.catch(() =>
          Effect.logWarning("Entry pack fulfillment could not complete", {
            orderId,
          })
        )
      ),
    startRecovery: Effect.fn("passPurchase.startRecovery")(function* ({
      paymentAttemptId,
      verifiedPaidAt,
      ...input
    }: Parameters<Handler["startRecovery"]>[0]) {
      const [pass] = yield* db
        .select({ product: passPurchases.product })
        .from(passPurchases)
        .where(eq(passPurchases.id, input.orderId));
      const verification = {
        ...input,
        id: paymentAttemptId,
        paidAt: verifiedPaidAt,
      };
      const recovered =
        pass?.product === "unlimited"
          ? (yield* recoverUnlimited(
              input.orderId,
              paymentAttemptId,
              verification
            )) === "fulfill"
          : yield* transaction(recoverEntryPack(verification));
      if (recovered) yield* fulfill(input.orderId);
    }, Effect.provide(services)),
    resumeRecovery: Effect.fn("entryPack.resumeRecovery")(function* ({
      orderId,
      paymentAttemptId,
    }: Parameters<Handler["resumeRecovery"]>[0]) {
      const [attempt] = yield* readAttempt(orderId, paymentAttemptId);
      if (attempt?.state !== "paid") return false;
      const [pass] = yield* db
        .select({ product: passPurchases.product })
        .from(passPurchases)
        .where(eq(passPurchases.id, orderId));
      if (pass?.product === "unlimited") {
        if ((yield* recoverUnlimited(orderId, paymentAttemptId)) === "fulfill")
          yield* fulfill(orderId);
      } else if (attempt.refundState === "not_required") {
        yield* fulfill(orderId);
      }
      return true;
    }),
  } satisfies Handler;
});
