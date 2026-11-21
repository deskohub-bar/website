import { pgSequence, pgTable, text } from "drizzle-orm/pg-core";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { OrderId } from "@/features/order";
import { instant } from "../instant";
import { orders } from "./orders";
import { paymentAttempts } from "./payment-attempts";

export const qrPaymentReferences = pgSequence("qr_payment_references", {
  startWith: 1000000000,
  maxValue: 9999999999,
});

export const reservationPaymentWindows = pgTable(
  "reservation_payment_windows",
  {
    orderId: text("order_id")
      .primaryKey()
      .$type<OrderId>()
      .references(() => orders.id, { onDelete: "cascade" }),
    accountKey: text("account_key").notNull(),
    expiresAt: instant("expires_at").notNull(),
    cardAttemptId: text("card_attempt_id")
      .$type<PaymentAttemptId>()
      .references(() => paymentAttempts.id, { onDelete: "set null" }),
    qrAttemptId: text("qr_attempt_id")
      .$type<PaymentAttemptId>()
      .references(() => paymentAttempts.id, { onDelete: "set null" }),
  }
);
