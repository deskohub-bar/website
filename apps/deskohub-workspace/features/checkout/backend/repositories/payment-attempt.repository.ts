import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { equalsAny } from "@/db/equals-any";
import {
  orders,
  type PaymentAttemptRow,
  type PaymentAttemptState,
  type PaymentRefundState,
  type PaymentState,
  paymentAttempts,
  reservationPaymentWindows,
  workspaceReservations,
} from "@/db/schema";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { OrderKind } from "@/features/order";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import {
  type ReadLimitExceededError,
  readLimitSentinel,
  requireWithinReadLimit,
} from "@/shared/backend/read-limit";
import { type Money, moneyWithValue } from "@/shared/money/money";
import type { PaymentProvider } from "../payment/payment-provider";
import { newestPaymentAttemptsFirst } from "./newest-payment-attempt";

export const toPaymentAttempt = (attempt: PaymentAttemptRow) => {
  const { amountExponent, amountValue, currency, ...paymentAttempt } = attempt;

  return {
    ...paymentAttempt,
    amount: {
      value: amountValue,
      exponent: amountExponent,
      currency,
    },
  };
};

export type PaymentAttempt = ReturnType<typeof toPaymentAttempt>;

export type PaymentAttemptWithOrderKind = PaymentAttempt & {
  readonly orderKind: OrderKind;
  readonly isSharedWindowCard: boolean;
};

/**
 * The attempt's identifiers and state for log annotations. Scoped annotations
 * reach every later row, query rows included, so never annotate the record.
 */
export const paymentAttemptLogFields = (
  attempt: PaymentAttempt | null | undefined
) => ({
  paymentAttemptId: attempt?.id,
  paymentAttemptState: attempt?.state,
  providerOrderId: attempt?.providerOrderId,
});

export type ProviderPaymentAttempt = PaymentAttempt & {
  readonly provider: PaymentProvider;
  readonly providerOrderId: string;
};

export const isProviderPaymentAttempt = (
  attempt: PaymentAttempt
): attempt is ProviderPaymentAttempt =>
  (attempt.provider === "nexi" || attempt.provider === "mock") &&
  attempt.providerOrderId !== null;

/**
 * A payment attempt as the customer may see it: what was charged and refunded
 * and how the attempt ended. Leaves out provider order, operation and webhook
 * ids, provider statuses, the security token and the redirect URL.
 */
export type CustomerPaymentAttemptRecord = {
  readonly workspaceReservationId: WorkspaceReservationId;
  readonly provider: PaymentAttemptRow["provider"];
  readonly state: PaymentAttemptState;
  readonly refundState: PaymentRefundState;
  readonly amount: Money;
  /** Sum of successful refunds; `null` until a refund succeeded. */
  readonly refundedAmount: Money | null;
  readonly refundedAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
};

export interface IPaymentAttemptRepository {
  readonly findById: (
    id: PaymentAttemptId
  ) => Effect.Effect<PaymentAttempt | null, EffectDrizzleQueryError>;
  readonly findByProviderOrderId: (
    provider: PaymentProvider,
    providerOrderId: string
  ) => Effect.Effect<
    PaymentAttemptWithOrderKind | null,
    EffectDrizzleQueryError
  >;
  /**
   * The reservation's newest payment attempt, whatever its state: the one
   * a payment retry pays the order again after.
   */
  readonly findNewestForReservation: (
    workspaceReservationId: WorkspaceReservationId
  ) => Effect.Effect<PaymentAttempt | null, EffectDrizzleQueryError>;
  readonly findDisplayableForReservation: (input: {
    readonly workspaceReservationId: WorkspaceReservationId;
    readonly activePaymentAttemptId?: PaymentAttemptId;
    readonly paymentState: PaymentState;
  }) => Effect.Effect<PaymentAttempt | null, EffectDrizzleQueryError>;
  /**
   * Every payment attempt of the given reservations, oldest first. The caller
   * owns the reservations' customer scope and the `limit`, which bounds the
   * whole result: more matching attempts fail with `ReadLimitExceededError`
   * and return nothing.
   */
  readonly listForReservations: (input: {
    readonly workspaceReservationIds: readonly WorkspaceReservationId[];
    readonly limit: number;
  }) => Effect.Effect<
    readonly CustomerPaymentAttemptRecord[],
    EffectDrizzleQueryError | ReadLimitExceededError
  >;
}

export class PaymentAttemptRepository extends Context.Service<
  PaymentAttemptRepository,
  IPaymentAttemptRepository
