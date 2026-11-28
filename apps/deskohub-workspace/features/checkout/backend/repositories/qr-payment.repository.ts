import { and, eq, gt, inArray, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  paymentAttempts,
  reservationPaymentWindows,
  workspaceReservations,
} from "@/db/schema";
import {
  findReservationOrderId,
  type WorkspaceReservationId,
} from "@/features/reservation/persistence-contracts";
import { toPaymentAttempt } from "./payment-attempt.repository";

export class QrPaymentRepository extends Context.Service<QrPaymentRepository>()(
  "@deskohub-workspace/checkout/QrPaymentRepository",
  {
    make: Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const findQrAttempt = Effect.fnUntraced(function* (
        predicate: SQL | undefined
      ) {
        const [row] = yield* db
          .select({
            window: reservationPaymentWindows,
            attempt: paymentAttempts,
          })
          .from(reservationPaymentWindows)
          .innerJoin(
            paymentAttempts,
            eq(reservationPaymentWindows.qrAttemptId, paymentAttempts.id)
          )
          .where(predicate)
          .limit(1);
        return row
          ? {
              orderId: row.window.orderId,
              attemptId: row.attempt.id,
              accountKey: row.window.accountKey,
              variableSymbol: row.attempt.providerOrderId ?? "",
              amount: toPaymentAttempt(row.attempt).amount,
              expiresAt: row.window.expiresAt,
            }
          : null;
      });

      return {
        findForReservation: Effect.fnUntraced(function* (
          id: WorkspaceReservationId
        ) {
          const orderId = findReservationOrderId(id);
          if (Option.isNone(orderId)) return null;
          return yield* findQrAttempt(
            eq(reservationPaymentWindows.orderId, orderId.value)
          );
        }),
        findByReference: (input: {
          accountKey: string;
          variableSymbol: string;
        }) =>
          findQrAttempt(
            and(
              eq(reservationPaymentWindows.accountKey, input.accountKey),
              eq(paymentAttempts.providerOrderId, input.variableSymbol)
            )
          ),
        findPaymentWindow: Effect.fnUntraced(function* (
          id: WorkspaceReservationId
        ) {
          const orderId = findReservationOrderId(id);
          if (Option.isNone(orderId)) return null;
          const [result] = yield* db
            .select()
            .from(reservationPaymentWindows)
            .where(eq(reservationPaymentWindows.orderId, orderId.value))
            .limit(1);
          return result ?? null;
        }),
        findCardAttempt: Effect.fnUntraced(function* (
          id: WorkspaceReservationId
        ) {
          const orderId = findReservationOrderId(id);
          if (Option.isNone(orderId)) return null;
          const [result] = yield* db
            .select({ attempt: paymentAttempts })
            .from(reservationPaymentWindows)
            .innerJoin(
              paymentAttempts,
              eq(reservationPaymentWindows.cardAttemptId, paymentAttempts.id)
            )
            .where(eq(reservationPaymentWindows.orderId, orderId.value))
            .limit(1);
          return result ? toPaymentAttempt(result.attempt) : null;
        }),
        hasPayableAttempts: Effect.fnUntraced(function* (accountKey: string) {
          const [result] = yield* db
            .select({ id: workspaceReservations.id })
            .from(reservationPaymentWindows)
            .innerJoin(
              workspaceReservations,
              eq(workspaceReservations.id, reservationPaymentWindows.orderId)
            )
            .innerJoin(
              paymentAttempts,
              eq(reservationPaymentWindows.qrAttemptId, paymentAttempts.id)
            )
            .where(
              and(
                eq(reservationPaymentWindows.accountKey, accountKey),
                gt(reservationPaymentWindows.expiresAt, Temporal.Now.instant()),
                eq(workspaceReservations.reservationState, "held"),
                eq(workspaceReservations.paymentState, "pending"),
                inArray(paymentAttempts.state, ["created", "pending"])
              )
            )
            .limit(1);
          return result !== undefined;
        }),
      };
    }),
  }
) {
  static readonly Default = Layer.effect(this, this.make);
}
