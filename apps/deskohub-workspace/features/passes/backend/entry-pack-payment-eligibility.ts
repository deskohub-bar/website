import { and, eq, exists, isNotNull, lt, or, sql } from "drizzle-orm";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { orders, passPurchases, paymentAttempts } from "@/db/schema";

/** A recorded partial adjustment preserves a pass that remains active. */
const claimablePassRefund = or(
  eq(paymentAttempts.refundState, "not_required"),
  and(
    lt(paymentAttempts.refundTargetValue, paymentAttempts.amountValue),
    lt(
      sql`coalesce(${paymentAttempts.refundedAmountValue}, 0)`,
      paymentAttempts.amountValue
    )
  )
);

/** Checks the order on the outer pass row, including later refunds. */
export const hasClaimablePassOrder = (db: WorkspaceDatabaseClient) =>
  exists(
    db
      .select({ id: orders.id })
      .from(orders)
      .leftJoin(
        paymentAttempts,
        and(
          eq(paymentAttempts.id, orders.activePaymentAttemptId),
          eq(paymentAttempts.orderId, orders.id)
        )
      )
      .where(
        and(
          eq(orders.id, passPurchases.id),
          eq(orders.kind, "pass-purchase"),
          or(
            and(
              eq(orders.paymentState, "complimentary"),
              eq(orders.fulfillmentState, "fulfilled")
            ),
            and(
              eq(orders.paymentState, "paid"),
              isNotNull(orders.paidAt),
              eq(paymentAttempts.state, "paid"),
              claimablePassRefund
            )
          )
        )
      )
  );
