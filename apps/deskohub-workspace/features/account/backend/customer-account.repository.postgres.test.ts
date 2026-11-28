import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  connectWorkspacePostgresTestDatabase,
  requireTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { customerAccountIdSchema } from "../customer-account";
import {
  CustomerAccountRepository,
  ensureCustomerAccount,
} from "./customer-account.repository";

const testDatabase = await connectWorkspacePostgresTestDatabase();
const database = () => requireTestDatabase(testDatabase);

const isLegacy = async (accountId: string) => {
  const { rows } = await database().pool.query<{ legacy: boolean }>(
    "select legacy from customer_accounts where id = $1",
    [accountId]
  );
  return rows[0]?.legacy;
};

describe.skipIf(!testDatabase)(
  "CustomerAccountRepository on disposable Postgres",
  () => {
    test("creates a sign-up's account as a new one", async () => {
      const account = customerAccountIdSchema.make(crypto.randomUUID());
      await Effect.runPromise(
        ensureCustomerAccount(account).pipe(Effect.provide(database().layer))
      );
      expect(await isLegacy(account)).toBe(false);
    });

    test("creates a missing account's tombstone as a new one", async () => {
      const account = customerAccountIdSchema.make(crypto.randomUUID());
      await Effect.runPromise(
        Effect.flatMap(CustomerAccountRepository, (accounts) =>
          accounts.tombstone(account, Temporal.Now.instant())
        ).pipe(
          Effect.provide(
            CustomerAccountRepository.Default.pipe(
              Layer.provide(
                Layer.succeed(
                  WorkspaceDatabase,
                  WorkspaceDatabase.make(database().db)
                )
              )
            )
          )
        )
      );
      expect(await isLegacy(account)).toBe(false);
    });
  }
);
