import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import { customerAccounts } from "./customer-accounts";

/** A replacement can retire a draft before its original Continue arrives. */
export const unlimitedPassSupersessions = pgTable(
  "unlimited_pass_supersessions",
  {
    buyerAccountId: text("buyer_account_id")
      .notNull()
      .$type<CustomerAccountId>()
      .references(() => customerAccounts.id),
    orderId: uuid("order_id").notNull().$type<OrderId>(),
  },
  (t) => [primaryKey({ columns: [t.buyerAccountId, t.orderId] })]
);
