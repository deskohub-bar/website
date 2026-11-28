import { and, asc, eq, lte, ne } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import {
  contractWithdrawals,
  passEntryClaims,
  passPurchases,
  paymentAttempts,
  reservationAccessGrants,
  workspaceReservations,
} from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { getConsumerWithdrawalPeriodCutoff } from "@/features/legal/early-performance";
import type { OrderId } from "@/features/order";
import { ReservationCancellation } from "@/features/reservation/backend/reservation-cancellation.service";
import { WorkspaceReservationService } from "@/features/reservation/backend/workspace-reservation.service";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import {
  ContractCancellationError,
  type WithdrawableContract,
  type WithdrawableContractFamily,
  WithdrawableContractUnavailableError,
  type WithdrawalBookingInterval,
} from "@/features/withdrawal/withdrawable-contract";
import type {
  WithdrawalAssessment,
  WithdrawalRefundBasis,
} from "@/features/withdrawal/withdrawal-assessment";
import { currencyCZK } from "@/shared/money/currencies";
import { type Money, sameMoneyUnit } from "@/shared/money/money";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { getEntryPackWithdrawalRefund } from "../pass";
import type { EntryPackSize, PassTier } from "../pass-offer";
import { isEntryPackClaimCancelledByWithdrawal } from "./entry-pack-redemption";
import { getPassWithdrawalLabel } from "./pass-withdrawal-label";
import {
  decodePassWithdrawalOrderId,
  markPassWithdrawalRefund,
  paidPassAmount,
  readPaidPassForWithdrawal,
  readPassEarlyPerformanceConsent,
} from "./pass-withdrawal-payment";

const kind = "entry-pack" as const;
const workspaceDay = (instant: Temporal.Instant) =>
  plainDateStringSchema.make(getWorkspaceDate(instant).toString());

const readConsumedEntries = (
  db: WorkspaceDatabaseClient,
  passId: OrderId,
  through?: PlainDate
) =>
  db
    .select({
      reservationId: passEntryClaims.reservationId,
      dotyposReservationId: workspaceReservations.dotyposReservationId,
      date: passEntryClaims.date,
      cancelledAt: workspaceReservations.reservationCancelledAt,
      startsAt: reservationAccessGrants.scheduledAccessStartsAt,
      endsAt: reservationAccessGrants.accessEndsAt,
    })
    .from(passEntryClaims)
    .innerJoin(
      workspaceReservations,
      eq(workspaceReservations.id, passEntryClaims.reservationId)
    )
    .leftJoin(
      reservationAccessGrants,
      eq(
        reservationAccessGrants.workspaceReservationId,
        passEntryClaims.reservationId
      )
    )
    .where(
      and(
        eq(passEntryClaims.passId, passId),
        eq(passEntryClaims.status, "consumed"),
        through && lte(passEntryClaims.date, through)
      )
    );

type ConsumedEntry = Effect.Success<
  ReturnType<typeof readConsumedEntries>
>[number];
type BookingInterval = WithdrawalBookingInterval["interval"];

const bookingInterval = (
  entry: ConsumedEntry,
  tier: PassTier,
  observations: readonly WithdrawalBookingInterval[]
): BookingInterval | undefined => {
  if (entry.startsAt && entry.endsAt) {
    return { startsAt: entry.startsAt, endsAt: entry.endsAt };
  }
  if (tier === "open-space") {
    const { startsAt, endsAt } = getCoworkReservationInterval(tier, entry.date);
    return {
      startsAt: Temporal.Instant.from(startsAt),
      endsAt: Temporal.Instant.from(endsAt),
    };
  }
  return observations.find(
    (observed) =>
      observed.reservationId === entry.reservationId &&
      observed.dotyposReservationId === entry.dotyposReservationId
  )?.interval;
};

