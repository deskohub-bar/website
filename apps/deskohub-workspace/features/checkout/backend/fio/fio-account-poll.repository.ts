import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import { fioAccountPolls } from "@/db/schema/fio-account-polls";
import type { DatabaseQueryError } from "@/db/sql-constraint";

type AccountPoll = typeof fioAccountPolls.$inferSelect;
type AccountPollChanges = Partial<
  Omit<AccountPoll, "accountKey" | "firstDemandDate">
>;
type WithPollTransaction<A> = Effect.Effect<
  A,
  DatabaseQueryError,
  WorkspaceTransaction
>;

interface IFioAccountPollRepository {
  readonly initialize: (accountKey: string) => WithPollTransaction<boolean>;
  readonly lock: (
    accountKey: string
  ) => WithPollTransaction<AccountPoll | undefined>;
  readonly lockDelivery: (
    accountKey: string
  ) => WithPollTransaction<AccountPoll | undefined>;
  readonly currentTime: (
    accountKey: string
  ) => WithPollTransaction<Temporal.Instant>;
  readonly update: (
    accountKey: string,
    changes: AccountPollChanges
  ) => WithPollTransaction<void>;
}

const initialize = Effect.fn("FioAccountPollRepository.initialize")(function* (
  accountKey: string
) {
  const { db } = yield* WorkspaceTransaction;
  const [inserted] = yield* db
    .insert(fioAccountPolls)
    .values({
      accountKey,
      firstDemandDate: sql`(clock_timestamp() at time zone 'Europe/Prague')::date`,
    })
    .onConflictDoNothing()
    .returning({ accountKey: fioAccountPolls.accountKey });
  return inserted !== undefined;
});

const lock = Effect.fn("FioAccountPollRepository.lock")(function* (
  accountKey: string
) {
  const { db } = yield* WorkspaceTransaction;
  const [poll] = yield* db
    .select()
    .from(fioAccountPolls)
    .where(eq(fioAccountPolls.accountKey, accountKey))
    .for("update");
  return poll;
});

export class FioAccountPollRepository extends Context.Service<
  FioAccountPollRepository,
  IFioAccountPollRepository
>()("FioAccountPollRepository") {
  static Default = Layer.succeed(this, {
    initialize,
    lock,
    lockDelivery: Effect.fn("FioAccountPollRepository.lockDelivery")(
      function* (accountKey) {
        const poll = yield* lock(accountKey);
        if (poll) return poll;

        // A freshly queued job can arrive while the account's first insert is
        // uncommitted. A unique-key conflict waits for that transaction to end.
        if (!(yield* initialize(accountKey))) return yield* lock(accountKey);

        // The wake rolled back or never existed. Remove the row this job inserted.
        const { db } = yield* WorkspaceTransaction;
        yield* db
          .delete(fioAccountPolls)
          .where(eq(fioAccountPolls.accountKey, accountKey));
        return undefined;
      }
    ),
    currentTime: Effect.fn("FioAccountPollRepository.currentTime")(
      function* (accountKey) {
        const { db } = yield* WorkspaceTransaction;
        // Read the database clock after taking the row lock. Lock waits can span a poll cadence.
        const [row] = yield* db
          .select({
            epochMilliseconds: sql<number>`floor(extract(epoch from clock_timestamp()) * 1000)::double precision`,
          })
          .from(fioAccountPolls)
          .where(eq(fioAccountPolls.accountKey, accountKey));
        if (!row)
          return yield* Effect.die("Locked Fio account poll is missing");
        return Temporal.Instant.fromEpochMilliseconds(row.epochMilliseconds);
      }
    ),
    update: Effect.fn("FioAccountPollRepository.update")(
      function* (accountKey, changes) {
        const { db } = yield* WorkspaceTransaction;
        yield* db
          .update(fioAccountPolls)
          .set(changes)
          .where(eq(fioAccountPolls.accountKey, accountKey));
      }
    ),
  });
}
