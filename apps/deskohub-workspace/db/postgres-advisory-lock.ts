import { sql } from "drizzle-orm";
import { Context, Effect, Layer, Scope, Semaphore } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import type { DatabasePool } from "./database-client";
import { boundStatement, statementTimeoutOf } from "./statement-timeout";

export type PostgresAdvisoryLockKey = readonly [string, string];

/**
 * Where a lock section gets its dedicated connection: `SqlClient.reserve`,
 * which pins one pooled connection to the section's scope.
 */
export type PostgresAdvisoryLockConnections = Pick<SqlClient.Base, "reserve">;

/**
 * Takes a transaction-scoped advisory lock inside the caller's own
 * transaction; the lock releases when that transaction ends.
 */
export const postgresAdvisoryTransactionLockStatement = (
  key: PostgresAdvisoryLockKey
) => {
  const [namespace, lockKey] = key;
  return sql`select pg_advisory_xact_lock(hashtext(${namespace}), hashtext(${lockKey}))`;
};

const beginSql = "begin";
const lockSql = "select pg_advisory_xact_lock(hashtext($1), hashtext($2))";
const rollbackSql = "rollback";
const lockSavepointSql = "savepoint workspace_advisory_locks";
const rollbackLockSavepointSql =
  "rollback to savepoint workspace_advisory_locks";
const releaseLockSavepointSql = "release savepoint workspace_advisory_locks";

type LockStatement = (
  statement: string,
  params?: ReadonlyArray<unknown>
) => Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>;

const makeLockFrame = (
  client: PostgresAdvisoryLockConnections,
  run: LockStatement,
  health: { failure: SqlError.SqlError | undefined } = { failure: undefined }
) => ({ client, run, health, open: true, children: Semaphore.makeUnsafe(1) });

type LockFrame = ReturnType<typeof makeLockFrame>;

const checkLockFrame = ({ health }: LockFrame) => health.failure ?? Effect.void;

const CurrentLockFrame = Context.Reference<LockFrame | undefined>(
  "@deskohub-workspace/db/CurrentAdvisoryLockFrame",
  { defaultValue: () => undefined }
);

const closeLockFrame = (frame: LockFrame, cleanup: Effect.Effect<unknown>) =>
  Effect.sync(() => {
    frame.open = false;
  }).pipe(Effect.andThen(frame.children.withPermits(1)(cleanup)));

const takeLocks = (
  run: LockStatement,
  keys: readonly PostgresAdvisoryLockKey[]
) => Effect.forEach(keys, (key) => run(lockSql, key), { discard: true });

const withNestedLocks = <A, E, R>(
  parent: LockFrame,
  keys: readonly PostgresAdvisoryLockKey[],
  effect: Effect.Effect<A, E, R>
) =>
  parent.children.withPermits(1)(
    Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        if (!parent.open) {
          return yield* Effect.die(
            new Error("The enclosing advisory lock section has closed")
          );
        }
        yield* checkLockFrame(parent);

        const { run } = parent;
        const markFailed = (failure: SqlError.SqlError) =>
          Effect.sync(() => {
            parent.health.failure = failure;
          });
        yield* run(lockSavepointSql).pipe(Effect.tapError(markFailed));

        const frame = makeLockFrame(parent.client, run, parent.health);
        const cleanup = closeLockFrame(
          frame,
          run(rollbackLockSavepointSql).pipe(
            Effect.andThen(run(releaseLockSavepointSql)),
            Effect.tapError(markFailed),
            Effect.orDie
          )
        );
        // Siblings serialize their entire scope. A child has its own gate,
        // so a higher-ranked descendant can enter before its parent exits.
        return yield* restore(
          takeLocks(run, keys).pipe(
            Effect.andThen(
              Effect.provideService(effect, CurrentLockFrame, frame)
            )
          )
        ).pipe(
          Effect.ensuring(cleanup),
          Effect.tap(() => checkLockFrame(frame))
        );
      })
    )
  );

/**
 * Opens the section's transaction and takes its locks on a reserved
 * connection, and rolls it back when the scope closes. The driver retires a
 * reserved connection that it gets back in a failed transaction, with a
 * statement still in flight, or dead, but not one with its transaction still
 * open, so the rollback is registered before BEGIN: an interrupted BEGIN can
 * still finish while the driver drains it. A rollback without a transaction
 * only draws a warning. No lock outlives the scope.
 */
const holdTransactionLocks = Effect.fnUntraced(function* (
  connections: PostgresAdvisoryLockConnections,
  keys: readonly PostgresAdvisoryLockKey[]
) {
  const connection = yield* connections.reserve;
  const bounded = boundStatement(statementTimeoutOf(connections));
  const run = (statement: string, params: ReadonlyArray<unknown> = []) =>
    bounded(connection.executeUnprepared(statement, params, undefined));
  const frame = makeLockFrame(connections, run);
  yield* Effect.addFinalizer(() =>
    closeLockFrame(frame, Effect.ignore(run(rollbackSql)))
  );
  yield* run(beginSql);
  yield* takeLocks(run, keys);
  return frame;
});

/**
 * Holds a transaction-scoped PostgreSQL advisory lock inside one explicit
 * write-free transaction on one dedicated pool connection while `effect`
 * runs. The open transaction pins the pooled server session to this
 * connection, so the lock serializes a durable marker write and a provider
 * call together, and the rollback always ends the transaction, which releases
 * the lock.
 */
