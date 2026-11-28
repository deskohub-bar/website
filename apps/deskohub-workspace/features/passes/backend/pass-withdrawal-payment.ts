import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import {
  legalEvidenceEvents,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { paymentSubmitLegalEvidenceSource } from "@/features/checkout/legal-evidence";
import { type OrderId, orderIdSchema } from "@/features/order";
import type { Money } from "@/shared/money/money";
import type { PassProduct } from "../pass-offer";
import { hasPendingPassChange } from "./pass-administration-pending";

export const decodePassWithdrawalOrderId = Schema.decodeOption(orderIdSchema);

export const readPaidPassForWithdrawal = (
  db: WorkspaceDatabaseClient,
  id: OrderId,
  buyerAccountId: CustomerAccountId,
  product: PassProduct["kind"]
) =>
  db
    .select({
      status: passPurchases.status,
      tier: passPurchases.tier,
      entryCount: passPurchases.entryCount,
      validFrom: passPurchases.validFrom,
      validUntil: passPurchases.validUntil,
      buyerConfirmationDeliveredAt: passPurchases.buyerConfirmationDeliveredAt,
      attemptId: paymentAttempts.id,
      paidValue: paymentAttempts.amountValue,
      exponent: paymentAttempts.amountExponent,
      currency: paymentAttempts.currency,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .innerJoin(
      paymentAttempts,
      and(
        eq(paymentAttempts.id, orders.activePaymentAttemptId),
        eq(paymentAttempts.orderId, orders.id),
        eq(paymentAttempts.state, "paid")
      )
    )
    .where(
      and(
        eq(passPurchases.id, id),
        eq(passPurchases.product, product),
        eq(passPurchases.buyerAccountId, buyerAccountId),
        eq(orders.kind, "pass-purchase"),
        eq(orders.paymentState, "paid")
      )
    );

export const paidPassAmount = (pass: {
  readonly paidValue: number;
  readonly exponent: number;
  readonly currency: string;
}): Money => ({
  value: pass.paidValue,
  exponent: pass.exponent,
  currency: pass.currency,
});

export const readPassEarlyPerformanceConsent = Effect.fnUntraced(function* (
  db: WorkspaceDatabaseClient,
  orderId: OrderId,
  product: PassProduct["kind"]
) {
  const [terms] = yield* db
    .select({ acknowledgements: legalEvidenceEvents.acknowledgements })
    .from(legalEvidenceEvents)
    .where(
      and(
        eq(legalEvidenceEvents.orderId, orderId),
        eq(legalEvidenceEvents.documentKey, "termsAndConditions"),
        eq(legalEvidenceEvents.source, paymentSubmitLegalEvidenceSource),
        eq(legalEvidenceEvents.accepted, true)
      )
    )
    .orderBy(desc(legalEvidenceEvents.acceptedAt), desc(legalEvidenceEvents.id))
    .limit(1);
  if (!terms) return undefined;
  return (
    terms.acknowledgements?.earlyPerformanceConsent === true &&
    (product === "entry-pack"
      ? terms.acknowledgements.entryPackEarlyStartRequested === true
      : terms.acknowledgements.unlimitedPassEarlyStartRequested === true)
  );
});

export const lockPassOrderForWithdrawal = Effect.fn(
  "lockPassOrderForWithdrawal"
)(function* (contractId: string) {
  const id = decodePassWithdrawalOrderId(contractId);
  if (Option.isNone(id)) return undefined;
  const { db } = yield* WorkspaceTransaction;
  const [order] = yield* db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, id.value), eq(orders.kind, "pass-purchase")))
    .for("no key update");
  if (!order) return undefined;
  // Read after waiting for the order so a concurrent operator change is visible.
  const [pending] = yield* db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, order.id), hasPendingPassChange(db, order.id)));
  return pending ? undefined : order.id;
});

/** Keeps a larger outstanding or already reconciled refund on the payment. */
export const markPassWithdrawalRefund = Effect.fn("markPassWithdrawalRefund")(
  function* (
    attemptId: PaymentAttemptId,
    refund: Money,
    submittedAt: Temporal.Instant
  ) {
    if (refund.value <= 0) return;
    const { db } = yield* WorkspaceTransaction;
    // A separate refund obligation on the same payment may already be larger.
    const target = sql`case
    when ${paymentAttempts.refundState} = 'required' and ${paymentAttempts.refundTargetValue} is null
    then ${paymentAttempts.amountValue}
    else greatest(coalesce(${paymentAttempts.refundTargetValue}, 0), ${refund.value})
  end`;
    yield* db
      .update(paymentAttempts)
      .set({
        refundState: sql`case when ${paymentAttempts.refundedAmountValue} >= ${target} then 'refunded' else 'required' end`,
        refundTargetValue: target,
        updatedAt: submittedAt,
      })
      .where(
        and(
          eq(paymentAttempts.id, attemptId),
          ne(paymentAttempts.provider, "internal")
        )
      );
  }
);
