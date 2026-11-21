import { and, eq, exists, isNotNull } from "drizzle-orm";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { orders, passPurchases, paymentAttempts } from "@/db/schema";

/** Checks the payment on the outer pass row, including later refunds. */
export const hasUnrefundedEntryPackPayment = (db: WorkspaceDatabaseClient) =>
  exists(
    db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(
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
          eq(orders.paymentState, "paid"),
          isNotNull(orders.paidAt),
          eq(paymentAttempts.state, "paid"),
          eq(paymentAttempts.refundState, "not_required")
        )
      )
  );