>()("@deskohub-workspace/checkout/PaymentAttemptRepository") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;

      const findById = Effect.fn("PaymentAttemptRepository.findById")(
        function* (id: PaymentAttemptId) {
          const [attempt] = yield* db
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.id, id))
            .limit(1);
          return attempt ? toPaymentAttempt(attempt) : null;
        }
      );

      const findByProviderOrderId = Effect.fn(
        "PaymentAttemptRepository.findByProviderOrderId"
      )(function* (provider: PaymentProvider, providerOrderId: string) {
        const [row] = yield* db
          .select({
            attempt: paymentAttempts,
            orderKind: orders.kind,
            sharedCardAttemptId: reservationPaymentWindows.cardAttemptId,
          })
          .from(paymentAttempts)
          .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
          .leftJoin(
            reservationPaymentWindows,
            and(
              eq(reservationPaymentWindows.orderId, paymentAttempts.orderId),
              eq(reservationPaymentWindows.cardAttemptId, paymentAttempts.id)
            )
          )
          .where(
            and(
              eq(paymentAttempts.provider, provider),
              eq(paymentAttempts.providerOrderId, providerOrderId)
            )
          )
          .limit(1);
        return row
          ? {
              ...toPaymentAttempt(row.attempt),
              orderKind: row.orderKind,
              isSharedWindowCard: row.sharedCardAttemptId !== null,
            }
          : null;
      });

      const findNewestForReservation = Effect.fn(
        "PaymentAttemptRepository.findNewestForReservation"
      )(function* (workspaceReservationId: WorkspaceReservationId) {
        const [attempt] = yield* db
          .select()
          .from(paymentAttempts)
          .where(
            eq(paymentAttempts.workspaceReservationId, workspaceReservationId)
          )
          .orderBy(...newestPaymentAttemptsFirst)
          .limit(1);
        return attempt ? toPaymentAttempt(attempt) : null;
      });

      const findDisplayableForReservation = Effect.fn(
        "PaymentAttemptRepository.findDisplayableForReservation"
      )(function* (input: {
        readonly workspaceReservationId: WorkspaceReservationId;
        readonly activePaymentAttemptId?: PaymentAttemptId;
        readonly paymentState: PaymentState;
      }) {
        const [attempt] = yield* db
          .select()
          .from(paymentAttempts)
          .where(
            and(
              eq(
                paymentAttempts.workspaceReservationId,
                input.workspaceReservationId
              ),
              or(
                input.activePaymentAttemptId
                  ? and(
                      eq(paymentAttempts.id, input.activePaymentAttemptId),
                      inArray(paymentAttempts.state, [
                        "created",
                        "pending",
                        "paid",
                      ])
                    )
                  : sql`false`,
                input.paymentState === "paid"
                  ? eq(paymentAttempts.state, "paid")
                  : sql`false`
              )
            )
          )
          .orderBy(
            sql`case
                  when ${paymentAttempts.id} = ${input.activePaymentAttemptId ?? ""} then 0
                  when ${paymentAttempts.state} = 'paid' then 1
                  else 2
                end`,
            desc(paymentAttempts.updatedAt)
          )
          .limit(1);
        return attempt ? toPaymentAttempt(attempt) : null;
      });

      const listForReservations = Effect.fn(
        "PaymentAttemptRepository.listForReservations"
      )(function* (input: {
        readonly workspaceReservationIds: readonly WorkspaceReservationId[];
        readonly limit: number;
      }) {
        if (input.workspaceReservationIds.length === 0) return [];

        const rows = yield* db
          .select({
            workspaceReservationId: workspaceReservations.id,
            provider: paymentAttempts.provider,
            state: paymentAttempts.state,
            refundState: paymentAttempts.refundState,
            amountValue: paymentAttempts.amountValue,
            amountExponent: paymentAttempts.amountExponent,
            currency: paymentAttempts.currency,
            refundedAmountValue: paymentAttempts.refundedAmountValue,
            refundedAt: paymentAttempts.refundedAt,
            createdAt: paymentAttempts.createdAt,
            updatedAt: paymentAttempts.updatedAt,
          })
          .from(paymentAttempts)
          .innerJoin(
            workspaceReservations,
            eq(workspaceReservations.id, paymentAttempts.workspaceReservationId)
          )
          .where(
            equalsAny(
              paymentAttempts.workspaceReservationId,
              input.workspaceReservationIds
            )
          )
          .orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.id))
          .limit(readLimitSentinel(input.limit));
        const attempts = yield* requireWithinReadLimit(rows, input.limit);

        return attempts.map(
          ({
            amountValue,
            amountExponent,
            currency,
            refundedAmountValue,
            ...attempt
          }): CustomerPaymentAttemptRecord => {
            const unit = { currency, exponent: amountExponent };
            return {
              ...attempt,
              amount: moneyWithValue(amountValue, unit),
              refundedAmount:
                refundedAmountValue === null
                  ? null
                  : moneyWithValue(refundedAmountValue, unit),
            };
          }
        );
      });

      return {
        findById,
        findByProviderOrderId,
        findNewestForReservation,
        findDisplayableForReservation,
        listForReservations,
      } satisfies IPaymentAttemptRepository;
    })
  );
}
