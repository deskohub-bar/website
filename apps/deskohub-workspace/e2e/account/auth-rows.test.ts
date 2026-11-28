import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Stream } from "effect";
import type { SqlConnection } from "effect/sql";
import { makeTestDatabaseClient } from "@/shared/testing/workspace-recording-database.test-utils";
import { E2EDatabase } from "../integrations/database.service";
import { removeSyntheticAccountLink } from "./auth-rows";

const runRemoveSyntheticAccountLink = async (
  accountId: string,
  customerId: string,
  rows: readonly (readonly string[])[]
) => {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const unexpected = () => Effect.die(new Error("unexpected SQL execution"));
  const connection: SqlConnection.Connection = {
    execute: unexpected,
    executeRaw: unexpected,
    executeStream: () => Stream.die(new Error("unexpected SQL stream")),
    executeUnprepared: unexpected,
    executeValues: (sql, params) =>
      Effect.sync(() => {
        statements.push({ sql, params });
        return rows;
      }),
    executeValuesUnprepared: unexpected,
  };
  const db = await Effect.runPromise(
    makeTestDatabaseClient(Effect.succeed(connection))
  );
  const exit = await Effect.runPromiseExit(
    removeSyntheticAccountLink(accountId, customerId).pipe(
      Effect.provideService(E2EDatabase, E2EDatabase.of({ db }))
    )
  );
  return { exit, statements };
};

describe("removeSyntheticAccountLink", () => {
  test("clears only the exact account link and preserves other synthetic records", async () => {
    const accountId = "account-target";
    const customerId = "customer-target";
    const { exit, statements } = await runRemoveSyntheticAccountLink(
      accountId,
      customerId,
      [[accountId]]
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(statements).toEqual([
      {
        sql: 'update "customer_accounts" set "dotypos_customer_id" = $1 where (("customer_accounts"."id" = $2) and ("customer_accounts"."dotypos_customer_id" = $3)) returning "id"',
        params: [null, accountId, customerId],
      },
    ]);
  });

  test.each([
    {
      name: "missing",
      returnedRows: [],
    },
    {
      name: "mismatched",
      returnedRows: [["account-other"]],
    },
  ])(
    "fails closed when the deleted link is $name",
    async ({ returnedRows }) => {
      const accountId = "account-target";
      const customerId = "customer-target";
      const { exit } = await runRemoveSyntheticAccountLink(
        accountId,
        customerId,
        returnedRows
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      const error = Cause.squash(exit.cause);
      expect(error).toMatchObject({
        diagnosticCode: "postgres_account_fixture_assertion_failed",
        message:
          "Synthetic account link cleanup did not remove exactly one matching row",
        operation: "delete synthetic account link",
      });
      expect(JSON.stringify(error)).not.toContain(accountId);
      expect(JSON.stringify(error)).not.toContain(customerId);
    }
  );
});
