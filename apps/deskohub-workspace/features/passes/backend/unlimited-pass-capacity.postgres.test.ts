import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { expect, test } from "bun:test";
import { DotyposService, DotyposTableSchema } from "@deskohub/dotypos";
import { Deferred, Effect, Layer, Schema } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { withWorkspaceReservationCapacity } from "@/features/checkout/backend/reservation/dotypos-reservation.adapter";
import { WorkspaceTableAssignmentService } from "@/features/checkout/backend/reservation/workspace-table-assignment.service";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { waitForAdvisoryLockWaiter } from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { withUnlimitedPassCapacity } from "./unlimited-pass-capacity";

test.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "a same-date ordinary booking waits for the Unlimited intent and sees it before Dotypos does",
  async () => {
    const database = (await createWorkspacePostgresSuiteDatabase(
      "unlimited_capacity"
    ))!;
    const { pool } = database;
    const buyerId = crypto.randomUUID();
    const passId = crypto.randomUUID();
    const date = "2099-03-29";
    const startDate = Temporal.PlainDate.from(date);
    const table = Schema.decodeSync(DotyposTableSchema)({
      _cloudId: "1",
      id: "9",
      display: true,
      enabled: true,
      name: "Reserved desk",
      seats: "1",
      tags: ["cowork:reserved-desk"],
    });
    const services = Layer.mergeAll(
      WorkspaceReservationRepository.Default.pipe(
        Layer.provide(database.layer)
      ),
      WorkspaceDatabaseAdvisoryLock.makeLayer(database.databasePool),
      Layer.mock(DotyposService, {
        getTables: () => Effect.succeed([table]),
        listActiveReservationsOverlapping: () => Effect.succeed([]),
      }),
      Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
        listLimitations: () => Effect.succeed([]),
      })
    );

    const started = Deferred.makeUnsafe<void>();
    const commit = Deferred.makeUnsafe<void>();
    try {
      await pool.query("insert into customer_accounts (id) values ($1)", [
        buyerId,
      ]);
      await pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state)
         values ($1, 'pass-purchase', '1', 'not_started', 'not_started')`,
        [passId]
      );
      await pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, status,
           valid_from, valid_until, quote, locale, created_at)
         values ($1, $2, $2, 'unlimited', 'reserved-desk', 'pending_payment',
           $3::date, $3::date + 30, '{}', 'en-US', now())`,
        [passId, buyerId, date]
      );
      const pass = withUnlimitedPassCapacity(
        { startDate, selection: { tier: "reserved-desk" } },
        (plan) =>
          Effect.gen(function* () {
            expect(plan.days).toHaveLength(30);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(commit);
            yield* Effect.promise(() =>
              pool.query(
                `insert into workspace_reservations
              (checkout_attempt_key, dotypos_customer_id, author_account_id,
               reservation_state, payment_state, fulfillment_state, reservation_details,
               locale, pass_id, service_date, pass_day_table_id)
             select uuid_generate_v7(), '1', $2, 'creating_hold', 'not_started',
               'not_started', '{}', 'en-US', $1, $3::date + day, $4
             from generate_series(0, 29) day`,
                [passId, buyerId, date, plan.days[0]!.tableId]
              )
            );
          })
      ).pipe(Effect.provide(services), Effect.runPromise);
      await Effect.runPromise(
        Deferred.await(started).pipe(Effect.timeout("5 seconds"))
      );

      const interval = getCoworkReservationInterval("reserved-desk", date);
      const ordinary = withWorkspaceReservationCapacity(
        interval,
        Effect.flatMap(WorkspaceTableAssignmentService, (assignment) =>
          assignment.assignTableId({
            kind: "cowork",
            entryTier: "reserved-desk",
            date,
            coffee: true,
          })
        )
      ).pipe(
        Effect.flip,
        Effect.provide(WorkspaceTableAssignmentService.Default),
        Effect.provide(services),
        Effect.runPromise
      );
      try {
        await waitForAdvisoryLockWaiter(pool, ["reservation-capacity", date]);
      } finally {
        await Effect.runPromise(Deferred.succeed(commit, undefined));
        await pass;
      }
      expect(await ordinary).toMatchObject({
        _tag: "TableAssignmentUnavailableError",
      });
    } finally {
      await Effect.runPromise(Deferred.succeed(commit, undefined));
      await database.close();
    }
  }
);
