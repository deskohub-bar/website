import type { DotyposCustomerId } from "@deskohub/dotypos";
import { and, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  discountApplications,
  discountCodeRedemptions,
  latePaymentRecoveries,
  type PaymentAttemptRow,
  paymentAttempts,
  referralInvitationClaims,
  reservationPaymentWindows,
  voucherRedemptions,
  type WorkspaceReservationRow,
  workspaceReservations,
} from "@/db/schema";
import {
  type AccountingDocumentSnapshot,
  getAccountingDocumentSnapshotFirstServiceDate,
} from "@/features/accounting/accounting-document-snapshot";
import {
  AccountingDocumentSnapshots,
  type AccountingRecordUnavailable,
} from "@/features/accounting/backend/accounting-document-snapshots";
import { AccountingStorage } from "@/features/accounting/backend/accounting-storage";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE } from "@/features/checkout/payment-fallback";
import { getWorkspaceProductKey } from "@/features/checkout/product-identity";
import {
  type DiscountCommitment,
  getDiscountCommitmentPayload,
} from "@/features/discounts/commitment";
import type { AppliedDiscount } from "@/features/discounts/contracts";
import { DiscountClaimError } from "@/features/discounts/errors";
import type { DiscountApplicationId } from "@/features/discounts/persistence-contracts";
import {
  type PromotionClaim,
  PromotionClaims,
} from "@/features/discounts/promotion-claims";
import type { DiscountClaimInstruction } from "@/features/discounts/provider";
import type { Locale } from "@/features/i18n";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import {
  consumeEntryPackClaim,
  findReservationEntryClaim,
} from "@/features/passes/backend/entry-pack-redemption";
import { ReferralInvitationLedger } from "@/features/referrals/referral-invitation-ledger";
import {
  reservationIdForOrder,
  type WorkspaceReservationId,
} from "@/features/reservation/persistence-contracts";
import type { QueueMessageSendError } from "@/shared/backend/queue/queue-publisher";
import { type Money, moneyEquals, moneyWithValue } from "@/shared/money/money";
import { FioPollWake } from "../fio/fio-poll-wake.service";
import type {
  PaymentProvider,
  RetriedPaymentAttempt,
} from "../payment/payment-provider";
import { newestPaymentAttemptsFirst } from "./newest-payment-attempt";
import {
  type PaymentAttempt,
  toPaymentAttempt,
} from "./payment-attempt.repository";
import {
  attachPaymentProviderSession,
  insertPaymentAttempt,
  markPaymentAttemptPaid,
  markPaymentAttemptTerminal,
  type SharedCardSettlement,
  verifiedSettlementEvidence,
} from "./payment-attempt-writes";
import {
  findPaymentReservationCustomer,
  lifecycleStateError,
  type NonTerminalPaymentAttemptState,
  PaymentLifecycleStateError,
  type PaymentLifecycleTransition,
  publicPaymentWindowExpiredFailureCode,
} from "./payment-lifecycle-state";
import { PaymentTerminalTransitions } from "./payment-terminal-transitions";

export type PaymentLifecycleRepositoryError =
  | AccountingRecordUnavailable
  | DiscountClaimError
  | EffectDrizzleQueryError
  | PaymentLifecycleStateError
  | SqlError
  | QueueMessageSendError;

export const administrationForcedPaymentCancellationFailureCode =
  "admin_forced_payment_cancellation";

const ensureEntryPackPayment = Effect.fnUntraced(function* (input: {
  readonly reservationId: WorkspaceReservationId;
  readonly snapshot: AccountingDocumentSnapshot;
  readonly commitment: ReturnType<typeof getDiscountCommitmentPayload>;
  readonly operation:
    | "completeInternalPayment"
    | "createPendingProviderAttempt";
}) {
  const { db } = yield* WorkspaceTransaction;
  const claim = yield* findReservationEntryClaim(db, input.reservationId);
  const { quote } = input.snapshot;
  const entryPack = "entryPack" in quote ? quote.entryPack : undefined;
  if (!claim && !entryPack) return;
  if (
    !entryPack ||
    claim?.status !== "reserved" ||
    claim.passId !== entryPack.passId ||
    claim.date !==
      getAccountingDocumentSnapshotFirstServiceDate(input.snapshot) ||
    input.commitment.applications.length > 0 ||
    quote.payment.discounts.length > 0
  ) {
    return yield* lifecycleStateError(
      input.operation,
      { type: "workspaceReservationId", id: input.reservationId },
      "The reserved Entry pack claim must match the checkout price."
    );
  }
});

type PublicPayment = { readonly accountKey: string };

type FirstPaymentAdmission = {
  readonly commitment: DiscountCommitment;
  readonly accountingSnapshot: AccountingDocumentSnapshot;
  readonly publicPayment?: PublicPayment & {
    readonly useAcceptedCommitment?: false;
  };
};

type ResumePaymentAdmission = {
  readonly commitment?: never;
  readonly accountingSnapshot?: never;
  readonly publicPayment: PublicPayment & {
    readonly useAcceptedCommitment: true;
  };
};

type PaymentAdmissionInput = {
  readonly orderId: OrderId;
  readonly amount: Money;
  readonly locale: Locale;
} & (FirstPaymentAdmission | ResumePaymentAdmission);

type CardPaymentAdmission = PaymentAdmissionInput & {
  readonly provider: PaymentProvider;
  readonly providerOrderId: string;
  readonly retriedAttempt?: RetriedPaymentAttempt;
};

type QrPaymentAdmission = PaymentAdmissionInput & {
  readonly publicPayment: PublicPayment;
};

type RecordedQrPayment =
  | {
      readonly status: "winner";
      readonly transition: PaymentLifecycleTransition;
    }
  | { readonly status: "recover" | "refund" };

export interface IPaymentLifecycleRepository {
  readonly createPendingProviderAttempt: (
    input: CardPaymentAdmission
  ) => Effect.Effect<PaymentAttempt, PaymentLifecycleRepositoryError>;
  readonly createPendingQrAttempt: (
    input: QrPaymentAdmission
  ) => Effect.Effect<
    PaymentAttempt,
    PaymentLifecycleRepositoryError,
    FioPollWake
  >;
  readonly recordVerifiedQrPayment: (input: {
    readonly orderId: OrderId;
    readonly id: PaymentAttemptId;
    readonly providerOperationId: string;
    readonly paidAt: Temporal.Instant;
  }) => Effect.Effect<RecordedQrPayment, PaymentLifecycleRepositoryError>;
  readonly completeInternalPayment: (input: {
    readonly orderId: OrderId;
    readonly amount: Money;
    readonly commitment: DiscountCommitment;
    readonly locale: Locale;
    readonly accountingSnapshot: AccountingDocumentSnapshot;
  }) => Effect.Effect<
    PaymentLifecycleTransition,
    PaymentLifecycleRepositoryError
  >;
  readonly attachProviderSession: (input: {
    readonly id: PaymentAttemptId;
    readonly securityToken: string;
    readonly providerRedirectUrl: string;
  }) => Effect.Effect<
    PaymentAttempt,
    EffectDrizzleQueryError | PaymentLifecycleStateError
  >;
  readonly markPaid: (input: {
    readonly id: PaymentAttemptId;
    readonly orderId: OrderId;
    readonly webhookEventId?: string;
    readonly providerOperationId?: string;
    readonly providerStatus?: string;
    readonly paidAt: Temporal.Instant;
  }) => Effect.Effect<
    PaymentLifecycleTransition,
    PaymentLifecycleRepositoryError
  >;
  /** Expire both exposed methods and release the order's accepted claims once. */
  readonly expirePublicPaymentWindow: (input: {
    readonly orderId: OrderId;
    readonly checkedAt: Temporal.Instant;
  }) => Effect.Effect<boolean, PaymentLifecycleRepositoryError>;
  readonly markTerminal: (input: {
    readonly id: PaymentAttemptId;
    readonly orderId: OrderId;
    readonly state: "failed" | "cancelled" | "expired";
    readonly failureCode: string;
    readonly webhookEventId?: string;
    readonly providerOperationId?: string;
    readonly providerStatus?: string;
    /**
     * Non-terminal attempt states the transition may start from; defaults to
     * both. Pass `["created"]` to end an attempt only while no provider
     * session has been attached to it.
     */
    readonly fromAttemptStates?: readonly NonTerminalPaymentAttemptState[];
  }) => Effect.Effect<
    PaymentLifecycleTransition,
    PaymentLifecycleRepositoryError
  >;
}

