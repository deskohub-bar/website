import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import {
  PaidFulfillmentQueueError,
  PaidFulfillmentQueueService,
} from "@/features/checkout/backend/fulfillment/paid-fulfillment-queue.service";
import { FioPaymentSettlementService } from "@/features/checkout/backend/payment/fio-payment-settlement.service";
import { LatePaymentRecoveryQueueService } from "@/features/checkout/backend/payment/late-payment-recovery-queue.service";
import { FioPaymentSettlementRepository } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";
import { PaymentLifecycleRepository } from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import { QrPaymentRepository } from "@/features/checkout/backend/repositories/qr-payment.repository";
import { reservationOrderId } from "@/features/reservation/persistence-contracts";
import { makeMemoryQueue } from "@/shared/backend/queue/memory-queue.test-utils";
import {
  QueueMessageSendError,
  QueuePublisher,
} from "@/shared/backend/queue/queue-publisher";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { waitForPostgresLockWaiter } from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { FioAccountPollRepository } from "./fio-account-poll.repository";
import { FioAccountPoller } from "./fio-account-poller.service";
import { FioAccounts } from "./fio-accounts.service";
import {
  type FioMovement,
  FioMovements,
  type FioPeriod,
  type FioReadFailure,
} from "./fio-movements.service";
import { type FioPollJob, FioPollWake } from "./fio-poll-wake.service";

const database = await createWorkspacePostgresSuiteDatabase("fio_account_poll");
afterAll(() => database?.close());

const oldDate = "2025-01-01";

