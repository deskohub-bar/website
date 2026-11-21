import { isNotNull, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import type { SealedStateKeyId } from "@/shared/backend/sealed-state-keys.service";
import { instant } from "../instant";
import { customerAccounts } from "./customer-accounts";
import { passPurchases } from "./pass-purchases";

export const entryPackGiftInvitations = pgTable(
  "entry_pack_gift_invitations",
  {
    orderId: text("order_id")
      .primaryKey()
      .$type<OrderId>()
      .references(() => passPurchases.id),
    holderAccountId: text("holder_account_id")
      .notNull()
      .$type<CustomerAccountId>()
      .references(() => customerAccounts.id),
    locale: text("locale").notNull().$type<Locale>(),
    generation: integer("generation").notNull(),
    contextId: uuid("context_id").notNull().defaultRandom().unique(),
    attempts: integer("attempts").notNull(),
    requestedAt: instant("requested_at").notNull(),
    firstAttemptAt: instant("first_attempt_at"),
    nextAttemptAt: instant("next_attempt_at"),
    sentAt: instant("sent_at"),
    keyId: text("key_id").$type<SealedStateKeyId>(),
    callbackOrigin: text("callback_origin"),
    deliveryFingerprint: text("delivery_fingerprint"),
    confirmationInvited: boolean("confirmation_invited"),
  },
  (t) => [
    check("entry_pack_gift_generation_check", sql`${t.generation} >= 0`),
    check("entry_pack_gift_attempts_check", sql`${t.attempts} >= 0`),
    check(
      "entry_pack_gift_accepted_check",
      sql`${t.sentAt} is null or (${t.nextAttemptAt} is null and ${t.keyId} is not null)`
    ),
    index("entry_pack_gift_next_attempt_idx")
      .on(t.nextAttemptAt)
      .where(isNotNull(t.nextAttemptAt)),
  ]
);
