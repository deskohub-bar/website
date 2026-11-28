import { sql } from "drizzle-orm";
import { check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { instant } from "../instant";
import { sensitiveText } from "../sensitive-text";
import { quotedSqlList } from "./sql-list";

export const mockPaymentOutcomes = ["pending", "approved", "declined"] as const;

export type MockPaymentOutcome = (typeof mockPaymentOutcomes)[number];

export const mockPaymentSessions = pgTable(
  "mock_payment_sessions",
  {
    paymentId: text("payment_id").primaryKey(),
    capabilityHash: sensitiveText("capability_hash").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    returnUrl: sensitiveText("return_url").notNull(),
    outcome: text("outcome")
      .notNull()
      .default("pending")
      .$type<MockPaymentOutcome>(),
    createdAt: instant("created_at").notNull().default(sql`now()`),
    decidedAt: instant("decided_at"),
    cancelledAt: instant("cancelled_at"),
    refundedAt: instant("refunded_at"),
    refundedAmountMinor: integer("refunded_amount_minor"),
  },
  (t) => [
    check("mock_payment_sessions_amount_check", sql`${t.amountMinor} > 0`),
    check(
      "mock_payment_sessions_currency_check",
      sql`${t.currency} ~ '^[A-Z]{3}$'`
    ),
    check(
      "mock_payment_sessions_outcome_check",
      sql`${t.outcome} in (${quotedSqlList(mockPaymentOutcomes)}) and (${t.outcome} = 'pending') = (${t.decidedAt} is null)`
    ),
    check(
      "mock_payment_sessions_refund_check",
      sql`(${t.refundedAt} is null and ${t.refundedAmountMinor} is null) or (${t.outcome} = 'approved' and ${t.refundedAt} is not null and ${t.refundedAmountMinor} is not null and ${t.refundedAmountMinor} > 0 and ${t.refundedAmountMinor} <= ${t.amountMinor})`
    ),
  ]
);
