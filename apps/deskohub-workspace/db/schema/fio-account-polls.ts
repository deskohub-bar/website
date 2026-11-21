import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const fioAccountPolls = pgTable("fio_account_polls", {
  accountKey: text("account_key").primaryKey(),
  firstDemandDate: date("first_demand_date").notNull(),
  coveredThrough: date("covered_through"),
  deliveryId: uuid("delivery_id"),
  deliveryExpiresAt: timestamp("delivery_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  readId: uuid("read_id"),
  readNotBefore: timestamp("read_not_before", {
    withTimezone: true,
    mode: "date",
  }),
});