/**
 * A payment that settled late on one of the order's earlier attempts is
 * being recovered or was refunded: the order admits no new payment, so a
 * retry never charges it again while that recovery decides.
 */
const noLatePaymentRecovery = notExists(
  sql`(select 1 from ${latePaymentRecoveries} where ${latePaymentRecoveries.workspaceReservationId} = ${workspaceReservations.id})`
);

type ReservationPaymentWindow = typeof reservationPaymentWindows.$inferSelect;

const windowIncludesAttempt = (
  window: ReservationPaymentWindow,
  attemptId: PaymentAttemptId | null
) =>
  attemptId !== null &&
  (window.cardAttemptId === attemptId || window.qrAttemptId === attemptId);

const releaseWindowClaims = Effect.fnUntraced(function* (
  paymentAttemptId: PaymentAttemptId,
  releasedAt: Temporal.Instant
) {
  const claim = {
    paymentAttemptId,
    releasedAt,
    releaseReason: publicPaymentWindowExpiredFailureCode,
  };
  yield* PromotionClaims.release(claim);
  yield* ReferralInvitationLedger.release(claim);
});

const canRecoverPublicReservation = (
  reservation: WorkspaceReservationRow,
  window: ReservationPaymentWindow
) =>
  reservation.dotyposReservationId !== null &&
  reservation.activePaymentAttemptId !== null &&
  windowIncludesAttempt(window, reservation.activePaymentAttemptId) &&
  reservation.paymentState !== "paid" &&
  reservation.reservationState !== "confirmed" &&
  reservation.failureCode !==
    administrationForcedPaymentCancellationFailureCode &&
  reservation.cancellationCause !== "checkout_superseded" &&
  reservation.cancellationCause !== "operator" &&
  reservation.cancellationCause !== "customer_withdrawal";

const admitLatePublicSettlement = Effect.fnUntraced(function* (
  input: Parameters<IPaymentLifecycleRepository["markPaid"]>[0],
  reservation: WorkspaceReservationRow | undefined,
  window: ReservationPaymentWindow
) {
  if (
    !reservation?.dotyposReservationId ||
    !reservation.activePaymentAttemptId ||
    !canRecoverPublicReservation(reservation, window)
  )
    return undefined;

  const { db } = yield* WorkspaceTransaction;
  const workspaceReservationId = reservation.id;
  const [recovery] = yield* db
    .select()
    .from(latePaymentRecoveries)
    .where(
      inArray(latePaymentRecoveries.paymentAttemptId, [
        reservation.activePaymentAttemptId,
        input.id,
      ])
    )
    .limit(1);
  if (recovery) {
    if (recovery.paymentAttemptId !== input.id) return undefined;

    const receivedOperationId = input.providerOperationId ?? null;
    const savedOperationId = recovery.providerOperationId;
    const cardReplayWithMissingId =
      window.cardAttemptId === input.id &&
      (savedOperationId === null || receivedOperationId === null);
    if (savedOperationId !== receivedOperationId && !cardReplayWithMissingId)
      return undefined;

    if (savedOperationId === null && receivedOperationId !== null) {
      yield* db
        .update(latePaymentRecoveries)
        .set({ providerOperationId: receivedOperationId })
        .where(
          and(
            eq(latePaymentRecoveries.paymentAttemptId, input.id),
            isNull(latePaymentRecoveries.providerOperationId)
          )
        );
    }

    const [attempt] = yield* db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, input.id))
      .limit(1);
    return attempt ? toPaymentAttempt(attempt) : undefined;
  }

  const [attempt] = yield* db
    .update(paymentAttempts)
    .set({
      state: "expired",
      failureCode: publicPaymentWindowExpiredFailureCode,
      updatedAt: input.paidAt,
    })
    .where(
      and(eq(paymentAttempts.id, input.id), ne(paymentAttempts.state, "paid"))
    )
    .returning();
  if (!attempt) return undefined;
  if (reservation.activePaymentAttemptId !== input.id) {
    yield* bindAcceptedClaimsToWinner(
      reservation.activePaymentAttemptId,
      input.id
    );
  }
  yield* releaseWindowClaims(input.id, input.paidAt);
  yield* db
    .update(workspaceReservations)
    .set({
      activePaymentAttemptId: input.id,
      paymentState: "expired",
      updatedAt: input.paidAt,
    })
    .where(eq(workspaceReservations.id, workspaceReservationId));

  yield* db.insert(latePaymentRecoveries).values({
    paymentAttemptId: input.id,
    workspaceReservationId,
    originalDotyposReservationId: reservation.dotyposReservationId,
    webhookEventId: input.webhookEventId,
    providerOperationId: input.providerOperationId,
    providerStatus: input.providerStatus,
    verifiedPaidAt: input.paidAt,
    state: "pending",
  });
  return toPaymentAttempt(attempt);
});

const bindAcceptedClaimsToWinner = Effect.fnUntraced(function* (
  original: PaymentAttemptId,
  winner: PaymentAttemptId
) {
  const { db } = yield* WorkspaceTransaction;
  yield* db
    .update(discountApplications)
    .set({ paymentAttemptId: winner })
    .where(eq(discountApplications.paymentAttemptId, original));
  yield* db
    .update(discountCodeRedemptions)
    .set({ paymentAttemptId: winner })
    .where(eq(discountCodeRedemptions.paymentAttemptId, original));
  yield* db
    .update(voucherRedemptions)
    .set({ paymentAttemptId: winner })
    .where(eq(voucherRedemptions.paymentAttemptId, original));
  yield* db
    .update(referralInvitationClaims)
    .set({ paymentAttemptId: winner })
    .where(eq(referralInvitationClaims.paymentAttemptId, original));
});

const cardRefundTransition = (attempt: PaymentAttemptRow) => ({
  attempt: toPaymentAttempt(attempt),
  changed: false,
  timestamp: attempt.updatedAt,
  settlement: "refund_required" as const,
});

const requireCardSettlementRefund = Effect.fnUntraced(function* (
  input: Parameters<IPaymentLifecycleRepository["markPaid"]>[0],
  attempt: PaymentAttemptRow | undefined
) {
  const { db } = yield* WorkspaceTransaction;
  if (attempt?.provider !== "nexi") {
    return yield* lifecycleStateError(
      "markPaid",
      { type: "paymentAttemptId", id: input.id },
      "Only the card provider can settle a duplicate on this path."
    );
  }
  const alreadyPaid = attempt.state === "paid";
  const evidence = verifiedSettlementEvidence(input, attempt);
  if (
    alreadyPaid &&
    evidence.lastWebhookEventId === attempt.lastWebhookEventId &&
    evidence.lastProviderOperationId === attempt.lastProviderOperationId &&
    evidence.lastProviderStatus === attempt.lastProviderStatus
  ) {
    return cardRefundTransition(attempt);
  }

  const [refundable] = yield* db
    .update(paymentAttempts)
    .set({
      ...evidence,
      ...(!alreadyPaid && {
        state: "paid",
        refundState: "required",
        failureCode: null,
        updatedAt: input.paidAt,
      }),
    })
    .where(eq(paymentAttempts.id, input.id))
    .returning();
  if (!refundable)
    return yield* Effect.die("Card settlement update returned no row.");
  return cardRefundTransition(refundable);
});

const nextQrReference = Effect.gen(function* () {
  const { db } = yield* WorkspaceTransaction;
  const result = yield* db.execute<{ reference: string }>(
    sql`select nextval('qr_payment_references')::text as reference`
  );
  const reference = result.rows[0]?.reference;
  if (!reference)
    return yield* Effect.die("Could not allocate a QR payment reference.");
  return reference;
});

export class PaymentLifecycleRepository extends Context.Service<
  PaymentLifecycleRepository,
  IPaymentLifecycleRepository
