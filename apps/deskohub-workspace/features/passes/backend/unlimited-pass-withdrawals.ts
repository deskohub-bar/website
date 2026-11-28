import {
  and,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { passPurchases, workspaceReservations } from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { getConsumerWithdrawalPeriodCutoff } from "@/features/legal/early-performance";
import type { OrderId } from "@/features/order";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import {
  ContractCancellationError,
  type WithdrawableContract,
  type WithdrawableContractFamily,
  WithdrawableContractUnavailableError,
} from "@/features/withdrawal/withdrawable-contract";
import type { WithdrawalAssessment } from "@/features/withdrawal/withdrawal-assessment";
import { currencyCZK } from "@/shared/money/currencies";
import { type Money, sameMoneyUnit } from "@/shared/money/money";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { type PassTier, unlimitedPassDays } from "../pass-offer";
import {
  getUnlimitedPassEndDate,
  getUnlimitedPassWithdrawal,
} from "../unlimited-pass";
import { passDayMoveJournal } from "./pass-day-move-journal";
import { getPassWithdrawalLabel } from "./pass-withdrawal-label";
import {
  decodePassWithdrawalOrderId,
  markPassWithdrawalRefund,
  paidPassAmount,
  readPaidPassForWithdrawal,
  readPassEarlyPerformanceConsent,
} from "./pass-withdrawal-payment";

const kind = "unlimited-pass" as const;

type UnlimitedWithdrawalTerms = WithdrawalAssessment &
  ({ readonly withdrawable: false } | { readonly accessEndsOn: PlainDate });

const assessUnlimitedPassWithdrawal = (input: {
  readonly pass: {
    readonly validFrom: PlainDate;
    readonly validUntil: PlainDate;
    readonly tier: PassTier;
    readonly buyerConfirmationDeliveredAt: Temporal.Instant | null;
  };
  readonly paid: Money;
  readonly now: Temporal.Instant;
  readonly earlyPerformanceConsent: boolean;
}): UnlimitedWithdrawalTerms => {
  const { pass, paid, now, earlyPerformanceConsent } = input;
  const delivery = pass.buyerConfirmationDeliveredAt;
  if (!delivery || Temporal.Instant.compare(delivery, now) > 0) {
    return { withdrawable: false, reason: "not_withdrawable" };
  }
  const periodEndsAt = getConsumerWithdrawalPeriodCutoff(delivery);
  if (Temporal.Instant.compare(now, periodEndsAt) >= 0) {
    return { withdrawable: false, reason: "period_ended" };
  }
  const finalDay = Temporal.PlainDate.from(pass.validUntil).subtract({
    days: 1,
  });
  const interval = getCoworkReservationInterval(
    pass.tier === "open-space" ? "open-space" : "reserved-desk",
    finalDay.toString()
  );
  if (
    earlyPerformanceConsent &&
    Temporal.Instant.compare(now, interval.endsAt) >= 0
  ) {
    return { withdrawable: false, reason: "performance_started" };
  }
  const today = getWorkspaceDate(now);
  const { accessEndsOn: paidDaysEnd, refund } = getUnlimitedPassWithdrawal({
    startDate: pass.validFrom,
    withdrawalDate: plainDateStringSchema.make(today.toString()),
    paid,
  });
  const unstarted = Temporal.PlainDate.from(paidDaysEnd).until(
    getUnlimitedPassEndDate(pass.validFrom)
  ).days;
  const beforeStart = unstarted === unlimitedPassDays;
  const fullRefund = beforeStart || !earlyPerformanceConsent;
  const retainedThrough =
    Temporal.PlainDate.compare(today, finalDay) < 0 ? today : finalDay;
  return {
    withdrawable: true,
    accessEndsOn: beforeStart
      ? pass.validFrom
      : plainDateStringSchema.make(retainedThrough.add({ days: 1 }).toString()),
    refundAmount: fullRefund ? paid : refund,
    refundBasis: fullRefund
      ? { kind: "full" }
      : { kind: "partial", unit: "day", unstarted, total: unlimitedPassDays },
    periodEndsAt,
  };
};

/** The cutoff and refund obligation commit with the buyer's statement. */
export const recordUnlimitedPassWithdrawal = Effect.fn(
  "recordUnlimitedPassWithdrawal"
)(function* (input: {
  readonly orderId: OrderId;
  readonly accountId: CustomerAccountId;
  readonly submittedAt: Temporal.Instant;
  readonly paidAmount: Money;
  readonly refundAmount: Money;
}) {
  const { db } = yield* WorkspaceTransaction;
  const [pass] = yield* readPaidPassForWithdrawal(
    db,
    input.orderId,
    input.accountId,
    "unlimited"
  ).for("no key update", { of: passPurchases });
  if (pass?.status !== "active") return;
  const paid = paidPassAmount(pass);
  if (
    !sameMoneyUnit(paid, currencyCZK(0)) ||
    !sameMoneyUnit(paid, input.paidAmount) ||
    paid.value !== input.paidAmount.value
  ) {
    return;
  }
  const earlyPerformanceConsent = yield* readPassEarlyPerformanceConsent(
    db,
    input.orderId,
    "unlimited"
  );
  if (earlyPerformanceConsent === undefined) return;
  const terms = assessUnlimitedPassWithdrawal({
    pass,
    paid,
    now: input.submittedAt,
    earlyPerformanceConsent,
  });
  if (!terms.withdrawable) return;
  const { accessEndsOn, refundAmount: refund, periodEndsAt } = terms;
  if (
    !sameMoneyUnit(refund, input.refundAmount) ||
    refund.value !== input.refundAmount.value
  ) {
    return;
  }
  yield* db
    .update(passPurchases)
    .set({ status: "withdrawn", accessEndsOn })
    .where(eq(passPurchases.id, input.orderId));
  yield* markPassWithdrawalRefund(pass.attemptId, refund, input.submittedAt);
  return periodEndsAt;
});

export class UnlimitedPassWithdrawals extends Context.Service<
  UnlimitedPassWithdrawals,
  WithdrawableContractFamily
>()("@deskohub-workspace/passes/UnlimitedPassWithdrawals") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const snapshots = yield* AccountingDocumentSnapshots;
      return {
        kind,
        find: Effect.fn("UnlimitedPassWithdrawals.find")(
          function* ({ contractId, accountId, locale }) {
            const id = decodePassWithdrawalOrderId(contractId);
            if (Option.isNone(id)) return Option.none();
            const [pass] = yield* readPaidPassForWithdrawal(
              db,
              id.value,
              accountId,
              "unlimited"
            );
            if (!pass) return Option.none();
            const paid = paidPassAmount(pass);
            if (!sameMoneyUnit(paid, currencyCZK(0))) return Option.none();
            const snapshot = yield* snapshots.findPassPurchase(pass.attemptId);
            if (
              snapshot?.orderId !== id.value ||
              snapshot.product.kind !== "unlimited"
            ) {
              return Option.none();
            }
            const business = snapshot.billing.purpose === "business";
            const earlyPerformanceConsent =
              yield* readPassEarlyPerformanceConsent(db, id.value, "unlimited");
            if (earlyPerformanceConsent === undefined) return Option.none();
            return Option.some<WithdrawableContract>({
              ref: { kind, id: id.value },
              label: getPassWithdrawalLabel(pass, locale),
              paidAmount: paid,
              assess: (now) => {
                if (pass.status !== "active") {
                  return { withdrawable: false, reason: "not_withdrawable" };
                }
                if (business) {
                  return { withdrawable: false, reason: "business_purpose" };
                }
                return assessUnlimitedPassWithdrawal({
                  pass,
                  paid,
                  now,
                  earlyPerformanceConsent,
                });
              },
            });
          },
          Effect.mapError(
            (cause) =>
              new WithdrawableContractUnavailableError({
                kind,
                message:
                  "The Unlimited pass could not be read for a withdrawal.",
                cause,
              })
          )
        ),
        cancel: Effect.fn("UnlimitedPassWithdrawals.cancel")(function* ({
          contractId,
        }) {
          const id = decodePassWithdrawalOrderId(contractId);
          if (Option.isNone(id)) {
            return yield* new ContractCancellationError({
              kind,
              code: "unlimited_pass_invalid_id",
              transient: false,
              message: "The withdrawn Unlimited pass id is invalid.",
            });
          }
          const moveJournal = passDayMoveJournal(db);
          const pendingMove = db
            .select({ id: moveJournal.generation })
            .from(moveJournal)
            .where(
              and(
                eq(moveJournal.reservationId, workspaceReservations.id),
                isNull(moveJournal.settledAt)
              )
            );
          const pendingDays = db
            .select({ id: workspaceReservations.id })
            .from(workspaceReservations)
            .where(
              and(
                eq(workspaceReservations.passId, passPurchases.id),
                gte(
                  workspaceReservations.serviceDate,
                  passPurchases.accessEndsOn
                ),
                or(
                  // The release worker uses hold_expired when no provider hold was made.
                  notInArray(workspaceReservations.reservationState, [
                    "cancelled",
                    "hold_expired",
                  ]),
                  // A staged replacement or replaced source may still hold a seat.
                  exists(pendingMove)
                )
              )
            );
          const [pass] = yield* db
            .select({ pending: sql<boolean>`exists (${pendingDays})` })
            .from(passPurchases)
            .where(
              and(
                eq(passPurchases.id, id.value),
                eq(passPurchases.product, "unlimited"),
                eq(passPurchases.status, "withdrawn"),
                isNotNull(passPurchases.accessEndsOn)
              )
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ContractCancellationError({
                    kind,
                    code: "unlimited_pass_release_check_failed",
                    transient: true,
                    message:
                      "The release of withdrawn Unlimited pass days could not be checked.",
                    cause,
                  })
              )
            );
          if (!pass) {
            return yield* new ContractCancellationError({
              kind,
              code: "unlimited_pass_release_missing",
              transient: false,
              message: "The withdrawn Unlimited pass or its cutoff is missing.",
            });
          }
          if (pass.pending) {
            return yield* new ContractCancellationError({
              kind,
              code: "unlimited_pass_release_pending",
              transient: false,
              message:
                "The withdrawn Unlimited pass still has days to release.",
            });
          }
        }),
      };
    })
  );
}
