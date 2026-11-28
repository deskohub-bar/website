import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { SqlClient, type SqlConnection, SqlError } from "effect/sql";
import { WorkspaceDatabase } from "@/db/database.service";
import { databaseClient, type RootDatabaseClient } from "@/db/database-client";

interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface RecordingWorkspaceDatabase {
  readonly db: RootDatabaseClient;
  readonly statements: readonly RecordedStatement[];
  readonly layer: Layer.Layer<WorkspaceDatabase>;
  /** Queues one canned result per upcoming statement; the last entry repeats. */
  readonly setRows: (rows: (readonly unknown[])[]) => void;
  readonly failNextQueriesWith: (cause: unknown, count: number) => void;
}

/**
 * The real Workspace Drizzle client over the SQL connection a test's
 * `acquirer` supplies, without a Postgres server. An acquirer that dies makes
 * every statement and transaction die when it runs.
 */
export const makeTestDatabaseClient = Effect.fn("makeTestDatabaseClient")(
  function* (acquirer: SqlClient.SqlClient.MakeOptions["acquirer"]) {
    const client = yield* SqlClient.make({
      acquirer,
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
      driver: "pg",
    }).pipe(Effect.provide(Reactivity.layer));
    // Drizzle's Postgres session uses only the SQL client part of PgClient;
    // the rest refuses use.
    const unused = Effect.die(
      new Error("The test database has no Postgres extras")
    );
    const pgClient: PgClient.PgClient = Object.assign(client, {
      [PgClient.TypeId]: PgClient.TypeId,
      config: {},
      json: () => {
        throw new Error("The test database has no Postgres extras");
      },
      listen: () => unused,
      notify: () => unused,
      poolStats: Effect.succeed({
        idle: 0,
        used: 0,
        pending: 0,
        min: 0,
        max: 0,
      }),
    });
    return yield* Effect.provideService(
      databaseClient,
      PgClient.PgClient,
      pgClient
    );
  }
);

/**
 * Builds the real workspace drizzle client over a recording SQL connection so
 * tests execute the actual query-builder layer and assert on the compiled SQL
 * and bound parameters without needing a live Postgres server. Every
 * statement answers with the next canned rows, in whatever row shape Drizzle
 * asks for.
 */
export const makeRecordingWorkspaceDatabase =
  async (): Promise<RecordingWorkspaceDatabase> => {
    const statements: RecordedStatement[] = [];
    let rowsQueue: (readonly unknown[])[] = [];
    let failures: { readonly cause: unknown; remaining: number } | undefined;

    const nextRows = (): readonly unknown[] =>
      rowsQueue.length > 1 ? (rowsQueue.shift() ?? []) : (rowsQueue[0] ?? []);

    const transactionControlPattern = /^(begin|commit|rollback)\b/i;

    const runStatement = (text: string, values: readonly unknown[]) =>
      Effect.suspend(() => {
        if (failures && failures.remaining > 0) {
          failures.remaining -= 1;
          return Effect.fail(
            new SqlError.SqlError({
              reason: new SqlError.UnknownError({ cause: failures.cause }),
            })
          );
        }
        const rows = transactionControlPattern.test(text) ? [] : nextRows();
        statements.push({ sql: text, params: values });
        return Effect.succeed([...rows]);
      });

    // Drizzle reads array-mode results through the value executors, so their
    // canned rows must be value tuples.
    const runValueStatement = (text: string, values: readonly unknown[]) =>
      Effect.flatMap(runStatement(text, values), (rows) =>
        rows.every(Array.isArray)
          ? Effect.succeed(rows)
          : Effect.die(
              new Error(`Canned rows for ${text} are not value tuples`)
            )
      );

    const connection: SqlConnection.Connection = {
      execute: runStatement,
      executeUnprepared: runStatement,
      executeValues: (text, values) => runValueStatement(text, values),
      executeValuesUnprepared: (text, values) =>
        runValueStatement(text, values),
      executeRaw: (text, values) =>
        Effect.map(runStatement(text, values), (rows) => ({
          command: "",
          rowCount: rows.length,
          oid: 0,
          rows,
          fields: [],
        })),
      executeStream: () =>
        Stream.die(new Error("The recording database does not stream")),
    };

    const db = await Effect.runPromise(
      makeTestDatabaseClient(Effect.succeed(connection))
    );

    return {
      db,
      statements,
      layer: Layer.succeed(WorkspaceDatabase, WorkspaceDatabase.make(db)),
      setRows: (next) => {
        rowsQueue = next;
      },
      failNextQueriesWith: (cause, count) => {
        failures = { cause, remaining: count };
      },
    };
  };