>()("@deskohub-workspace/checkout/PaymentLifecycleRepository") {
  /**
   * The repository over the Workspace database and the accounting snapshots.
   * It composes `PaymentTerminalTransitions` over the same database itself:
   * that module is a part of this one, split out so its interface needs only
   * the database, not a capability callers configure.
   */
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db, transaction } = yield* WorkspaceDatabase;
      const accountingSnapshots = yield* AccountingDocumentSnapshots;
      const terminalTransitions = yield* PaymentTerminalTransitions;

      const admitFirstAttempt = Effect.fn(
        "PaymentLifecycleRepository.admitFirstAttempt"
      )(function* (
        input: FirstPaymentAdmission & {
          readonly orderId: OrderId;
          readonly provider: PaymentProvider | "fio";
          readonly providerOrderId: string;
          readonly retriedAttempt?: RetriedPaymentAttempt;
          readonly amount: Money;
          readonly locale: Locale;
          readonly expiresAt?: Temporal.Instant;
        }
      ) {
        const workspaceReservationId = reservationIdForOrder(input.orderId);
        const accountingSnapshot = yield* accountingSnapshots.prepare({
          snapshot: input.accountingSnapshot,
          orderId: input.orderId,
          amount: input.amount,
          locale: input.locale,
          reference: { type: "providerOrderId", id: input.providerOrderId },
        });
        const commitment = getDiscountCommitmentPayload(input.commitment);
        const claimedApplications =
          yield* validateDiscountCommitment(commitment);
        const firstServiceDate = yield* validateCommitmentFirstServiceDate(
          commitment,
          accountingSnapshot.snapshot
        );

        return yield* transaction(
          Effect.gen(function* () {
            const dotyposCustomerId = yield* findPaymentReservationCustomer(
              "createPendingProviderAttempt",
              workspaceReservationId
            );
            yield* ReferralInvitationLedger.lockFirstBooking({
              dotyposCustomerId,
              records: "nothing",
            });

            const [reservation] = yield* db
              .select({
                id: workspaceReservations.id,
                dotyposCustomerId: workspaceReservations.dotyposCustomerId,
                dotyposReservationId:
                  workspaceReservations.dotyposReservationId,
                reservationHoldExpiresAt:
                  workspaceReservations.reservationHoldExpiresAt,
                activePaymentAttemptId:
                  workspaceReservations.activePaymentAttemptId,
              })
              .from(workspaceReservations)
              .where(
                and(
                  eq(workspaceReservations.id, workspaceReservationId),
                  noLatePaymentRecovery,
                  eq(workspaceReservations.reservationState, "held"),
                  inArray(workspaceReservations.paymentState, [
                    "not_started",
                    "failed",
                    "cancelled",
                    "expired",
                  ])
                )
              )
              .limit(1)
              .for("update");

            const now = Temporal.Now.instant();
            if (
              !reservation?.reservationHoldExpiresAt ||
              Temporal.Instant.compare(
                reservation.reservationHoldExpiresAt,
                now
              ) <= 0
            ) {
              return yield* new PaymentLifecycleStateError({
                operation:
                  "PaymentLifecycleRepository.createPendingProviderAttempt",
                paymentReference: {
                  type: "providerOrderId",
                  id: input.providerOrderId,
                },
                message:
                  "Payment attempts can only be created for a current held reservation.",
              });
            }
            yield* ensureEntryPackPayment({
              reservationId: workspaceReservationId,
              snapshot: accountingSnapshot.snapshot,
              commitment,
              operation: "createPendingProviderAttempt",
            });

            // The checkout read happened before this row lock. A later
            // attempt may already have started and ended in that gap.
            if (input.retriedAttempt) {
              const [newest] = yield* db
                .select({
                  id: paymentAttempts.id,
                  state: paymentAttempts.state,
                  failureCode: paymentAttempts.failureCode,
                })
                .from(paymentAttempts)
                .where(
                  eq(
                    paymentAttempts.workspaceReservationId,
                    workspaceReservationId
                  )
                )
                .orderBy(...newestPaymentAttemptsFirst)
                .limit(1);
              if (
                reservation.activePaymentAttemptId !== null ||
                newest?.id !== input.retriedAttempt.id ||
                !isEndedUnpaidPaymentState(newest.state) ||
                (input.retriedAttempt.failureCode ===
                  NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE &&
                  newest.failureCode !== NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE)
              ) {
                return yield* new PaymentLifecycleStateError({
                  operation:
                    "PaymentLifecycleRepository.createPendingProviderAttempt",
                  paymentReference: {
                    type: "providerOrderId",
                    id: input.providerOrderId,
                  },
                  message:
                    "The payment attempt being retried is no longer current.",
                });
              }
            }

            yield* admitFirstBookingPayment({
              dotyposCustomerId: reservation.dotyposCustomerId,
              workspaceReservationId,
              admitsInvitation: claimedApplications.referral !== undefined,
              operation: "createPendingProviderAttempt",
            });

            const attemptRow = yield* insertPaymentAttempt({
              workspaceReservationId,
              orderId: input.orderId,
              amount: input.amount,
              provider: input.provider,
              providerOrderId: input.providerOrderId,
            });

            yield* accountingSnapshot.record({
              paymentAttemptId: attemptRow.id,
              dotyposCustomerId: reservation.dotyposCustomerId,
              dotyposReservationId: reservation.dotyposReservationId,
            });

            const [linked] = yield* db
              .update(workspaceReservations)
              .set({
                activePaymentAttemptId: attemptRow.id,
                paymentState: "pending",
                reservationHoldExpiresAt: input.expiresAt,
                updatedAt: now,
              })
              .where(
                and(
                  eq(workspaceReservations.id, workspaceReservationId),
                  noLatePaymentRecovery,
                  eq(workspaceReservations.reservationState, "held"),
                  inArray(workspaceReservations.paymentState, [
                    "not_started",
                    "failed",
                    "cancelled",
                    "expired",
                  ])
                )
              )
              .returning({ id: workspaceReservations.id });

            if (!linked) {
              return yield* new PaymentLifecycleStateError({
                operation:
                  "PaymentLifecycleRepository.createPendingProviderAttempt",
                paymentReference: {
                  type: "paymentAttemptId",
                  id: attemptRow.id,
                },
                message:
                  "Payment attempts can only be linked to held unpaid reservations.",
              });
            }

            const applicationRows = yield* persistDiscountApplications({
              commitment,
              paymentAttemptId: attemptRow.id,
              workspaceReservationId,
            });
            yield* reserveCommittedClaims({
              claimedApplications,
              applicationRows,
              paymentAttemptId: attemptRow.id,
              locale: input.locale,
              reservationCustomerId: reservation.dotyposCustomerId,
              reservationExpiresAt:
                input.expiresAt ?? reservation.reservationHoldExpiresAt,
              firstServiceDate,
            });

            return toPaymentAttempt(attemptRow);
          })
        );
      });

      const admitPublicAttempt = Effect.fn(
        "PaymentLifecycleRepository.admitPublicAttempt"
      )(function* (
        input: PaymentAdmissionInput & {
          readonly publicPayment: PublicPayment;
          readonly provider: "nexi" | "fio";
          readonly providerOrderId?: string;
          readonly wake?: FioPollWake["Service"]["wake"];
        }
      ) {
        const workspaceReservationId = reservationIdForOrder(input.orderId);
        const reference = {
          type: "workspaceReservationId",
          id: workspaceReservationId,
        } as const;
        const unavailable = (message: string) =>
          lifecycleStateError("admitPublicAttempt", reference, message);
        if (
          input.amount.currency !== "CZK" ||
          input.amount.value <= 0 ||
          input.amount.exponent !== 2 ||
          input.publicPayment.accountKey.length === 0
        ) {
          return yield* unavailable(
            "Public payments require a positive CZK amount and a receiving account."
          );
        }

        return yield* transaction(
          Effect.gen(function* () {
            const dotyposCustomerId = yield* findPaymentReservationCustomer(
              "admitPublicAttempt",
              workspaceReservationId
            );
            yield* ReferralInvitationLedger.lockFirstBooking({
              dotyposCustomerId,
              records: "nothing",
            });
            const [reservation] = yield* db
              .select()
              .from(workspaceReservations)
              .where(eq(workspaceReservations.id, workspaceReservationId))
              .limit(1)
              .for("update");
            const [window] = yield* db
              .select()
              .from(reservationPaymentWindows)
              .where(eq(reservationPaymentWindows.orderId, input.orderId))
              .limit(1);
            const now = Temporal.Now.instant();
            const expiresAt = window?.expiresAt ?? now.add({ minutes: 30 });
            if (
              reservation?.reservationState !== "held" ||
              reservation.paymentState === "paid" ||
              Temporal.Instant.compare(expiresAt, now) <= 0 ||
              (window && window.accountKey !== input.publicPayment.accountKey)
            ) {
              return yield* unavailable(
                "The public reservation payment window is closed."
              );
            }
            if (yield* findReservationEntryClaim(db, workspaceReservationId)) {
              return yield* unavailable(
                "Entry pack add-ons are payable by card."
              );
            }

            const existingId =
              input.provider === "fio"
                ? window?.qrAttemptId
                : window?.cardAttemptId;
            const [existing] = existingId
              ? yield* db
                  .select()
                  .from(paymentAttempts)
                  .where(eq(paymentAttempts.id, existingId))
                  .limit(1)
              : [];
            if (existing) {
              const attempt = toPaymentAttempt(existing);
              if (!moneyEquals(attempt.amount, input.amount)) {
                return yield* unavailable(
                  "The payment amount differs from the accepted price."
                );
              }
              if (input.wake) yield* input.wake(input.publicPayment.accountKey);
              return attempt;
            }

            const providerOrderId =
              input.providerOrderId ?? (yield* nextQrReference);
            if (!window) {
              if (
                !input.commitment ||
                !input.accountingSnapshot ||
                reservation.activePaymentAttemptId
              ) {
                return yield* unavailable(
                  "A public payment can only start from a fresh held reservation."
                );
              }
              const attempt = yield* admitFirstAttempt({
                orderId: input.orderId,
                publicPayment: input.publicPayment,
                amount: input.amount,
                locale: input.locale,
                commitment: input.commitment,
                accountingSnapshot: input.accountingSnapshot,
                provider: input.provider,
                providerOrderId,
                expiresAt,
              });
              yield* db.insert(reservationPaymentWindows).values({
                orderId: input.orderId,
                accountKey: input.publicPayment.accountKey,
                expiresAt,
                cardAttemptId: input.provider === "nexi" ? attempt.id : null,
                qrAttemptId: input.provider === "fio" ? attempt.id : null,
              });
              if (input.wake) yield* input.wake(input.publicPayment.accountKey);
              return attempt;
            }

            if (
              reservation.paymentState !== "pending" ||
              !reservation.activePaymentAttemptId
            ) {
              return yield* unavailable(
                "A public payment can only switch while the reservation is payable."
              );
            }
            const [original] = yield* db
              .select()
              .from(paymentAttempts)
              .where(eq(paymentAttempts.id, reservation.activePaymentAttemptId))
              .limit(1);
            if (
              !original ||
              !moneyEquals(toPaymentAttempt(original).amount, input.amount)
            ) {
              return yield* unavailable(
                "The payment amount differs from the accepted price."
              );
            }
            const snapshot = yield* accountingSnapshots.find(original.id);
            if (!snapshot)
              return yield* unavailable(
                "The accepted accounting snapshot is unavailable."
              );
            const prepared = yield* accountingSnapshots.prepare({
              snapshot,
              orderId: input.orderId,
              amount: input.amount,
              locale: snapshot.locale,
              reference: { type: "providerOrderId", id: providerOrderId },
            });
            const attempt = yield* insertPaymentAttempt({
              workspaceReservationId,
              orderId: input.orderId,
              amount: input.amount,
              provider: input.provider,
              providerOrderId,
            });
            yield* prepared.record({
              paymentAttemptId: attempt.id,
              dotyposCustomerId,
              dotyposReservationId: reservation.dotyposReservationId,
            });
            yield* db
              .update(reservationPaymentWindows)
              .set(
                input.provider === "fio"
                  ? { qrAttemptId: attempt.id }
                  : { cardAttemptId: attempt.id }
              )
              .where(eq(reservationPaymentWindows.orderId, input.orderId));
            if (input.wake) yield* input.wake(input.publicPayment.accountKey);
            return toPaymentAttempt(attempt);
          })
        );
      });

      const createPendingProviderAttempt = (input: CardPaymentAdmission) => {
        if (
          input.publicPayment &&
          input.provider === "nexi" &&
          !input.retriedAttempt
        ) {
          const { publicPayment, orderId, amount, locale, providerOrderId } =
            input;
          const payment = {
            orderId,
            amount,
            locale,
            providerOrderId,
            provider: "nexi" as const,
          };
          if (publicPayment.useAcceptedCommitment) {
            return admitPublicAttempt({ ...payment, publicPayment });
          }
          if (input.commitment && input.accountingSnapshot) {
            return admitPublicAttempt({
              ...payment,
              publicPayment,
              commitment: input.commitment,
              accountingSnapshot: input.accountingSnapshot,
            });
          }
        }
        if (input.commitment && input.accountingSnapshot) {
          const { publicPayment: _publicPayment, ...legacy } = input;
          return admitFirstAttempt({
            ...legacy,
            commitment: input.commitment,
            accountingSnapshot: input.accountingSnapshot,
          });
        }
        return lifecycleStateError(
          "createPendingProviderAttempt",
          { type: "providerOrderId", id: input.providerOrderId },
          "A standalone provider payment requires an accepted commitment."
        );
      };

      const createPendingQrAttempt = Effect.fn(
        "PaymentLifecycleRepository.createPendingQrAttempt"
      )(function* (input: QrPaymentAdmission) {
        const { wake } = yield* FioPollWake;
        return yield* admitPublicAttempt({ ...input, provider: "fio", wake });
      });

      const completeInternalPayment = Effect.fn(
        "PaymentLifecycleRepository.completeInternalPayment"
      )(function* (input: {
        readonly orderId: OrderId;
        readonly amount: Money;
        readonly commitment: DiscountCommitment;
        readonly locale: Locale;
        readonly accountingSnapshot: AccountingDocumentSnapshot;
      }) {
        const workspaceReservationId = reservationIdForOrder(input.orderId);
        const accountingSnapshot = yield* accountingSnapshots.prepare({
          snapshot: input.accountingSnapshot,
          orderId: input.orderId,
          amount: input.amount,
          locale: input.locale,
          reference: {
            type: "workspaceReservationId",
            id: workspaceReservationId,
          },
        });
        const commitment = getDiscountCommitmentPayload(input.commitment);
        const { quote } = accountingSnapshot.snapshot;
        const claimedApplications = yield* "entryPack" in quote &&
        quote.entryPack
          ? validateDiscountCommitment(commitment)
          : validateInternalPaymentCommitment(commitment, input.amount);
        const firstServiceDate = yield* validateCommitmentFirstServiceDate(
          commitment,
          accountingSnapshot.snapshot
        );

        if (input.amount.value !== 0) {
          return yield* lifecycleStateError(
            "completeInternalPayment",
            {
              type: "workspaceReservationId",
              id: workspaceReservationId,
            },
            "Internal payments require an exactly zero payable amount."
          );
        }

        return yield* transaction(
          Effect.gen(function* () {
            const dotyposCustomerId = yield* findPaymentReservationCustomer(
              "completeInternalPayment",
              workspaceReservationId
            );
            yield* ReferralInvitationLedger.lockFirstBooking({
              dotyposCustomerId,
              records: {
                admittedInvitation: claimedApplications.referral !== undefined,
              },
            });

            const [reservation] = yield* db
              .select({
                id: workspaceReservations.id,
                activePaymentAttemptId:
                  workspaceReservations.activePaymentAttemptId,
                dotyposCustomerId: workspaceReservations.dotyposCustomerId,
                dotyposReservationId:
                  workspaceReservations.dotyposReservationId,
                paidAt: workspaceReservations.paidAt,
                paymentState: workspaceReservations.paymentState,
                reservationHoldExpiresAt:
                  workspaceReservations.reservationHoldExpiresAt,
                reservationState: workspaceReservations.reservationState,
              })
              .from(workspaceReservations)
              .where(eq(workspaceReservations.id, workspaceReservationId))
              .limit(1)
              .for("update");

            const paidAt = Temporal.Now.instant();

            const completed = yield* findCompletedInternalPayment(
              input,
              reservation
            );
            if (completed) return completed;

            if (!isCurrentUnpaidHold(reservation, paidAt)) {
              return yield* lifecycleStateError(
                "completeInternalPayment",
                {
                  type: "workspaceReservationId",
                  id: workspaceReservationId,
                },
                "Internal payments can only complete a current held unpaid reservation."
              );
            }
            yield* ensureEntryPackPayment({
              reservationId: workspaceReservationId,
              snapshot: accountingSnapshot.snapshot,
              commitment,
              operation: "completeInternalPayment",
            });

            yield* admitFirstBookingPayment({
              dotyposCustomerId: reservation.dotyposCustomerId,
              workspaceReservationId,
              admitsInvitation: claimedApplications.referral !== undefined,
              operation: "completeInternalPayment",
            });

            const attemptRow = yield* insertPaymentAttempt({
              workspaceReservationId,
              orderId: input.orderId,
              amount: input.amount,
              provider: "internal",
              paidAt,
            });

            yield* accountingSnapshot.record({
              paymentAttemptId: attemptRow.id,
              dotyposCustomerId: reservation.dotyposCustomerId,
              dotyposReservationId: reservation.dotyposReservationId,
            });

            const [completedReservation] = yield* db
              .update(workspaceReservations)
              .set({
                activePaymentAttemptId: attemptRow.id,
                paymentState: "paid",
                paidAt,
                failureCode: null,
                updatedAt: paidAt,
              })
              .where(
                and(
                  eq(workspaceReservations.id, workspaceReservationId),
                  noLatePaymentRecovery,
                  eq(workspaceReservations.reservationState, "held"),
                  inArray(workspaceReservations.paymentState, [
                    "not_started",
                    "failed",
                    "cancelled",
                    "expired",
                  ])
                )
              )
              .returning({ id: workspaceReservations.id });

            if (!completedReservation) {
              return yield* lifecycleStateError(
                "completeInternalPayment",
                { type: "paymentAttemptId", id: attemptRow.id },
                "Internal payment could not atomically complete the held reservation."
              );
            }
            yield* consumeEntryPackClaim(workspaceReservationId).pipe(
              Effect.catchTag("EntryPackUnavailableError", () =>
                lifecycleStateError(
                  "completeInternalPayment",
                  {
                    type: "workspaceReservationId",
                    id: workspaceReservationId,
                  },
                  "The held Entry pack claim could not be consumed."
                )
              )
            );

            const applicationRows = yield* persistDiscountApplications({
              commitment,
              paymentAttemptId: attemptRow.id,
              workspaceReservationId,
            });
            const claimedAt = yield* reserveCommittedClaims({
              claimedApplications,
              applicationRows,
              paymentAttemptId: attemptRow.id,
              locale: input.locale,
              reservationCustomerId: reservation.dotyposCustomerId,
              reservationExpiresAt: reservation.reservationHoldExpiresAt,
              firstServiceDate,
            });
            yield* redeemInternalPaymentClaims({
              paymentAttemptId: attemptRow.id,
              workspaceReservationId,
              claimedAt,
            });

            return {
              attempt: toPaymentAttempt(attemptRow),
              changed: true,
              timestamp: paidAt,
            };
          })
        );
      });

      const markPaid = Effect.fn("PaymentLifecycleRepository.markPaid")(
        function* (input: {
          readonly id: PaymentAttemptId;
          readonly orderId: OrderId;
          readonly webhookEventId?: string;
          readonly providerOperationId?: string;
          readonly providerStatus?: string;
          readonly paidAt: Temporal.Instant;
        }) {
          const workspaceReservationId = reservationIdForOrder(input.orderId);
          return yield* transaction(
            Effect.gen(function* () {
              const [storedWindow] = yield* db
                .select()
                .from(reservationPaymentWindows)
                .where(eq(reservationPaymentWindows.orderId, input.orderId))
                .limit(1);
              const window =
                storedWindow && windowIncludesAttempt(storedWindow, input.id)
                  ? storedWindow
                  : undefined;
              const [orderBeforeLock] = window
                ? yield* db
                    .select({
                      activeAttemptId:
                        workspaceReservations.activePaymentAttemptId,
                    })
                    .from(workspaceReservations)
                    .where(eq(workspaceReservations.id, workspaceReservationId))
                    .limit(1)
                : [];
              const dotyposCustomerId = yield* findPaymentReservationCustomer(
                "markPaid",
                workspaceReservationId
              );
              yield* ReferralInvitationLedger.lockFirstBooking({
                dotyposCustomerId,
                records: {
                  claimOf: orderBeforeLock?.activeAttemptId ?? input.id,
                },
              });
              let sharedCard: SharedCardSettlement | undefined;
              if (window) {
                const isSharedCard = window.cardAttemptId === input.id;
                const [reservation] = yield* db
                  .select()
                  .from(workspaceReservations)
                  .where(eq(workspaceReservations.id, workspaceReservationId))
                  .limit(1)
                  .for("update");
                const [card] = isSharedCard
                  ? yield* db
                      .select()
                      .from(paymentAttempts)
                      .where(
                        and(
                          eq(paymentAttempts.orderId, input.orderId),
                          eq(paymentAttempts.id, input.id)
                        )
                      )
                      .limit(1)
                      .for("update")
                  : [];
                const cardAlreadyWon =
                  reservation?.paymentState === "paid" &&
                  reservation.activePaymentAttemptId === input.id;
                // A recorded recovery owns this card's outcome. Reject conflicting
                // evidence before either settlement path can replace it.
                const [cardRecovery] =
                  card && !cardAlreadyWon
                    ? yield* db
                        .select({
                          providerOperationId:
                            latePaymentRecoveries.providerOperationId,
                        })
                        .from(latePaymentRecoveries)
                        .where(
                          eq(latePaymentRecoveries.paymentAttemptId, card.id)
                        )
                        .limit(1)
                    : [];
                if (
                  cardRecovery?.providerOperationId &&
                  input.providerOperationId &&
                  cardRecovery.providerOperationId !== input.providerOperationId
                ) {
                  return yield* lifecycleStateError(
                    "markPaid",
                    { type: "paymentAttemptId", id: input.id },
                    "Verified card operation conflicts with the recorded recovery."
                  );
                }
                const refundInput = cardRecovery?.providerOperationId
                  ? {
                      ...input,
                      providerOperationId: cardRecovery.providerOperationId,
                    }
                  : input;
                if (
                  card &&
                  !cardAlreadyWon &&
                  card.refundState !== "not_required"
                ) {
                  return yield* requireCardSettlementRefund(refundInput, card);
                }
                if (
                  reservation?.paymentState === "paid" &&
                  window.qrAttemptId === input.id &&
                  reservation.activePaymentAttemptId === input.id
                ) {
                  const [settled] = yield* db
                    .select()
                    .from(paymentAttempts)
                    .where(eq(paymentAttempts.id, input.id))
                    .limit(1);
                  if (settled)
                    return {
                      attempt: toPaymentAttempt(settled),
                      changed: false,
                      timestamp: reservation.paidAt ?? input.paidAt,
                    };
                }

                if (
                  reservation?.paymentState === "paid" &&
                  reservation.activePaymentAttemptId !== input.id
                ) {
                  return yield* requireCardSettlementRefund(refundInput, card);
                }

                if (reservation?.paymentState !== "paid") {
                  if (
                    reservation?.reservationState !== "held" ||
                    reservation.paymentState !== "pending" ||
                    !reservation.activePaymentAttemptId ||
                    !windowIncludesAttempt(
                      window,
                      reservation.activePaymentAttemptId
                    ) ||
                    Temporal.Instant.compare(window.expiresAt, input.paidAt) <=
                      0 ||
                    cardRecovery
                  ) {
                    if (isSharedCard) {
                      const attempt = yield* admitLatePublicSettlement(
                        input,
                        reservation,
                        window
                      );
                      if (attempt)
                        return {
                          attempt,
                          changed: false,
                          timestamp: input.paidAt,
                          settlement: "recovery_pending" as const,
                        };
                      return yield* requireCardSettlementRefund(
                        refundInput,
                        card
                      );
                    }
                    return yield* lifecycleStateError(
                      "markPaid",
                      { type: "paymentAttemptId", id: input.id },
                      "The public reservation payment window has closed."
                    );
                  }
                  if (reservation.activePaymentAttemptId !== input.id) {
                    yield* bindAcceptedClaimsToWinner(
                      reservation.activePaymentAttemptId,
                      input.id
                    );
                    yield* db
                      .update(workspaceReservations)
                      .set({ activePaymentAttemptId: input.id })
                      .where(
                        eq(workspaceReservations.id, workspaceReservationId)
                      );
                  }
                }
                if (card)
                  sharedCard = {
                    attempt: card,
                    windowEligible: !cardAlreadyWon,
                  };
              }

              yield* ReferralInvitationLedger.ensureFirstPaid({
                dotyposCustomerId,
                workspaceReservationId,
                paymentAttemptId: input.id,
              });

              const attempt = yield* markPaymentAttemptPaid(input, sharedCard);

              if (!attempt) {
                return yield* lifecycleStateError(
                  "markPaid",
                  { type: "paymentAttemptId", id: input.id },
                  "The payment attempt cannot settle this reservation."
                );
              }

              const [reservation] = yield* db
                .update(workspaceReservations)
                .set({
                  paymentState: "paid",
                  paidAt: input.paidAt,
                  failureCode: null,
                  updatedAt: input.paidAt,
                })
                .where(
                  and(
                    eq(workspaceReservations.id, workspaceReservationId),
                    eq(workspaceReservations.reservationState, "held"),
                    eq(workspaceReservations.paymentState, "pending"),
                    eq(workspaceReservations.activePaymentAttemptId, input.id)
                  )
                )
                .returning({ paidAt: workspaceReservations.paidAt });

              if (reservation) {
                yield* consumeEntryPackClaim(workspaceReservationId).pipe(
                  Effect.catchTag("EntryPackUnavailableError", () =>
                    lifecycleStateError(
                      "markPaid",
                      {
                        type: "workspaceReservationId",
                        id: workspaceReservationId,
                      },
                      "The held Entry pack claim could not be consumed."
                    )
                  )
                );
                yield* PromotionClaims.redeem({
                  paymentAttemptId: input.id,
                  redeemedAt: input.paidAt,
                });
                yield* ReferralInvitationLedger.redeem({
                  paymentAttemptId: input.id,
                  workspaceReservationId,
                  redeemedAt: input.paidAt,
                });
                return {
                  attempt: toPaymentAttempt(attempt),
                  changed: true,
                  timestamp: reservation.paidAt ?? input.paidAt,
                };
              }

              const [consistent] = yield* db
                .select({ paidAt: workspaceReservations.paidAt })
                .from(workspaceReservations)
                .where(
                  and(
                    eq(workspaceReservations.id, workspaceReservationId),
                    eq(workspaceReservations.paymentState, "paid"),
                    eq(workspaceReservations.activePaymentAttemptId, input.id)
                  )
                )
                .limit(1);

              if (!consistent) {
                return yield* lifecycleStateError(
                  "markPaid",
                  { type: "paymentAttemptId", id: input.id },
                  "Only the active pending attempt on a held reservation can mark payment paid."
                );
              }

              yield* PromotionClaims.redeem({
                paymentAttemptId: input.id,
                redeemedAt: input.paidAt,
              });
              yield* ReferralInvitationLedger.redeem({
                paymentAttemptId: input.id,
                workspaceReservationId,
                redeemedAt: input.paidAt,
              });
              return {
                attempt: toPaymentAttempt(attempt),
                changed: false,
                timestamp: consistent.paidAt ?? input.paidAt,
              };
            })
          );
        }
      );

      const recordVerifiedQrPayment = Effect.fn(
        "PaymentLifecycleRepository.recordVerifiedQrPayment"
      )(function* (
        input: Parameters<
          IPaymentLifecycleRepository["recordVerifiedQrPayment"]
        >[0]
      ) {
        return yield* transaction(
          Effect.gen(function* () {
            const [window] = yield* db
              .select()
              .from(reservationPaymentWindows)
              .where(eq(reservationPaymentWindows.orderId, input.orderId))
              .limit(1);
            if (window?.qrAttemptId !== input.id)
              return { status: "refund" } as const;

            const transition = yield* markPaid(input).pipe(
              Effect.catchTag("PaymentLifecycleStateError", () =>
                Effect.succeed(null)
              )
            );
            if (
              transition?.attempt.provider === "fio" &&
              transition.attempt.lastProviderOperationId ===
                input.providerOperationId
            ) {
              return { status: "winner", transition } as const;
            }
            if (transition) return { status: "refund" } as const;

            const workspaceReservationId = reservationIdForOrder(input.orderId);
            const dotyposCustomerId = yield* findPaymentReservationCustomer(
              "markPaid",
              workspaceReservationId
            );
            yield* ReferralInvitationLedger.lockFirstBooking({
              dotyposCustomerId,
              records: "nothing",
            });
            const [reservation] = yield* db
              .select()
              .from(workspaceReservations)
              .where(eq(workspaceReservations.id, workspaceReservationId))
              .for("update");
            const attempt = yield* admitLatePublicSettlement(
              input,
              reservation,
              window
            );
            return { status: attempt ? "recover" : "refund" } as const;
          })
        );
      });

      const expirePublicPaymentWindow = Effect.fn(
        "PaymentLifecycleRepository.expirePublicPaymentWindow"
      )(function* ({
        orderId,
        checkedAt,
      }: Parameters<
        IPaymentLifecycleRepository["expirePublicPaymentWindow"]
      >[0]) {
        const workspaceReservationId = reservationIdForOrder(orderId);
        return yield* transaction(
          Effect.gen(function* () {
            const [window] = yield* db
              .select()
              .from(reservationPaymentWindows)
              .where(eq(reservationPaymentWindows.orderId, orderId))
              .limit(1);
            if (
              !window ||
              Temporal.Instant.compare(window.expiresAt, checkedAt) > 0
            )
              return false;
            const dotyposCustomerId = yield* findPaymentReservationCustomer(
              "markTerminal",
              workspaceReservationId
            );
            yield* ReferralInvitationLedger.lockFirstBooking({
              dotyposCustomerId,
              records: "nothing",
            });
            const [reservation] = yield* db
              .select()
              .from(workspaceReservations)
              .where(eq(workspaceReservations.id, workspaceReservationId))
              .limit(1)
              .for("update");
            if (!reservation || reservation.paymentState === "paid")
              return false;

            const [recovery] = reservation.activePaymentAttemptId
              ? yield* db
                  .select({ state: latePaymentRecoveries.state })
                  .from(latePaymentRecoveries)
                  .where(
                    eq(
                      latePaymentRecoveries.paymentAttemptId,
                      reservation.activePaymentAttemptId
                    )
                  )
                  .limit(1)
              : [];
            if (recovery) return false;
            if (reservation.paymentState !== "pending") return true;

            const exposed = [window.cardAttemptId, window.qrAttemptId].filter(
              (id) => id !== null
            );
            yield* db
              .update(paymentAttempts)
              .set({
                state: "expired",
                failureCode: publicPaymentWindowExpiredFailureCode,
                updatedAt: checkedAt,
              })
              .where(
                and(
                  inArray(paymentAttempts.id, exposed),
                  inArray(paymentAttempts.state, ["created", "pending"])
                )
              );
            yield* db
              .update(workspaceReservations)
              .set({
                paymentState: "expired",
                failureCode: publicPaymentWindowExpiredFailureCode,
                updatedAt: checkedAt,
              })
              .where(eq(workspaceReservations.id, workspaceReservationId));
            if (reservation.activePaymentAttemptId) {
              yield* releaseWindowClaims(
                reservation.activePaymentAttemptId,
                checkedAt
              );
            }
            return true;
          })
        );
      });

      const markTerminal = Effect.fn("PaymentLifecycleRepository.markTerminal")(
        function* (
          input: Parameters<IPaymentLifecycleRepository["markTerminal"]>[0]
        ) {
          if (
            input.failureCode ===
            administrationForcedPaymentCancellationFailureCode
          ) {
            return yield* terminalTransitions.markTerminal(input);
          }
          return yield* transaction(
            Effect.gen(function* () {
              const [window] = yield* db
                .select()
                .from(reservationPaymentWindows)
                .where(eq(reservationPaymentWindows.orderId, input.orderId))
                .limit(1);
              if (window?.cardAttemptId !== input.id) {
                return yield* terminalTransitions.markTerminal(input);
              }

              // A hosted-session outcome ends that method only. The reservation
              // and its accepted claims remain available for QR through the cutoff.
              const workspaceReservationId = reservationIdForOrder(
                input.orderId
              );
              const dotyposCustomerId = yield* findPaymentReservationCustomer(
                "markTerminal",
                workspaceReservationId
              );
              yield* ReferralInvitationLedger.lockFirstBooking({
                dotyposCustomerId,
                records: "nothing",
              });
              const [previous] = yield* db
                .select({
                  state: paymentAttempts.state,
                  updatedAt: paymentAttempts.updatedAt,
                })
                .from(paymentAttempts)
                .where(eq(paymentAttempts.id, input.id))
                .limit(1)
                .for("update");
              const terminalAt = Temporal.Now.instant();
              const attempt = yield* markPaymentAttemptTerminal({
                ...input,
                fromAttemptStates: input.fromAttemptStates ?? [
                  "created",
                  "pending",
                ],
                terminalAt,
              });
              if (!attempt) {
                return yield* lifecycleStateError(
                  "markTerminal",
                  { type: "paymentAttemptId", id: input.id },
                  "The shared payment window could not end this card attempt."
                );
              }
              return {
                attempt: toPaymentAttempt(attempt),
                changed: previous?.state !== input.state,
                timestamp:
                  previous?.state === input.state
                    ? previous.updatedAt
                    : terminalAt,
              };
            })
          );
        }
      );

      return {
        createPendingProviderAttempt,
        createPendingQrAttempt,
        recordVerifiedQrPayment,
        expirePublicPaymentWindow,
        completeInternalPayment,
        attachProviderSession: (input) =>
          attachPaymentProviderSession(input).pipe(
            Effect.provideService(WorkspaceDatabase, { db, transaction })
          ),
        markPaid,
        markTerminal,
      } satisfies IPaymentLifecycleRepository;
    })
  ).pipe(Layer.provide(PaymentTerminalTransitions.Default));

  /** `Default` over the accounting storage and the Workspace database. */
  static Live = this.Default.pipe(
    Layer.provide(
      Layer.merge(AccountingStorage.Live, WorkspaceDatabase.Default)
    )
  );
}

