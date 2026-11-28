import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import {
  orders,
  passAdministrationChanges,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { AdministratorAccountActor } from "@/features/administrators/account-role";
import type { OrderId } from "@/features/order";
import { currencyCZK } from "@/shared/money/currencies";
import { sameMoneyUnit } from "@/shared/money/money";
import { remainingPassRefundValue } from "./pass-adjustments";
import { type PassChangeRequest, passChangeSchema } from "./pass-change";

export class PassChangeRefused extends Data.TaggedError("PassChangeRefused")<{
  readonly reason:
    | "not-found"
    | "changed"
    | "pending-change"
    | "successor-present"
    | "invalid-validity"
    | "refund-limit"
    | "first-use"
    | "pending-claims"
    | "holder-unavailable"
    | "capacity"
    | "provider";
}> {}

const sameChange = Schema.toEquivalence(passChangeSchema);

export const lockPassForChange = Effect.fn("lockPassForChange")(function* (
  id: OrderId
) {
  const { db } = yield* WorkspaceTransaction;
  // Payment finalization and withdrawal use the same order-before-pass order.
  const [order] = yield* db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.kind, "pass-purchase")))
    .for("no key update");
  if (!order) return yield* new PassChangeRefused({ reason: "not-found" });
  const [purchase] = yield* db
    .select()
    .from(passPurchases)
    .where(eq(passPurchases.id, id))
    .for("no key update");
  if (!purchase) return yield* new PassChangeRefused({ reason: "not-found" });
  return { order, purchase };
});

export const readPassChangeReplay = Effect.fn("readPassChangeReplay")(
  function* (input: PassChangeRequest, actorAccountId: CustomerAccountId) {
    const { db } = yield* WorkspaceTransaction;
    const [change] = yield* db
      .select()
      .from(passAdministrationChanges)
      .where(eq(passAdministrationChanges.requestId, input.requestId));
    if (!change) return undefined;
    if (
      change.actorAccountId !== actorAccountId ||
      change.passId !== input.passId ||
      change.reason !== input.reason ||
      !sameChange(change.change, input.change)
    )
      return yield* new PassChangeRefused({ reason: "changed" });
    return change;
  }
);

export const insertPassChange = Effect.fn("insertPassChange")(function* (
  input: PassChangeRequest,
  actor: AdministratorAccountActor,
  now: Temporal.Instant,
  outcome: "pending" | "completed"
) {
  const { db } = yield* WorkspaceTransaction;
  const [record] = yield* db
    .insert(passAdministrationChanges)
    .values({
      requestId: input.requestId,
      passId: input.passId,
      actorAccountId: actor.accountId,
      actorAccountEmail: actor.email,
      change: input.change,
      reason: input.reason,
      requestedAt: now,
      completedAt: outcome === "completed" ? now : null,
    })
    .onConflictDoNothing()
    .returning();
  if (!record)
    return yield* new PassChangeRefused({ reason: "pending-change" });
  return record;
});

export const requireNoPendingPassChange = Effect.fn(
  "requireNoPendingPassChange"
)(function* (id: OrderId) {
  const { db } = yield* WorkspaceTransaction;
  const [pending] = yield* db
    .select({ id: passAdministrationChanges.requestId })
    .from(passAdministrationChanges)
    .where(
      and(
        eq(passAdministrationChanges.passId, id),
        isNull(passAdministrationChanges.completedAt),
        isNull(passAdministrationChanges.failedAt)
      )
    )
    .limit(1);
  if (pending)
    return yield* new PassChangeRefused({ reason: "pending-change" });
});

export const markPassRefund = Effect.fn("markPassRefund")(function* (
  { order }: Effect.Success<ReturnType<typeof lockPassForChange>>,
  amountValue: number,
  now: Temporal.Instant
) {
  if (amountValue === 0) return;
  if (order.paymentState !== "paid" || !order.activePaymentAttemptId) {
    return yield* new PassChangeRefused({ reason: "refund-limit" });
  }
  const { db } = yield* WorkspaceTransaction;
  const [attempt] = yield* db
    .select({
      id: paymentAttempts.id,
      amountValue: paymentAttempts.amountValue,
      currency: paymentAttempts.currency,
      exponent: paymentAttempts.amountExponent,
      refundState: paymentAttempts.refundState,
      refundTargetValue: paymentAttempts.refundTargetValue,
      refundedAmountValue: paymentAttempts.refundedAmountValue,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, order.activePaymentAttemptId),
        eq(paymentAttempts.orderId, order.id),
        eq(paymentAttempts.state, "paid"),
        eq(paymentAttempts.provider, "nexi")
      )
    )
    .for("no key update");
  if (!attempt || !sameMoneyUnit(attempt, currencyCZK(0))) {
    return yield* new PassChangeRefused({ reason: "refund-limit" });
  }
  const target =
    attempt.refundTargetValue ??
    (attempt.refundState === "required" ? attempt.amountValue : 0);
  const refunded = attempt.refundedAmountValue ?? 0;
  if (
    amountValue >
    remainingPassRefundValue(attempt.amountValue, target, refunded)
  ) {
    return yield* new PassChangeRefused({ reason: "refund-limit" });
  }
  yield* db
    .update(paymentAttempts)
    .set({
      refundState: "required",
      refundTargetValue: Math.max(target, refunded) + amountValue,
      updatedAt: now,
    })
    .where(eq(paymentAttempts.id, attempt.id));
});
