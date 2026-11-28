import { and, eq, exists, isNull, type SQLWrapper, sql } from "drizzle-orm";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { passAdministrationChanges } from "@/db/schema";
import type { OrderId } from "@/features/order";
import type { PassChange } from "../admin/pass-change";

export const pendingPassChange = and(
  isNull(passAdministrationChanges.completedAt),
  isNull(passAdministrationChanges.failedAt)
);

export const hasPendingPassChange = (
  db: WorkspaceDatabaseClient,
  passId: OrderId | SQLWrapper,
  kind?: PassChange["_tag"]
) =>
  exists(
    db
      .select({ id: passAdministrationChanges.requestId })
      .from(passAdministrationChanges)
      .where(
        and(
          eq(passAdministrationChanges.passId, passId),
          pendingPassChange,
          kind === undefined
            ? undefined
            : sql`${passAdministrationChanges.change}->>'_tag' = ${kind}`
        )
      )
  );