/**
 * The internal payment that already completed the reservation for this
 * amount, which a repeated completion returns unchanged.
 */
const findCompletedInternalPayment = Effect.fnUntraced(function* (
  input: {
    readonly orderId: OrderId;
    readonly amount: Money;
  },
  reservation:
    | Pick<
        WorkspaceReservationRow,
        "paymentState" | "activePaymentAttemptId" | "paidAt"
      >
    | undefined
) {
  const { db } = yield* WorkspaceTransaction;
  if (
    !(
      reservation?.paymentState === "paid" && reservation.activePaymentAttemptId
    )
  ) {
    return undefined;
  }
  const [existingAttempt] = yield* db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, reservation.activePaymentAttemptId),
        eq(paymentAttempts.orderId, input.orderId),
        eq(paymentAttempts.provider, "internal"),
        eq(paymentAttempts.state, "paid")
      )
    )
    .limit(1);

  if (
    !existingAttempt ||
    !moneyEquals(toPaymentAttempt(existingAttempt).amount, input.amount)
  ) {
    return undefined;
  }
  return {
    attempt: toPaymentAttempt(existingAttempt),
    changed: false,
    timestamp: reservation.paidAt ?? existingAttempt.updatedAt,
  } satisfies PaymentLifecycleTransition;
});

