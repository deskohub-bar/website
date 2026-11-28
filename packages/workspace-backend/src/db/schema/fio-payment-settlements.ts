import type { PaymentAttemptId } from "@deskohub/workspace-domain/features/checkout/checkout-identifiers";
import type { OrderId } from "@deskohub/workspace-domain/features/order/order";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { instant } from "../instant";
import { postgresUuidV7 } from "../uuid-v7";
import { orders } from "./orders";
import { paymentAttempts } from "./payment-attempts";
import { quotedSqlList } from "./sql-list";

const dispositions = [
  "discrepancy",
  "winner",
  "recovery_pending",
  "review_required",
  "refund_required",
  "refunded",
] as const;

const discrepancyReasons = [
  "reference_absent",
  "reference_invalid",
  "reference_unmatched",
  "non_credit",
  "amount_mismatch",
  "currency_mismatch",
] as const;

export type FioSettlementDisposition = (typeof dispositions)[number];
export type FioSettlementDiscrepancyReason =
  (typeof discrepancyReasons)[number];

export const fioPaymentSettlements = pgTable(
  "fio_payment_settlements",
  {
    id: text("id").primaryKey().default(postgresUuidV7),
    orderId: text("order_id")
      .$type<OrderId>()
      .references(() => orders.id),
    paymentAttemptId: text("payment_attempt_id")
      .$type<PaymentAttemptId>()
      .references(() => paymentAttempts.id),
    accountKey: text("account_key").notNull(),
    movementId: text("movement_id").notNull(),
    variableSymbol: text("variable_symbol"),
    amountValue: bigint("amount_value", { mode: "number" }),
    currency: text("currency").notNull(),
    decimalAmount: text("decimal_amount"),
    bookingDate: date("booking_date", { mode: "string" }).notNull(),
    observedAt: instant("observed_at").notNull(),
    disposition: text("disposition")
      .notNull()
      .$type<FioSettlementDisposition>(),
    discrepancyReason:
      text("discrepancy_reason").$type<FioSettlementDiscrepancyReason>(),
    refundedAt: instant("refunded_at"),
  },
  (t) => [
    check(
      "fio_payment_settlements_disposition_check",
      sql`${t.disposition} in (${quotedSqlList(dispositions)})`
    ),
    check(
      "fio_payment_settlements_amount_check",
      sql`(${t.currency} = 'CZK' and ${t.amountValue} is not null and ${t.decimalAmount} is null)
        or (${t.currency} <> 'CZK' and ${t.amountValue} is null and ${t.decimalAmount} is not null)`
    ),
    check(
      "fio_payment_settlements_discrepancy_check",
      sql`(${t.disposition} = 'discrepancy') = (${t.discrepancyReason} is not null)
        and ${t.discrepancyReason} in (${quotedSqlList(discrepancyReasons)})`
    ),
    check(
      "fio_payment_settlements_reference_check",
      sql`(${t.orderId} is null) = (${t.paymentAttemptId} is null)
        and (${t.disposition} = 'discrepancy' or ${t.orderId} is not null)
        and (${t.orderId} is null or ${t.variableSymbol} is not null)`
    ),
    check(
      "fio_payment_settlements_refund_check",
      sql`(${t.disposition} = 'refunded') = (${t.refundedAt} is not null)`
    ),
    uniqueIndex("fio_payment_settlements_movement_idx").on(
      t.accountKey,
      t.movementId
    ),
    index("fio_payment_settlements_account_idx").on(t.accountKey, t.id),
    index("fio_payment_settlements_order_idx").on(t.orderId, t.id),
    index("fio_payment_settlements_attempt_idx").on(t.paymentAttemptId),
  ]
);

export type FioPaymentSettlement = typeof fioPaymentSettlements.$inferSelect;