const assessEntryPackWithdrawal = ({
  pack,
  paid,
  now,
  consumedEntries,
  bookingIntervals,
  earlyPerformanceConsent,
}: {
  readonly pack: {
    readonly entryCount: EntryPackSize;
    readonly tier: PassTier;
    readonly buyerConfirmationDeliveredAt: Temporal.Instant | null;
  };
  readonly paid: Money;
  readonly now: Temporal.Instant;
  readonly consumedEntries: readonly ConsumedEntry[];
  readonly bookingIntervals: readonly WithdrawalBookingInterval[];
  readonly earlyPerformanceConsent: boolean;
}): WithdrawalAssessment => {
  const delivery = pack.buyerConfirmationDeliveredAt;
  if (!delivery || Temporal.Instant.compare(delivery, now) > 0) {
    return { withdrawable: false, reason: "not_withdrawable" };
  }
  const periodEndsAt = getConsumerWithdrawalPeriodCutoff(delivery);
  if (Temporal.Instant.compare(now, periodEndsAt) >= 0) {
    return { withdrawable: false, reason: "period_ended" };
  }
  const today = workspaceDay(now);
  const usedEntries: BookingInterval[] = [];
  if (earlyPerformanceConsent) {
    for (const entry of consumedEntries) {
      if (entry.date > today) continue;
      const interval = bookingInterval(entry, pack.tier, bookingIntervals);
      if (!interval) return { withdrawable: false, reason: "not_withdrawable" };
      // A pre-start cancellation can leave the original claim consumed.
      if (
        !entry.cancelledAt ||
        Temporal.Instant.compare(entry.cancelledAt, interval.startsAt) >= 0
      ) {
        usedEntries.push(interval);
      }
    }
  }
  if (!earlyPerformanceConsent || usedEntries.length === 0) {
    return {
      withdrawable: true,
      refundAmount: paid,
      refundBasis: { kind: "full" },
      periodEndsAt,
    };
  }

  const unusedEntries = pack.entryCount - usedEntries.length;
  if (
    unusedEntries < 0 ||
    (unusedEntries === 0 &&
      usedEntries.every(
        ({ endsAt }) => Temporal.Instant.compare(now, endsAt) >= 0
      ))
  ) {
    return { withdrawable: false, reason: "performance_started" };
  }
  return {
    withdrawable: true,
    refundAmount: getEntryPackWithdrawalRefund({
      paid,
      size: pack.entryCount,
      unusedEntries,
    }),
    refundBasis: {
      kind: "partial",
      unit: "entry",
      unstarted: unusedEntries,
      total: pack.entryCount,
    },
    periodEndsAt,
  };
};

const sameMoney = (left: Money, right: Money) =>
  sameMoneyUnit(left, right) && left.value === right.value;

const sameRefundBasis = (
  left: WithdrawalRefundBasis,
  right: WithdrawalRefundBasis
) =>
  left.kind === "full"
    ? right.kind === "full"
    : right.kind === "partial" &&
      left.unit === right.unit &&
      left.unstarted === right.unstarted &&
      left.total === right.total;

/** Spend and withdrawal both serialize on the pack row. */
export const recordEntryPackWithdrawal = Effect.fn("recordEntryPackWithdrawal")(
  function* (input: {
    readonly orderId: OrderId;
    readonly accountId: CustomerAccountId;
    readonly submittedAt: Temporal.Instant;
    readonly paidAmount: Money;
    readonly refundAmount: Money;
    readonly refundBasis: WithdrawalRefundBasis;
    readonly bookingIntervals?: readonly WithdrawalBookingInterval[];
  }) {
    const { db } = yield* WorkspaceTransaction;
    const [pack] = yield* readPaidPassForWithdrawal(
      db,
      input.orderId,
      input.accountId,
      kind
    ).for("no key update", { of: passPurchases });
    if (
      !pack?.entryCount ||
      (pack.status !== "active" && pack.status !== "depleted")
    ) {
      return;
    }

    const paid = paidPassAmount(pack);
    if (
      !sameMoneyUnit(paid, currencyCZK(0)) ||
      !sameMoney(paid, input.paidAmount)
    )
      return;
    const earlyPerformanceConsent = yield* readPassEarlyPerformanceConsent(
      db,
      input.orderId,
      kind
    );
    if (earlyPerformanceConsent === undefined) return;
    const consumedEntries = yield* readConsumedEntries(
      db,
      input.orderId,
      workspaceDay(input.submittedAt)
    );
    const assessment = assessEntryPackWithdrawal({
      pack: { ...pack, entryCount: pack.entryCount },
      paid,
      now: input.submittedAt,
      consumedEntries,
      bookingIntervals: input.bookingIntervals ?? [],
      earlyPerformanceConsent,
    });
    if (
      !assessment.withdrawable ||
      !sameMoney(assessment.refundAmount, input.refundAmount) ||
      !sameRefundBasis(assessment.refundBasis, input.refundBasis)
    ) {
      return;
    }
    yield* db
      .update(passPurchases)
      .set({ status: "withdrawn" })
      .where(eq(passPurchases.id, input.orderId));
    yield* markPassWithdrawalRefund(
      pack.attemptId,
      assessment.refundAmount,
      input.submittedAt
    );
    return assessment.periodEndsAt;
  }
);