/** Whether an internal payment may complete the reservation at `at`. */
const isCurrentUnpaidHold = <
  Reservation extends Pick<
    WorkspaceReservationRow,
    "reservationState" | "reservationHoldExpiresAt" | "paymentState"
  >,
>(
  reservation: Reservation | undefined,
  at: Temporal.Instant
): reservation is Reservation & {
  readonly reservationHoldExpiresAt: Temporal.Instant;
} =>
  reservation?.reservationState === "held" &&
  reservation.reservationHoldExpiresAt !== null &&
  Temporal.Instant.compare(reservation.reservationHoldExpiresAt, at) > 0 &&
  ["not_started", "failed", "cancelled", "expired"].includes(
    reservation.paymentState
  );

/** Redeems the claims an internal payment reserved in its transaction. */
const redeemInternalPaymentClaims = Effect.fnUntraced(function* (input: {
  readonly paymentAttemptId: PaymentAttemptId;
  readonly workspaceReservationId: WorkspaceReservationId;
  readonly claimedAt: {
    readonly code: Temporal.Instant | undefined;
    readonly referral: Temporal.Instant | undefined;
  };
}) {
  if (input.claimedAt.code) {
    yield* PromotionClaims.redeem({
      paymentAttemptId: input.paymentAttemptId,
      redeemedAt: input.claimedAt.code,
    });
  }
  if (input.claimedAt.referral) {
    yield* ReferralInvitationLedger.redeem({
      paymentAttemptId: input.paymentAttemptId,
      workspaceReservationId: input.workspaceReservationId,
      redeemedAt: input.claimedAt.referral,
    });
  }
});

