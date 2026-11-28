import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { customerAccounts } from "@/db/schema";
import { authUser } from "@/db/schema/auth";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { connectWorkspacePostgresTestDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { E2EDatabase } from "../integrations/database.service";
import {
  findLinkedDotyposCustomerId,
  removeSyntheticAccountLink,
  removeSyntheticAuthUser,
} from "./auth-rows";

const testDatabase = await connectWorkspacePostgresTestDatabase();

const insertAuthUser = (id: string) =>
  workspaceFixtures(requireValue(testDatabase, "disposable Postgres").db)
    .account("auth-rows", { id: customerAccountIdSchema.make(id) })
    .pipe(Effect.runPromise);

const removeAccount = (accountId: string) =>
  removeSyntheticAuthUser(accountId).pipe(
    Effect.provideService(
      E2EDatabase,
      E2EDatabase.of({
        db: requireValue(testDatabase, "disposable Postgres").db,
      })
    ),
    Effect.runPromise
  );

/** The tombstone's deletion instant, null while active, undefined when absent. */
const readDeletedAt = async (accountId: string) => {
  const [row] = await requireValue(testDatabase, "disposable Postgres")
    .db.select({ deletedAt: customerAccounts.deletedAt })
    .from(customerAccounts)
    .where(eq(customerAccounts.id, customerAccountIdSchema.make(accountId)))
    .pipe(Effect.runPromise);
  return row === undefined ? undefined : (row.deletedAt?.toString() ?? null);
};

const authUserExists = async (accountId: string) => {
  const rows = await requireValue(testDatabase, "disposable Postgres")
    .db.select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, accountId))
    .pipe(Effect.runPromise);
  return rows.length > 0;
};

describe.skipIf(!testDatabase)(
  "Synthetic account removal on disposable Postgres",
  () => {
    test("tombstones the customer account and deletes the Better Auth user", async () => {
      const accountId = `agent-eval-${crypto.randomUUID()}`;
      await insertAuthUser(accountId);
      expect(await readDeletedAt(accountId)).toBeNull();

      await removeAccount(accountId);

      expect(await readDeletedAt(accountId)).toEqual(expect.any(String));
      expect(await authUserExists(accountId)).toBe(false);
    });

    test("leaves a tombstone for an unlinked account", async () => {
      const accountId = crypto.randomUUID();
      await insertAuthUser(accountId);

      await removeAccount(accountId);

      expect(await readDeletedAt(accountId)).toEqual(expect.any(String));
      expect(await authUserExists(accountId)).toBe(false);
    });

    test("clears the exact provider link while preserving the other account's link", async () => {
      const { db } = requireValue(testDatabase, "disposable Postgres");
      const account = customerAccountIdSchema.make(crypto.randomUUID());
      const otherAccount = customerAccountIdSchema.make(crypto.randomUUID());
      const customer = DotyposCustomerIdSchema.make(crypto.randomUUID());
      const otherCustomer = DotyposCustomerIdSchema.make(crypto.randomUUID());
      const fixtures = workspaceFixtures(db);
      const database = E2EDatabase.of({ db });

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* fixtures.customerAccount({
            id: account,
            linkedCustomer: customer,
          });
          yield* fixtures.customerAccount({
            id: otherAccount,
            linkedCustomer: otherCustomer,
          });
          yield* removeSyntheticAccountLink(account, customer);
          expect(yield* findLinkedDotyposCustomerId(account)).toBeUndefined();
          expect(yield* findLinkedDotyposCustomerId(otherAccount)).toBe(
            otherCustomer
          );
        }).pipe(Effect.provideService(E2EDatabase, database))
      );
    });

    test("keeps the first deletion instant when cleanup repeats", async () => {
      const accountId = crypto.randomUUID();
      await insertAuthUser(accountId);
      await removeAccount(accountId);
      const firstDeletedAt = await readDeletedAt(accountId);

      await removeAccount(accountId);

      expect(await readDeletedAt(accountId)).toBe(firstDeletedAt);
    });
  }
);
