import "server-only";

import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases, paymentAttempts } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";

export const findOwnedPassPurchaseOrder = Effect.fn(
  "findOwnedPassPurchaseOrder"
)(function* (
  orderId: OrderId,
  buyerAccountId: CustomerAccountId,
  product: typeof passPurchases.$inferSelect.product
) {
  const { db } = yield* WorkspaceDatabase;
  const [entry] = yield* db
    .select({
      order: orders,
      purchase: passPurchases,
      activeAttempt: {
        state: paymentAttempts.state,
        refundState: paymentAttempts.refundState,
      },
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .leftJoin(
      paymentAttempts,
      and(
        eq(paymentAttempts.id, orders.activePaymentAttemptId),
        eq(paymentAttempts.orderId, orders.id)
      )
    )
    .where(
      and(
        eq(passPurchases.id, orderId),
        eq(passPurchases.product, product),
        eq(passPurchases.buyerAccountId, buyerAccountId),
        eq(orders.kind, "pass-purchase")
      )
    );
  return entry;
});

export const findOwnedEntryPackOrder = Effect.fn("findOwnedEntryPackOrder")(
  function* (orderId: OrderId, buyerAccountId: CustomerAccountId) {
    const entry = yield* findOwnedPassPurchaseOrder(
      orderId,
      buyerAccountId,
      "entry-pack"
    );
    if (entry && entry.purchase.entryCount !== null) {
      return {
        ...entry,
        purchase: { ...entry.purchase, entryCount: entry.purchase.entryCount },
      };
    }
  }
);

/** The issued locale is visible only to the active, verified buyer. */
export const readOwnedPassPurchaseOrderLocale = Effect.fn(
  "readOwnedPassPurchaseOrderLocale"
)(function* (
  orderId: OrderId,
  product: typeof passPurchases.$inferSelect.product
) {
  const current = yield* CurrentCustomerAccount;
  const session = yield* current.requireActive.pipe(
    Effect.catchTag("CustomerAccountAccessError", (error) =>
      error.reason === "unavailable" ? Effect.fail(error) : Effect.undefined
    )
  );
  if (!session) return undefined;
  const entry = yield* findOwnedPassPurchaseOrder(
    orderId,
    session.accountId,
    product
  );
  return entry?.purchase.locale;
});