type CommitmentPayload = ReturnType<typeof getDiscountCommitmentPayload>;

export const validateDiscountCommitment = Effect.fn(
  "PaymentLifecycle.validateDiscountCommitment"
)(function* (commitment: CommitmentPayload) {
  let codeClaimedApplication: OrdinaryClaimedApplication | undefined;
  let referralClaimedApplication: ReferralClaimedApplication | undefined;

  for (const [
    index,
    { application, claim },
  ] of commitment.applications.entries()) {
    yield* requireConsistentApplicationMoney(application, claim);

    if (claim?.kind === "referral_invitation") {
      yield* requireNoEarlierClaim(
        referralClaimedApplication,
        "A payment attempt can reserve one referral invitation claim.",
        claim
      );
      referralClaimedApplication = { index, application, claim };
    } else if (claim) {
      yield* requireNoEarlierClaim(
        codeClaimedApplication,
        "A payment attempt can reserve one ordinary promotion claim.",
        claim
      );
      codeClaimedApplication = { index, application, claim };
    }

    yield* requireClaimedProduct(claim, commitment.product);
  }

  return {
    code: codeClaimedApplication,
    referral: referralClaimedApplication,
  };
});

/** An application takes its amount from its subtotal, in the subtotal's unit. */
const requireConsistentApplicationMoney = (
  application: AppliedDiscount,
  claim: DiscountClaimInstruction | undefined
): Effect.Effect<void, DiscountClaimError> => {
  const amountInSubtotalUnit = moneyWithValue(
    application.amount.value,
    application.subtotalBefore
  );
  const expectedSubtotalAfter = moneyWithValue(
    application.subtotalBefore.value - application.amount.value,
    application.subtotalBefore
  );
  return moneyEquals(amountInSubtotalUnit, application.amount) &&
    moneyEquals(expectedSubtotalAfter, application.subtotalAfter)
    ? Effect.void
    : Effect.fail(
        DiscountClaimError.forClaim(
          "reserve",
          "money_mismatch",
          "A committed discount application has inconsistent money.",
          claim
        )
      );
};

