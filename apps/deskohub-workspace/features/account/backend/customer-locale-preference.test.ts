import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Result, Stream } from "effect";
import { type SqlConnection, SqlError } from "effect/sql";
import { WorkspaceDatabase } from "@/db/database.service";
import type { Locale } from "@/features/i18n";
import { makeTestDatabaseClient } from "@/shared/testing/workspace-recording-database.test-utils";
import type {
  CustomerAccountAccessError,
  CustomerAccountId,
} from "../customer-account";
import {
  type CustomerAccountSectionsFixture,
  makeCustomerAccountSections,
  sectionAccountId,
} from "./customer-account-sections.test-utils";
import { saveAccountLocalePreference } from "./customer-locale-preference";
import { CustomerLocalePreference } from "./customer-locale-preference.service";

const save = async (
  fixture: CustomerAccountSectionsFixture,
  options: {
    readonly writeFails?: boolean;
    /** Saves through this instead of `saveAccountLocalePreference` itself. */
    readonly through?: (
      accountId: CustomerAccountId,
      locale: Locale
    ) => Effect.Effect<
      void,
      CustomerAccountAccessError,
      CustomerLocalePreference
    >;
  } = {}
) => {
  const sections = makeCustomerAccountSections(fixture);
  const writes: (readonly unknown[])[] = [];
  const execute = (_sql: string, params: readonly unknown[]) =>
    options.writeFails
      ? Effect.fail(
          new SqlError.SqlError({
            reason: new SqlError.ConnectionError({
              cause: new Error("write failed"),
              message: "write failed",
              operation: "execute",
            }),
          })
        )
      : Effect.sync(() => {
          sections.events.push("write");
          writes.push(params);
          return [];
        });
  const unexpected = Effect.die(new Error("Unexpected locale write query"));
  const connection: SqlConnection.Connection = {
    execute,
    executeUnprepared: execute,
    executeValues: execute,
    executeValuesUnprepared: execute,
    executeRaw: (sql, params) =>
      Effect.map(execute(sql, params), (rows) => ({
        command: "UPDATE",
        rowCount: 1,
        oid: 0,
        rows,
        fields: [],
      })),
    executeStream: () => Stream.fromEffect(unexpected),
  };
  const db = await Effect.runPromise(
    makeTestDatabaseClient(Effect.succeed(connection))
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(WorkspaceDatabase, WorkspaceDatabase.make(db)),
    sections.layer
  );
  const run = (
    options.through
      ? options
          .through(sectionAccountId, "en-US")
          .pipe(
            Effect.provide(
              CustomerLocalePreference.Default.pipe(Layer.provide(dependencies))
            )
          )
      : saveAccountLocalePreference(sectionAccountId, "en-US").pipe(
          Effect.provide(dependencies)
        )
  ).pipe(Effect.result, Effect.runPromise);
  return { run, writes, events: sections.events };
};

describe("saveAccountLocalePreference", () => {
  test("writes after rechecking the session under the account lock", async () => {
    const { run, writes, events } = await save({ session: {} });

    expect(Result.isSuccess(await run)).toBe(true);
    expect(writes).toEqual([
      expect.arrayContaining(["en-US", sectionAccountId]),
    ]);
    expect(events).toEqual([
      "account-lock-acquired",
      "account-session",
      "account-activity",
      "write",
      "account-lock-released",
    ]);
  });

  test("never writes for a session gone by the time the lock is held", async () => {
    const { run, writes } = await save({ session: null });

    const outcome = await run;
    expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
      "unauthenticated"
    );
    expect(writes).toEqual([]);
  });

  test("maps a lock failure to the account lock cause without writing", async () => {
    const { run, writes } = await save({ session: {}, lockUnavailable: true });

    const outcome = await run;
    expect(Result.isFailure(outcome) && outcome.failure.cause?.code).toBe(
      "account-link.lock"
    );
    expect(writes).toEqual([]);
  });

  test("maps a failed write to the locale preference write cause", async () => {
    const { run } = await save({ session: {} }, { writeFails: true });

    const outcome = await run;
    expect(Result.isFailure(outcome) && outcome.failure.cause?.code).toBe(
      "account-locale-preference.write"
    );
  });
});
describe("CustomerLocalePreference", () => {
  const saveThroughService = (fixture: CustomerAccountSectionsFixture) =>
    save(fixture, {
      through: (accountId, locale) =>
        Effect.flatMap(CustomerLocalePreference, (preference) =>
          preference.save(accountId, locale)
        ),
    });

  test("saves through the account's section", async () => {
    const { run, writes } = await saveThroughService({ session: {} });

    expect(Result.isSuccess(await run)).toBe(true);
    expect(writes).toEqual([
      expect.arrayContaining(["en-US", sectionAccountId]),
    ]);
  });

  test("refuses a deletion-marked account without writing", async () => {
    const { run, writes } = await saveThroughService({
      session: {},
      activityState: "deletion-requested",
    });

    const outcome = await run;
    expect(Result.isFailure(outcome) && outcome.failure).toMatchObject({
      reason: "link-required",
      linkReason: "deletion-requested",
    });
    expect(writes).toEqual([]);
  });
});
