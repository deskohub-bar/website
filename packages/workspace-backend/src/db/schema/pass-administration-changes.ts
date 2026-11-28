import type { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import type { CustomerAccountId } from "@deskohub/workspace-domain/features/account/customer-account";
import type { OrderId } from "@deskohub/workspace-domain/features/order/order";
import type { PassChange } from "@deskohub/workspace-domain/features/passes/admin/pass-change";
import type { PlainDate } from "@deskohub/workspace-domain/shared/utils/temporal";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { instant } from "../instant";
import { sensitiveText } from "../sensitive-text";
import { customerAccounts } from "./customer-accounts";
import { passPurchases } from "./pass-purchases";

export type PassTransferProgress = {
  readonly rollingBack: boolean;
  readonly attempted: readonly PlainDate[];
  readonly transferred: readonly PlainDate[];
  readonly conflicts: readonly PlainDate[];
};

/** The operator's accepted change and its durable progress across provider calls. */
export const passAdministrationChanges = pgTable(
  "pass_administration_changes",
  {
    requestId: uuid("request_id").primaryKey(),
    passId: text("pass_id")
      .notNull()
      .$type<OrderId>()
      .references(() => passPurchases.id),
    actorAccountId: text("actor_account_id")
      .notNull()
      .$type<CustomerAccountId>()
      .references(() => customerAccounts.id),
    actorAccountEmail: sensitiveText("actor_account_email").notNull(),
    reason: sensitiveText("reason").notNull(),
    change: jsonb("change")
      .notNull()
      .$type<PassChange<typeof DotyposCustomerIdSchema>>(),
    requestedAt: instant("requested_at").notNull(),
    lastAttemptAt: instant("last_attempt_at"),
    holdRollbackAt: instant("hold_rollback_at"),
    transferProgress: jsonb("transfer_progress").$type<PassTransferProgress>(),
    completedAt: instant("completed_at"),
    failedAt: instant("failed_at"),
  },
  (t) => [
    check(
      "pass_administration_changes_result_check",
      sql`num_nonnulls(${t.completedAt}, ${t.failedAt}) <= 1
        and (${t.completedAt} is null or ${t.completedAt} >= ${t.requestedAt})
        and (${t.failedAt} is null or ${t.failedAt} >= ${t.requestedAt})
        and (${t.holdRollbackAt} is null or
          (${t.completedAt} is null and ${t.holdRollbackAt} >= ${t.requestedAt}))`
    ),
    index("pass_administration_changes_pass_requested_idx").on(
      t.passId,
      t.requestedAt
    ),
    uniqueIndex("pass_administration_changes_pending_pass_idx")
      .on(t.passId)
      .where(sql`${t.completedAt} is null and ${t.failedAt} is null`),
  ]
);