/** A commitment carries at most one claim of each ledger. */
const requireNoEarlierClaim = (
  earlier: ClaimedApplication<DiscountClaimInstruction> | undefined,
  message: string,
  claim: DiscountClaimInstruction
): Effect.Effect<void, DiscountClaimError> =>
  earlier
    ? Effect.fail(
        DiscountClaimError.forClaim("reserve", "claim_conflict", message, claim)
      )
    : Effect.void;

const requireClaimedProduct = (
  claim: DiscountClaimInstruction | undefined,
  product: CommitmentPayload["product"]
): Effect.Effect<void, DiscountClaimError> =>
  claim?.kind === "discount_code" &&
  getWorkspaceProductKey(claim.product) !== getWorkspaceProductKey(product)
    ? Effect.fail(
        DiscountClaimError.forClaim(
          "reserve",
          "product_ineligible",
          "The discount-code claim targets a different product.",
          claim
        )
      )
    : Effect.void;

/**
 * The commitment was affirmed for the reservation this attempt pays for, so
 * the code claim checks service dates against its start date.
 */
const validateCommitmentFirstServiceDate = Effect.fn(
  "PaymentLifecycle.validateCommitmentFirstServiceDate"
)(function* (
  commitment: CommitmentPayload,
  snapshot: AccountingDocumentSnapshot
) {
  const firstServiceDate =
    getAccountingDocumentSnapshotFirstServiceDate(snapshot);
  if (commitment.firstServiceDate !== firstServiceDate) {
    return yield* new DiscountClaimError({
      operation: "reserve",
      reason: "claim_conflict",
      message:
        "The discount commitment was affirmed for a different reservation start date.",
    });
  }
  return firstServiceDate;
});