const createHarness = () => {
  const { layer: db, pool } = database!;
  const accountKey = randomBytes(32).toString("hex");
  const account = { accountNumber: "1234567890", bankCode: "2010" };
  const readToken = Redacted.make("synthetic-fio-poll-token");
  const queue = makeMemoryQueue();
  const dispatchQueue = makeMemoryQueue();
  let failDispatch = false;
  const dispatchPublisher = Layer.effect(
    QueuePublisher,
    Effect.map(QueuePublisher, (publisher) => ({
      publish: (message) =>
        failDispatch
          ? Effect.fail(new QueueMessageSendError({ topic: message.topic }))
          : publisher.publish(message),
    }))
  ).pipe(Layer.provide(dispatchQueue.layer));
  const reads: Array<Pick<FioPeriod, "from" | "to">> = [];
  let readPeriod: FioMovements["Service"]["readPeriod"] = () =>
    Effect.succeed([]);
  let stopAtMovementId: string | undefined;
  let beforeReplay: (() => Promise<void>) | undefined;
  let configured = true;
  const accounts = Layer.mock(FioAccounts, {
    getReceivingAccount: (key) =>
      key === accountKey && configured
        ? { accountKey, account, readToken }
        : undefined,
  });
  const attempts = QrPaymentRepository.Default.pipe(Layer.provide(db));
  const settlements = FioPaymentSettlementService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        db,
        accounts,
        attempts,
        FioPaymentSettlementRepository.Default.pipe(Layer.provide(db)),
        PaymentLifecycleRepository.Default.pipe(
          Layer.provide(
            Layer.merge(db, Layer.mock(AccountingDocumentSnapshots, {}))
          )
        ),
        PaidFulfillmentQueueService.Default.pipe(
          Layer.provide(dispatchPublisher)
        ),
        LatePaymentRecoveryQueueService.Default.pipe(
          Layer.provide(dispatchPublisher)
        )
      )
    )
  );
  const ingress = Layer.effect(
    FioPaymentSettlementService,
    Effect.map(FioPaymentSettlementService, (service) => ({
      ...service,
      retryPendingDispatch: (key) =>
        Effect.gen(function* () {
          if (beforeReplay) yield* Effect.promise(beforeReplay);
          yield* service.retryPendingDispatch(key);
        }),
      recordMovement: (movement) =>
        movement.movementId === stopAtMovementId
          ? Effect.fail(
              new PaidFulfillmentQueueError({
                message: "synthetic ingress unavailable",
              })
            )
          : service.recordMovement(movement),
    }))
  ).pipe(Layer.provide(settlements));
  const polls = FioAccountPollRepository.Default;
  const worker = FioAccountPoller.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        db,
        polls,
        accounts,
        attempts,
        ingress,
        queue.layer,
        Layer.mock(FioMovements, {
          readPeriod: (period) => {
            reads.push({ from: period.from, to: period.to });
            return readPeriod(period);
          },
        })
      )
    )
  );
  const wake = FioPollWake.Default.pipe(
    Layer.provide(Layer.merge(polls, queue.layer))
  );

  const withDatabase = <A, E>(effect: Effect.Effect<A, E, WorkspaceDatabase>) =>
    Effect.runPromise(effect.pipe(Effect.provide(db)));
  const start = (
    input: {
      selectedCard?: boolean;
      beforeCommit?: () => Promise<void>;
      rollback?: boolean;
    } = {}
  ) =>
    withDatabase(
      Effect.gen(function* () {
        const { transaction } = yield* WorkspaceDatabase;
        return yield* transaction(
          Effect.gen(function* () {
            const { db } = yield* WorkspaceDatabase;
            const reservation = yield* workspaceFixtures(db).reservation({
              stage: { reservation: "held", payment: "pending" },
            });
            const orderId = reservationOrderId(reservation.id);
            const qrId = crypto.randomUUID();
            const cardId = crypto.randomUUID();
            const variableSymbol = yield* Effect.promise(async () => {
              const { rows } = await pool.query(
                "select nextval('qr_payment_references')::text as reference"
              );
              return rows[0]!.reference as string;
            });
            yield* db.execute(sql`insert into payment_attempts (id, order_id, workspace_reservation_id, provider, provider_order_id, state, amount_value, amount_exponent, currency) values
          (${qrId}, ${orderId}, ${reservation.id}, 'fio', ${variableSymbol}, 'pending', 12000, 2, 'CZK'),
          (${cardId}, ${orderId}, ${reservation.id}, 'nexi', ${cardId}, 'pending', 12000, 2, 'CZK')`);
            yield* db.execute(
              sql`update workspace_reservations set active_payment_attempt_id = ${input.selectedCard ? cardId : qrId} where id = ${reservation.id}`
            );
            yield* db.execute(sql`insert into reservation_payment_windows (order_id, account_key, expires_at, card_attempt_id, qr_attempt_id) values
          (${orderId}, ${accountKey}, clock_timestamp() + interval '30 minutes', ${cardId}, ${qrId})`);
            const service = yield* FioPollWake;
            yield* service.wake(accountKey);
            if (input.beforeCommit) yield* Effect.promise(input.beforeCommit);
            if (input.rollback) return yield* Effect.fail("synthetic rollback");
            return { orderId, variableSymbol };
          }).pipe(Effect.provide(wake))
        );
      })
    );

  return {
    queue,
    dispatchQueue,
    failDispatch: (fail: boolean) => {
      failDispatch = fail;
    },
    reads,
    start,
    consume: (job: FioPollJob) =>
      Effect.runPromise(
        Effect.flatMap(FioAccountPoller, (poller) => poller.consume(job)).pipe(
          Effect.provide(worker)
        )
      ),
    take: () => queue.take()!.message as FioPollJob,
    setRead: (read: typeof readPeriod) => {
      readPeriod = read;
    },
    failIngestionAt: (id: string | undefined) => {
      stopAtMovementId = id;
    },
    beforeReplay: (hook: () => Promise<void>) => {
      beforeReplay = hook;
    },
    unconfigure: () => {
      configured = false;
    },
    state: async () =>
      (
        await pool.query(
          "select covered_through::text, delivery_id, read_id, extract(epoch from read_not_before - clock_timestamp())::int as gate_seconds from fio_account_polls where account_key = $1",
          [accountKey]
        )
      ).rows[0],
    due: () =>
      pool.query(
        "update fio_account_polls set read_not_before = clock_timestamp() - interval '1 second' where account_key = $1",
        [accountKey]
      ),
    oldCheckpoint: () =>
      pool.query(
        "update fio_account_polls set first_demand_date = $2, covered_through = $2 where account_key = $1",
        [accountKey, oldDate]
      ),
    expire: (orderId: string) =>
      pool.query(
        "update reservation_payment_windows set expires_at = clock_timestamp() - interval '1 second' where order_id = $1",
        [orderId]
      ),
    evidence: () =>
      Effect.runPromise(
        Effect.flatMap(FioPaymentSettlementService, (service) =>
          service.listForAccount({ accountKey })
        ).pipe(Effect.provide(settlements))
      ),
  };
};