export const withPostgresAdvisoryLock = <A, E, R>(
  connections: PostgresAdvisoryLockConnections,
  key: PostgresAdvisoryLockKey,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError.SqlError, R> =>
  withPostgresAdvisoryLocks(connections, [key], effect);

/**
 * Acquires multiple transaction-scoped advisory locks on one pinned
 * connection and under one pool permit. Callers provide a deterministic
 * global order.
 */
export const withPostgresAdvisoryLocks = <A, E, R>(
  connections: PostgresAdvisoryLockConnections,
  keys: readonly PostgresAdvisoryLockKey[],
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError.SqlError, R> =>
  // A scope of its own rather than `Effect.scoped`, which would also hand it
  // to an `effect` that needs a scope. Waiting for the connection and the
  // locks stays interruptible; the scope closes on every exit.
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Scope.make(), (scope) =>
      restore(
        Scope.provide(holdTransactionLocks(connections, keys), scope)
      ).pipe(
        Effect.flatMap((frame) =>
          restore(effect).pipe(
            Effect.provideService(CurrentLockFrame, frame),
            Effect.map((value) => ({ frame, value }))
          )
        ),
        Effect.onExit((exit) => Scope.close(scope, exit)),
        // Closing drains child savepoints. A child can report a cleanup
        // failure during that drain, after the guarded effect has returned.
        Effect.flatMap(({ frame, value }) =>
          checkLockFrame(frame).pipe(Effect.as(value))
        )
      )
    )
  );

const advisoryLockSemaphores = new WeakMap<object, Semaphore.Semaphore>();
const advisoryLockPoolCapacityError = new SqlError.SqlError({
  reason: new SqlError.UnknownError({
    cause: new Error(
      "Postgres advisory lock pool requires at least two connections"
    ),
    message: "Postgres advisory lock pool capacity is too small",
    operation: "withLock",
  }),
});

/**
 * One semaphore per client, so every layer over the same pool shares it:
 * sections never hold more than half of the pool's connections, which leaves
 * the rest for the queries they wait on.
 */
const makeAdvisoryLockSemaphore = (
  client: PostgresAdvisoryLockConnections,
  maxConnections: number
) => {
  if (maxConnections < 2) return undefined;

  const existing = advisoryLockSemaphores.get(client);
  if (existing) return existing;

  const semaphore = Semaphore.makeUnsafe(Math.floor(maxConnections / 2));
  advisoryLockSemaphores.set(client, semaphore);
  return semaphore;
};

interface IWorkspaceDatabaseAdvisoryLock {
  /**
   * Reserves the shared advisory-lock pool permit around work that performs
   * its advisory locking and local queries inside one database transaction.
   * The effect must open that transaction only after this permit is acquired.
   */
  readonly withTransactionPermit: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  readonly withLock: <A, E, R>(
    key: PostgresAdvisoryLockKey,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  readonly withLocks: <A, E, R>(
    keys: readonly PostgresAdvisoryLockKey[],
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
}

export class WorkspaceDatabaseAdvisoryLock extends Context.Service<
  WorkspaceDatabaseAdvisoryLock,
  IWorkspaceDatabaseAdvisoryLock
>()("@deskohub-workspace/db/WorkspaceDatabaseAdvisoryLock") {
  /**
   * Over `client`, whose pool opens at most `maxConnections` connections.
   */
  static make = ({
    client,
    maxConnections,
  }: {
    readonly client: PostgresAdvisoryLockConnections;
    readonly maxConnections: number;
  }): IWorkspaceDatabaseAdvisoryLock => {
    const semaphore = makeAdvisoryLockSemaphore(client, maxConnections);

    const withLocks = <A, E, R>(
      keys: readonly PostgresAdvisoryLockKey[],
      effect: Effect.Effect<A, E, R>
    ) =>
      Effect.flatMap(CurrentLockFrame, (frame) => {
        if (frame?.client === client)
          return withNestedLocks(frame, keys, effect);
        if (semaphore === undefined)
          return Effect.fail(advisoryLockPoolCapacityError);
        return semaphore.withPermits(1)(
          withPostgresAdvisoryLocks(client, keys, effect)
        );
      });

    return WorkspaceDatabaseAdvisoryLock.of({
      withTransactionPermit: (effect) => {
        if (semaphore === undefined) {
          return Effect.fail(advisoryLockPoolCapacityError);
        }

        return semaphore.withPermits(1)(effect);
      },
      withLock: (key, effect) => withLocks([key], effect),
      withLocks,
    });
  };

  /** Over a pool its owner opened, such as a test database's. */
  static makeLayer = (pool: DatabasePool) =>
    Layer.succeed(
      WorkspaceDatabaseAdvisoryLock,
      WorkspaceDatabaseAdvisoryLock.make({
        client: Context.get(pool.postgres, SqlClient.SqlClient),
        maxConnections: pool.maxConnections,
      })
    );

  static Default = Layer.unwrap(
    Effect.promise(async () => {
      const { workspaceDatabaseAdvisoryLockLayer } = await import(
        "./database-provider.server"
      );
      return workspaceDatabaseAdvisoryLockLayer;
    })
  );
}