export const validateInternalPaymentCommitment = Effect.fn(
  "PaymentLifecycle.validateInternalPaymentCommitment"
)(function* (commitment: CommitmentPayload, amount: Money) {
  const claimedApplication = yield* validateDiscountCommitment(commitment);
  const finalSubtotal =
    commitment.applications.at(-1)?.application.subtotalAfter;

  if (!finalSubtotal || !moneyEquals(finalSubtotal, amount)) {
    return yield* new DiscountClaimError({
      operation: "reserve",
      reason: "money_mismatch",
      message:
        "An internal payment commitment must reduce the discountable subtotal to its payable amount.",
    });
  }

  return claimedApplication;
});

/**
 * Admits the payment under the referral first-booking rules, reporting an
 * invited customer's already admitted first payment as a state error.
 */
const admitFirstBookingPayment = (input: {
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly workspaceReservationId: WorkspaceReservationId;
  readonly admitsInvitation: boolean;
  readonly operation:
    | "createPendingProviderAttempt"
    | "completeInternalPayment";
}) =>
  ReferralInvitationLedger.admitFirstBooking(input).pipe(
    Effect.catchTag("ReferralFirstBookingAdmittedError", ({ message }) =>
      Effect.fail(
        lifecycleStateError(
          input.operation,
          { type: "workspaceReservationId", id: input.workspaceReservationId },
          message
        )
      )
    )
  );

type ClaimedApplication<Claim extends DiscountClaimInstruction> = {
  readonly index: number;
  readonly application: AppliedDiscount;
  readonly claim: Claim;
};

type ReferralInvitationClaim = Extract<
  DiscountClaimInstruction,
  { readonly kind: "referral_invitation" }
>;
type OrdinaryClaimedApplication = ClaimedApplication<PromotionClaim>;
type ReferralClaimedApplication = ClaimedApplication<ReferralInvitationClaim>;

type ClaimedApplications = {
  readonly code: OrdinaryClaimedApplication | undefined;
  readonly referral: ReferralClaimedApplication | undefined;
};

type PersistedApplication = {
  readonly id: DiscountApplicationId;
  readonly sequence: number;
};

export const persistDiscountApplications = Effect.fn(
  "PaymentLifecycle.persistDiscountApplications"
)(function* (input: {
  readonly commitment: CommitmentPayload;
  readonly paymentAttemptId: PaymentAttemptId;
  readonly workspaceReservationId: WorkspaceReservationId | null;
}) {
  const { db } = yield* WorkspaceTransaction;
  if (input.commitment.applications.length === 0) {
    return [] satisfies PersistedApplication[];
  }

  return yield* db
    .insert(discountApplications)
    .values(
      input.commitment.applications.map(
        ({ application, provenance }, sequence) => ({
          paymentAttemptId: input.paymentAttemptId,
          workspaceReservationId: input.workspaceReservationId,
          sequence,
          publicDiscountId: application.discount.id,
          label: application.discount.label,
          staffLabel: application.discount.staffLabel ?? null,
          adjustment: application.discount.adjustment,
          productIdentity: input.commitment.product,
          subtotalBeforeValue: application.subtotalBefore.value,
          subtotalBeforeExponent: application.subtotalBefore.exponent,
          subtotalBeforeCurrency: application.subtotalBefore.currency,
          appliedAmountValue: application.amount.value,
          appliedAmountExponent: application.amount.exponent,
          appliedAmountCurrency: application.amount.currency,
          subtotalAfterValue: application.subtotalAfter.value,
          subtotalAfterExponent: application.subtotalAfter.exponent,
          subtotalAfterCurrency: application.subtotalAfter.currency,
          expiresAt: application.discount.expiresAt
            ? Temporal.Instant.from(application.discount.expiresAt)
            : null,
          countdownStartsAt: application.discount.countdownStartsAt
            ? Temporal.Instant.from(application.discount.countdownStartsAt)
            : null,
          provenance,
        })
      )
    )
    .returning({
      id: discountApplications.id,
      sequence: discountApplications.sequence,
    });
});

export const reserveCommittedClaims = Effect.fn(
  "PaymentLifecycle.reserveCommittedClaims"
)(function* (input: {
  readonly claimedApplications: ClaimedApplications;
  readonly applicationRows: readonly PersistedApplication[];
  readonly paymentAttemptId: PaymentAttemptId;
  readonly locale: Locale;
  readonly reservationCustomerId: DotyposCustomerId;
  readonly reservationExpiresAt: Temporal.Instant;
  readonly firstServiceDate: string;
}) {
  const findApplicationId = (
    claimed: ClaimedApplication<DiscountClaimInstruction>
  ) =>
    input.applicationRows.find(({ sequence }) => sequence === claimed.index)
      ?.id;

  let code: Temporal.Instant | undefined;
  if (input.claimedApplications.code) {
    const claimed = input.claimedApplications.code;
    const applicationId = findApplicationId(claimed);
    if (!applicationId) {
      return yield* DiscountClaimError.forClaim(
        "reserve",
        "claim_conflict",
        "The claimed discount application was not persisted.",
        claimed.claim
      );
    }
    code = yield* PromotionClaims.admit({
      claim: claimed.claim,
      application: claimed.application,
      applicationId,
      paymentAttemptId: input.paymentAttemptId,
      locale: input.locale,
      reservationCustomerId: input.reservationCustomerId,
      reservationExpiresAt: input.reservationExpiresAt,
      firstServiceDate: input.firstServiceDate,
    }).pipe(
      Effect.catchTag("PromotionClaimHoldEndedError", ({ message }) =>
        Effect.fail(
          lifecycleStateError(
            "reserveCodeClaim",
            { type: "paymentAttemptId", id: input.paymentAttemptId },
            message
          )
        )
      )
    );
  }

  let referral: Temporal.Instant | undefined;
  if (input.claimedApplications.referral) {
    const claimed = input.claimedApplications.referral;
    const applicationId = findApplicationId(claimed);
    if (!applicationId) {
      return yield* DiscountClaimError.forClaim(
        "reserve",
        "claim_conflict",
        "The referral application was not persisted.",
        claimed.claim
      );
    }
    referral = yield* ReferralInvitationLedger.admit({
      claim: claimed.claim,
      application: claimed.application,
      applicationId,
      paymentAttemptId: input.paymentAttemptId,
      reservationCustomerId: input.reservationCustomerId,
      reservationExpiresAt: input.reservationExpiresAt,
      locale: input.locale,
    }).pipe(
      Effect.catchTag("ReferralClaimHoldEndedError", ({ message }) =>
        Effect.fail(
          lifecycleStateError(
            "reserveReferralInvitationClaim",
            { type: "paymentAttemptId", id: input.paymentAttemptId },
            message
          )
        )
      )
    );
  }

  return { code, referral };
});