const credit = (
  movementId: string,
  bookingDate: string,
  value: string
): FioMovement => ({
  movementId,
  bookingDate,
  amount: { _tag: "CZK", minorUnits: 12000 },
  reference: { _tag: "VariableSymbol", value },
});

describe.skipIf(!database)("Fio polling against disposable Postgres", () => {
  test("retains new demand arriving while an idle delivery is preparing to deactivate", async () => {
    const h = createHarness();
    const old = await h.start();
    await h.expire(old.orderId);
    const job = h.take();
    const rechecking = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.beforeReplay(() => {
      rechecking.resolve();
      return release.promise;
    });
    const delivery = h.consume(job);
    await rechecking.promise;
    try {
      await h.start();
      expect(h.queue.published()).toHaveLength(1);
    } finally {
      release.resolve();
      await delivery;
    }
    expect(h.reads).toHaveLength(1);
    expect(h.queue.pending()).toHaveLength(1);
    expect(h.queue.pending()[0]?.options.delaySeconds).toBe(35);
  });

  test("records a whole response despite failed dispatch, then replays dispatch without bank reads when idle", async () => {
    const h = createHarness();
    const first = await h.start();
    const last = await h.start();
    const job = h.take();
    h.setRead(({ to }) =>
      Effect.succeed([
        credit("first-winner", to, first.variableSymbol),
        credit("last-winner", to, last.variableSymbol),
      ])
    );
    h.failDispatch(true);
    await expect(h.consume(job)).rejects.toMatchObject({
      _tag: "PaidFulfillmentQueueError",
    });
    expect((await h.state())?.delivery_id).toBe(job.deliveryId);
    expect((await h.state())?.covered_through).toBeNull();
    expect(h.reads).toHaveLength(1);
    const recorded = await h.evidence();
    expect(
      recorded.toSorted((a, b) => a.movementId.localeCompare(b.movementId))
    ).toMatchObject([
      { movementId: "first-winner", disposition: "winner" },
      { movementId: "last-winner", disposition: "winner" },
    ]);
    expect(recorded[0]?.observedAt).toEqual(recorded[1]?.observedAt);

    await expect(h.consume(job)).rejects.toMatchObject({
      _tag: "FioPollNotDue",
    });
    await h.due();
    await expect(h.consume(job)).rejects.toMatchObject({
      _tag: "PaidFulfillmentQueueError",
    });
    expect((await h.state())?.delivery_id).toBe(job.deliveryId);
    expect(h.reads).toHaveLength(1);
    h.failDispatch(false);
    await h.consume(job);
    await h.consume(job);
    expect(h.reads).toHaveLength(1);
    expect(h.queue.pending()).toEqual([]);
    expect(h.dispatchQueue.pending()).toHaveLength(2);
    expect(await h.evidence()).toEqual(recorded);
    expect((await h.state())?.delivery_id).toBeNull();
  });

  test("replays a failed dispatch before a due retry reads for newly payable demand", async () => {
    const h = createHarness();
    const old = await h.start();
    const job = h.take();
    h.setRead(({ to }) =>
      Effect.succeed([credit("winner", to, old.variableSymbol)])
    );
    h.failDispatch(true);
    await expect(h.consume(job)).rejects.toMatchObject({
      _tag: "PaidFulfillmentQueueError",
    });

    await h.start();
    await h.due();
    await expect(h.consume(job)).rejects.toMatchObject({
      _tag: "PaidFulfillmentQueueError",
    });
    expect(h.reads).toHaveLength(1);
    expect((await h.state())?.delivery_id).toBe(job.deliveryId);

    h.failDispatch(false);
    h.setRead(() => {
      expect(h.dispatchQueue.pending()).toHaveLength(1);
      return Effect.fail({
        _tag: "FioRejected",
        reason: "period-too-large",
      } as FioReadFailure);
    });
    await h.consume(job);
    expect(h.reads).toHaveLength(2);
    expect((await h.state())?.covered_through).toBeNull();
    expect((await h.state())?.delivery_id).toBeNull();
    expect(h.queue.pending()).toEqual([]);
  });

  test("an idle duplicate cannot retire a delivery while its bank read is in flight", async () => {
    const h = createHarness();
    const order = await h.start();
    const job = h.take();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.setRead(() =>
      Effect.gen(function* () {
        reading.resolve();
        yield* Effect.promise(() => release.promise);
        return [];
      })
    );
    const original = h.consume(job);
    await reading.promise;
    try {
      await h.expire(order.orderId);
      await expect(h.consume(job)).rejects.toMatchObject({
        _tag: "FioPollNotDue",
      });
      expect((await h.state())?.delivery_id).toBe(job.deliveryId);
      expect(h.reads).toHaveLength(1);
    } finally {
      release.resolve();
      await original;
    }
    expect((await h.state())?.delivery_id).toBeNull();
    expect(h.queue.pending()).toEqual([]);
  });

  test("one payable account sequence stays awake after selecting card and fences deliveries", async () => {
    const h = createHarness();
    const attempt = await h.start({ selectedCard: true });
    const job = h.take();
    const readStarted = Promise.withResolvers<void>();
    const allowRead = Promise.withResolvers<void>();
    h.setRead(({ to }) =>
      Effect.gen(function* () {
        readStarted.resolve();
        yield* Effect.promise(() => allowRead.promise);
        return [credit("winner", to, attempt.variableSymbol)];
      })
    );
    const delivery = h.consume(job);
    await readStarted.promise;
    try {
      await expect(h.consume(job)).rejects.toMatchObject({
        _tag: "FioPollNotDue",
      });
      expect((await h.state())?.gate_seconds).toBeGreaterThan(85);
      await h.start();
      expect(h.queue.published()).toHaveLength(1);
    } finally {
      allowRead.resolve();
      await delivery;
    }
    expect(h.queue.published()).toHaveLength(2);
    expect(h.queue.pending()[0]?.options.delaySeconds).toBe(35);
    await h.consume(job);
    expect(h.reads).toHaveLength(1);
    expect(await h.evidence()).toMatchObject([
      { movementId: "winner", disposition: "winner", orderId: attempt.orderId },
    ]);
    expect((await h.state())?.covered_through).toBe(h.reads[0]?.to);
  });

  test("idle polls do no work or follow-up; new demand replays old references and preserves exact coverage on failure", async () => {
    const h = createHarness();
    const old = await h.start();
    const idleJob = h.take();
    await h.oldCheckpoint();
    await h.expire(old.orderId);
    await h.consume(idleJob);
    expect(h.reads).toEqual([]);
    expect(h.queue.pending()).toEqual([]);
    expect((await h.state())?.delivery_id).toBeNull();

    await h.start();
    const job = h.take();
    h.setRead(() =>
      Effect.fail({ _tag: "FioHistoryAccessRequired" } as FioReadFailure)
    );
    await expect(h.consume(job)).rejects.toMatchObject({
      reason: "inaccessible_history",
    });
    expect((await h.state())?.covered_through).toBe(oldDate);
    expect(h.queue.pending()).toEqual([]);
    await expect(h.consume(job)).rejects.toMatchObject({
      _tag: "FioPollNotDue",
    });

    await h.due();
    h.setRead(({ to }) =>
      Effect.succeed([
        {
          ...credit("older-discrepancy", oldDate, old.variableSymbol),
          amount: {
            _tag: "OtherCurrency",
            currency: "EUR",
            decimalAmount: "12.2500",
          },
        },
        {
          ...credit("latest-discrepancy", to, "1000000000"),
          reference: { _tag: "Invalid" },
        },
      ])
    );
    h.failIngestionAt("latest-discrepancy");
    await expect(h.consume(job)).rejects.toMatchObject({
      _tag: "PaidFulfillmentQueueError",
    });
    expect((await h.state())?.covered_through).toBe(oldDate);
    const [first] = await h.evidence();
    expect(first).toMatchObject({
      movementId: "older-discrepancy",
      orderId: old.orderId,
      bookingDate: oldDate,
      decimalAmount: "12.2500",
    });

    h.failIngestionAt(undefined);
    await h.due();
    await h.consume(job);
    expect(h.reads.map(({ from }) => from)).toEqual([
      oldDate,
      oldDate,
      oldDate,
    ]);
    expect((await h.state())?.covered_through).toBe(h.reads.at(-1)?.to);
    expect(
      (await h.evidence()).find(
        ({ movementId }) => movementId === "older-discrepancy"
      )
    ).toEqual(first);
    expect(
      (await h.evidence()).map(({ movementId }) => movementId).sort()
    ).toEqual(["latest-discrepancy", "older-discrepancy"]);
  });

  test("an immediate first delivery waits and discards a rolled-back admission's job", async () => {
    const h = createHarness();
    const published = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admission = h.start({
      rollback: true,
      beforeCommit: () => {
        published.resolve();
        return release.promise;
      },
    });
    const rolledBack = admission.catch((error) => String(error));
    await published.promise;
    const stale = h.take();
    const delivery = h.consume(stale);
    try {
      await waitForPostgresLockWaiter(database!.pool, {
        condition: "locktype = 'transactionid'",
        description: "the poll to wait on uncommitted admission",
      });
      expect(h.reads).toEqual([]);
    } finally {
      release.resolve();
      expect(await rolledBack).toBe("synthetic rollback");
      await delivery;
    }
    expect(await h.state()).toBeUndefined();
    await h.start();
    const live = h.take();
    expect(live.deliveryId).not.toBe(stale.deliveryId);
    await h.consume(stale);
    h.unconfigure();
    await expect(h.consume(live)).rejects.toMatchObject({
      reason: "account_unconfigured",
    });
    expect((await h.state())?.covered_through).toBeNull();
    expect(h.reads).toEqual([]);
    expect(h.queue.pending()).toEqual([]);
  });

  test("shrinks oversized windows without advancing, then covers contiguous single Prague days", async () => {
    const h = createHarness();
    await h.start();
    await h.oldCheckpoint();

    const tooLarge = {
      _tag: "FioRejected",
      reason: "period-too-large",
    } as FioReadFailure;
    h.setRead(({ from, to }) =>
      from === to ? Effect.succeed([]) : Effect.fail(tooLarge)
    );
    for (const expectedDays of [15, 7, 3, 1]) {
      await h.due();
      await h.consume(h.take());
      expect((await h.state())?.covered_through).toBe(oldDate);
      expect(h.queue.pending()[0]?.message).toMatchObject({
        windowDays: expectedDays,
      });
    }

    await h.due();
    await h.consume(h.take());
    expect(h.reads.at(-1)).toEqual({ from: oldDate, to: oldDate });
    await h.due();
    await h.consume(h.take());
    expect(h.reads.at(-1)).toEqual({ from: "2025-01-02", to: "2025-01-02" });
    expect((await h.state())?.covered_through).toBe("2025-01-02");

    await h.due();
    h.setRead(() => Effect.fail(tooLarge));
    await h.consume(h.take());
    expect(h.reads.at(-1)).toEqual({ from: "2025-01-03", to: "2025-01-03" });
    expect((await h.state())?.covered_through).toBe("2025-01-02");
    expect((await h.state())?.delivery_id).toBeNull();
    expect(h.queue.pending()).toEqual([]);
  });
});
