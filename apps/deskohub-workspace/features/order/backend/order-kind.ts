import { eq } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders } from "@/db/schema";
import { type OrderKind, orderIdSchema } from "@/features/order/order";
import { runWorkspaceEffect } from "@/shared/backend/workspace-effect";

const decodeOrderId = Schema.decodeUnknownOption(orderIdSchema);

/**
 * The kind of the order an ID names, or `undefined` when no order has it.
 * The ID is any non-empty route value, not necessarily a valid order ID, so
 * an ID that is not an order ID, or that no order has, reads as absent
 * instead of failing to decode.
 */
export const findOrderKind = Effect.fn("orders.findKind")(function* (
  orderId: string
) {
  const id = decodeOrderId(orderId);
  if (Option.isNone(id)) return undefined;
  const { db } = yield* WorkspaceDatabase;
  const [order] = yield* db
    .select({ kind: orders.kind })
    .from(orders)
    .where(eq(orders.id, id.value))
    .limit(1);
  return order?.kind satisfies OrderKind | undefined;
});

/**
 * Reads the kind of the order a status or access URL names, so the route can
 * serve that kind's page.
 */
export const loadOrderKind = (orderId: string) =>
  findOrderKind(orderId).pipe(
    Effect.provide(WorkspaceDatabase.Default),
    runWorkspaceEffect("order.kind.load")
  );