export class EntryPackWithdrawals extends Context.Service<
  EntryPackWithdrawals,
  WithdrawableContractFamily
>()("@deskohub-workspace/passes/EntryPackWithdrawals") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db, transaction } = yield* WorkspaceDatabase;
      const snapshots = yield* AccountingDocumentSnapshots;
      const reservations = yield* ReservationCancellation;
      const reservationDetails = yield* WorkspaceReservationService;
      return {
        kind,
        find: Effect.fn("EntryPackWithdrawals.find")(
          function* ({ contractId, accountId, locale, assessedAt }) {
            const id = decodePassWithdrawalOrderId(contractId);
            if (Option.isNone(id)) return Option.none();
            const [pack] = yield* readPaidPassForWithdrawal(
              db,
              id.value,
              accountId,
              kind
            );
            if (!pack?.entryCount) return Option.none();
            const entryCount = pack.entryCount;
            const paid = paidPassAmount(pack);
            if (!sameMoneyUnit(paid, currencyCZK(0))) return Option.none();
            const snapshot = yield* snapshots.findPassPurchase(pack.attemptId);
            if (
              snapshot?.orderId !== id.value ||
              snapshot.product.kind !== kind
            ) {
              return Option.none();
            }
            const earlyPerformanceConsent =
              yield* readPassEarlyPerformanceConsent(db, id.value, kind);
            if (earlyPerformanceConsent === undefined) return Option.none();
            // Capture the claims once. The quote and submission assess the
            // date at their own instant, and recording rechecks under lock.
            const consumed = yield* readConsumedEntries(
              db,
              id.value,
              assessedAt ? workspaceDay(assessedAt) : undefined
            );
            const bookingIntervals: WithdrawalBookingInterval[] = [];
            if (
              pack.tier !== "open-space" &&
              earlyPerformanceConsent &&
              pack.buyerConfirmationDeliveredAt &&
              snapshot.billing.purpose !== "business" &&
              (pack.status === "active" || pack.status === "depleted")
            ) {
              for (const entry of consumed) {
                if (bookingInterval(entry, pack.tier, bookingIntervals))
                  continue;
                const details = yield* reservationDetails.getReservation(
                  entry.reservationId
                );
                bookingIntervals.push({
                  reservationId: entry.reservationId,
                  dotyposReservationId: details.dotyposReservationId,
                  interval: {
                    startsAt: details.reservedFrom,
                    endsAt: details.reservedUntil,
                  },
                });
              }
            }
            return Option.some<WithdrawableContract>({
              ref: { kind, id: id.value },
              label: getPassWithdrawalLabel(pack, locale),
              paidAmount: paid,
              bookingIntervals,
              assess: (now) => {
                if (pack.status !== "active" && pack.status !== "depleted") {
                  return { withdrawable: false, reason: "not_withdrawable" };
                }
                if (snapshot.billing.purpose === "business") {
                  return { withdrawable: false, reason: "business_purpose" };
                }
                return assessEntryPackWithdrawal({
                  pack: { ...pack, entryCount },
                  paid,
                  now,
                  consumedEntries: consumed,
                  bookingIntervals,
                  earlyPerformanceConsent,
                });
              },
            });
          },
          Effect.mapError(
            (cause) =>
              new WithdrawableContractUnavailableError({
                kind,
                message: "The Entry pack could not be read for a withdrawal.",
                cause,
              })
          )
        ),
        cancel: Effect.fn("EntryPackWithdrawals.cancel")(
          function* ({ contractId }) {
            const id = decodePassWithdrawalOrderId(contractId);
            if (Option.isNone(id)) {
              return yield* new ContractCancellationError({
                kind,
                code: "entry_pack_invalid_id",
                transient: false,
                message: "The withdrawn Entry pack id is invalid.",
              });
            }
            const [withdrawal] = yield* db
              .select({ submittedAt: contractWithdrawals.submittedAt })
              .from(contractWithdrawals)
              .innerJoin(
                passPurchases,
                eq(passPurchases.id, contractWithdrawals.contractId)
              )
              .where(
                and(
                  eq(contractWithdrawals.contractKind, kind),
                  eq(passPurchases.id, id.value),
                  eq(passPurchases.product, kind),
                  eq(passPurchases.status, "withdrawn")
                )
              );
            if (!withdrawal) {
              return yield* new ContractCancellationError({
                kind,
                code: "entry_pack_withdrawal_missing",
                transient: false,
                message: "The Entry pack withdrawal could not be found.",
              });
            }
            const entryPackWithdrawal = {
              passId: id.value,
              submittedOn: workspaceDay(withdrawal.submittedAt),
            };
            const claims = yield* db
              .select({ reservationId: passEntryClaims.reservationId })
              .from(passEntryClaims)
              .where(isEntryPackClaimCancelledByWithdrawal(entryPackWithdrawal))
              .orderBy(
                asc(passEntryClaims.date),
                asc(passEntryClaims.reservationId)
              );
            for (const { reservationId } of claims) {
              const cancelled = yield* reservations.cancel({
                reservationId,
                cause: "customer_withdrawal",
                entryPackWithdrawal,
                force: true,
              });
              yield* transaction(
                Effect.gen(function* () {
                  if (cancelled.outcome === "already_cancelled") {
                    const [paid] = yield* db
                      .select({
                        attemptId: paymentAttempts.id,
                        paidValue: paymentAttempts.amountValue,
                        exponent: paymentAttempts.amountExponent,
                        currency: paymentAttempts.currency,
                      })
                      .from(workspaceReservations)
                      .innerJoin(
                        paymentAttempts,
                        eq(
                          paymentAttempts.id,
                          workspaceReservations.activePaymentAttemptId
                        )
                      )
                      .where(
                        and(
                          eq(workspaceReservations.id, reservationId),
                          eq(
                            workspaceReservations.reservationState,
                            "cancelled"
                          ),
                          eq(paymentAttempts.state, "paid")
                        )
                      );
                    if (paid) {
                      yield* markPassWithdrawalRefund(
                        paid.attemptId,
                        paidPassAmount(paid),
                        withdrawal.submittedAt
                      );
                    }
                  }
                  yield* db
                    .update(passEntryClaims)
                    .set({ status: "released" })
                    .where(
                      and(
                        eq(passEntryClaims.reservationId, reservationId),
                        eq(passEntryClaims.passId, id.value),
                        ne(passEntryClaims.status, "released")
                      )
                    );
                })
              );
            }
          },
          Effect.mapError((cause) =>
            cause._tag === "ContractCancellationError"
              ? cause
              : new ContractCancellationError({
                  kind,
                  code: "entry_pack_bookings_release_failed",
                  transient: true,
                  message:
                    "The withdrawn Entry pack bookings could not be released.",
                  cause,
                })
          )
        ),
      };
    })
  );
}
