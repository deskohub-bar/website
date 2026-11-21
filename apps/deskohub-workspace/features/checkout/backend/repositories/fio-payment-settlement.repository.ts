import {
  and,
  desc,
  eq,
  getColumns,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  latePaymentRecoveries,
  orders,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";
import {
  type FioPaymentSettlement,
  type FioSettlementDisposition,
  fioPaymentSettlements,
} from "@/db/schema/fio-payment-settlements";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { OrderId } from "@/features/order/order";

type NewSettlement = Omit<
  typeof fioPaymentSettlements.$inferInsert,
  "id" | "refundedAt"
>;

export type FioAccountSettlementPage = {
  readonly accountKey: string;
  readonly beforeId?: string;
  readonly unlinkedOnly?: boolean;
};

export type FioStaffSettlement = FioPaymentSettlement & {
  readonly refundTargetValue: number | null;
};

interface IFioPaymentSettlementRepository {
  readonly claimMovement: (
    input: NewSettlement
  ) => Effect.Effect<
    { readonly settlement: FioPaymentSettlement; readonly inserted: boolean },
    DatabaseQueryError,
    WorkspaceTransaction
  >;
  readonly settleExactCredit: (input: {
    readonly settlementId: string;
    readonly orderId: OrderId;
    readonly paymentAttemptId: PaymentAttemptId;
    readonly disposition: "winner" | "recovery_pending" | "refund_required";
  }) => Effect.Effect<
    FioPaymentSettlement,
    DatabaseQueryError,
    WorkspaceTransaction
  >;
  readonly resolveRecovery: (input: {
    readonly paymentAttemptId: PaymentAttemptId;
    readonly movementId: string;
    readonly disposition: Extract<
      FioSettlementDisposition,
      "winner" | "refund_required" | "review_required"
    >;
  }) => Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction>;
  readonly listForAccount: (
    input: FioAccountSettlementPage
  ) => Effect.Effect<readonly FioPaymentSettlement[], DatabaseQueryError>;
  readonly listPendingDispatch: (input: {
    readonly accountKey: string;
    readonly beforeId?: string | undefined;
  }) => Effect.Effect<readonly FioPaymentSettlement[], DatabaseQueryError>;
  readonly listForStaff: (input: {
    readonly kind: "unmatched" | "refund_required";
    readonly beforeId?: string;
  }) => Effect.Effect<readonly FioStaffSettlement[], DatabaseQueryError>;
  readonly listForOrder: (
    orderId: OrderId
  ) => Effect.Effect<readonly FioStaffSettlement[], DatabaseQueryError>;
  readonly markManualRefunded: (
    settlementId: string,
    refundedAt: Temporal.Instant
  ) => Effect.Effect<FioPaymentSettlement | null, DatabaseQueryError>;
}

export class FioPaymentSettlementRepository extends Context.Service<
  FioPaymentSettlementRepository,
  IFioPaymentSettlementRepository
>()("FioPaymentSettlementRepository") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db, transaction } = yield* WorkspaceDatabase;
      // A partial target belongs to the receipt that paid the attempt.
      // Other movements on the same attempt still owe their full amount.
      const selectStaffSettlements = () =>
        db
          .select({
            ...getColumns(fioPaymentSettlements),
            refundTargetValue: paymentAttempts.refundTargetValue,
          })
          .from(fioPaymentSettlements)
          .leftJoin(
            paymentAttempts,
            and(
              eq(fioPaymentSettlements.disposition, "refund_required"),
              eq(paymentAttempts.id, fioPaymentSettlements.paymentAttemptId),
              eq(paymentAttempts.provider, "fio"),
              eq(paymentAttempts.state, "paid"),
              eq(paymentAttempts.refundState, "required"),
              eq(
                paymentAttempts.lastProviderOperationId,
                fioPaymentSettlements.movementId
              )
            )
          );

      return FioPaymentSettlementRepository.of({
        claimMovement: Effect.fn("fioPaymentSettlements.claimMovement")(
          function* (input) {
            const { db } = yield* WorkspaceTransaction;
            const [inserted] = yield* db
              .insert(fioPaymentSettlements)
              .values(input)
              .onConflictDoNothing({
                target: [
                  fioPaymentSettlements.accountKey,
                  fioPaymentSettlements.movementId,
                ],
              })
              .returning();
            if (inserted) return { settlement: inserted, inserted: true };

            const [existing] = yield* db
              .select()
              .from(fioPaymentSettlements)
              .where(
                and(
                  eq(fioPaymentSettlements.accountKey, input.accountKey),
                  eq(fioPaymentSettlements.movementId, input.movementId)
                )
              );
            if (!existing)
              return yield* Effect.die(
                new Error("Fio movement claim disappeared.")
              );
            return { settlement: existing, inserted: false };
          }
        ),
        settleExactCredit: Effect.fn("fioPaymentSettlements.settleExactCredit")(
          function* ({ settlementId, orderId, paymentAttemptId, disposition }) {
            const { db } = yield* WorkspaceTransaction;
            const [settlement] = yield* db
              .update(fioPaymentSettlements)
              .set({
                orderId,
                paymentAttemptId,
                disposition,
                discrepancyReason: null,
              })
              .where(eq(fioPaymentSettlements.id, settlementId))
              .returning();
            if (!settlement)
              return yield* Effect.die(
                new Error("Claimed Fio movement disappeared.")
              );
            return settlement;
          }
        ),
        resolveRecovery: Effect.fn("fioPaymentSettlements.resolveRecovery")(
          function* ({ paymentAttemptId, movementId, disposition }) {
            const { db } = yield* WorkspaceTransaction;
            yield* db
              .update(fioPaymentSettlements)
              .set({ disposition })
              .where(
                and(
                  eq(fioPaymentSettlements.paymentAttemptId, paymentAttemptId),
                  eq(fioPaymentSettlements.movementId, movementId),
                  eq(fioPaymentSettlements.disposition, "recovery_pending")
                )
              );
          }
        ),
        listForAccount: ({ accountKey, beforeId, unlinkedOnly }) =>
          db
            .select()
            .from(fioPaymentSettlements)
            .where(
              and(
                eq(fioPaymentSettlements.accountKey, accountKey),
                beforeId === undefined
                  ? undefined
                  : lt(fioPaymentSettlements.id, beforeId),
                unlinkedOnly
                  ? and(
                      isNull(fioPaymentSettlements.orderId),
                      eq(fioPaymentSettlements.disposition, "discrepancy")
                    )
                  : undefined
              )
            )
            .orderBy(desc(fioPaymentSettlements.id))
            .limit(100),
        listPendingDispatch: ({ accountKey, beforeId }) =>
          db
            .select({ settlement: fioPaymentSettlements })
            .from(fioPaymentSettlements)
            .innerJoin(orders, eq(orders.id, fioPaymentSettlements.orderId))
            .innerJoin(
              workspaceReservations,
              eq(workspaceReservations.id, orders.id)
            )
            .leftJoin(
              latePaymentRecoveries,
              eq(
                latePaymentRecoveries.paymentAttemptId,
                fioPaymentSettlements.paymentAttemptId
              )
            )
            .where(
              and(
                eq(fioPaymentSettlements.accountKey, accountKey),
                beforeId === undefined
                  ? undefined
                  : lt(fioPaymentSettlements.id, beforeId),
                or(
                  and(
                    eq(fioPaymentSettlements.disposition, "winner"),
                    eq(
                      orders.activePaymentAttemptId,
                      fioPaymentSettlements.paymentAttemptId
                    ),
                    eq(orders.paymentState, "paid"),
                    inArray(orders.fulfillmentState, [
                      "not_started",
                      "processing",
                    ]),
                    inArray(workspaceReservations.reservationState, [
                      "held",
                      "confirmed",
                    ])
                  ),
                  and(
                    eq(fioPaymentSettlements.disposition, "recovery_pending"),
                    eq(latePaymentRecoveries.state, "pending"),
                    eq(
                      latePaymentRecoveries.providerOperationId,
                      fioPaymentSettlements.movementId
                    )
                  )
                )
              )
            )
            .orderBy(desc(fioPaymentSettlements.id))
            .limit(100)
            .pipe(
              Effect.map((rows) => rows.map(({ settlement }) => settlement))
            ),
        listForStaff: ({ kind, beforeId }) =>
          selectStaffSettlements()
            .where(
              and(
                kind === "unmatched"
                  ? and(
                      isNull(fioPaymentSettlements.orderId),
                      eq(fioPaymentSettlements.disposition, "discrepancy")
                    )
                  : eq(fioPaymentSettlements.disposition, "refund_required"),
                beforeId === undefined
                  ? undefined
                  : lt(fioPaymentSettlements.id, beforeId)
              )
            )
            .orderBy(desc(fioPaymentSettlements.id))
            .limit(100),
        listForOrder: (orderId) =>
          selectStaffSettlements()
            .where(eq(fioPaymentSettlements.orderId, orderId))
            .orderBy(desc(fioPaymentSettlements.id)),
        markManualRefunded: Effect.fn(
          "fioPaymentSettlements.markManualRefunded"
        )(function* (settlementId, refundedAt) {
          return yield* transaction(
            Effect.gen(function* () {
              const findSettlement = () =>
                db
                  .select()
                  .from(fioPaymentSettlements)
                  .where(eq(fioPaymentSettlements.id, settlementId))
                  .limit(1);
              const [settlement] = yield* findSettlement();
              if (settlement?.disposition === "refunded") return settlement;
              if (settlement?.disposition !== "refund_required") return null;

              // Cancellation and restoration update the attempt before its
              // evidence. Keep that lock order while recording a manual refund.
              const [attempt] = settlement.paymentAttemptId
                ? yield* db
                    .select()
                    .from(paymentAttempts)
                    .where(
                      and(
                        eq(paymentAttempts.id, settlement.paymentAttemptId),
                        eq(paymentAttempts.provider, "fio"),
                        eq(paymentAttempts.state, "paid")
                      )
                    )
                    .limit(1)
                    .for("update")
                : [];
              const [updated] = yield* db
                .update(fioPaymentSettlements)
                .set({ disposition: "refunded", refundedAt })
                .where(
                  and(
                    eq(fioPaymentSettlements.id, settlementId),
                    eq(fioPaymentSettlements.disposition, "refund_required")
                  )
                )
                .returning();

              if (!updated) {
                const [current] = yield* findSettlement();
                return current?.disposition === "refunded" ? current : null;
              }

              if (
                attempt?.refundState === "required" &&
                attempt.lastProviderOperationId === updated.movementId
              ) {
                yield* db
                  .update(paymentAttempts)
                  .set({
                    refundState: "refunded",
                    refundedAt,
                    refundedAmountValue: sql`coalesce(${paymentAttempts.refundTargetValue}, ${paymentAttempts.amountValue})`,
                    updatedAt: refundedAt,
                  })
                  .where(eq(paymentAttempts.id, attempt.id));
              }
              return updated;
            })
          );
        }),
      });
    })
  );
}
