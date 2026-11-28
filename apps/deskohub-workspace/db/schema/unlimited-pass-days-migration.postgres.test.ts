import "@/shared/testing/workspace-test-env";

import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { makeDatabasePool } from "@/db/database-client";
import { createScratchPostgresDatabase } from "@/shared/testing/postgres-scratch-database.test-utils";
import {
  linkMigrationsBefore,
  workspaceMigrationsFolder,
} from "../migration-scratch-database.test-utils";

const migration = "20261121023644_unlimited_pass_purchase";
const testDatabaseUrl = process.env.WORKSPACE_TEST_DATABASE_URL;

test.skipIf(!testDatabaseUrl)(
  "Unlimited pass days share one order and ordinary reservation writers still get a mirror",
  async () => {
    if (!testDatabaseUrl) return;

    const earlierMigrations = await linkMigrationsBefore(migration);
    const scratch = await createScratchPostgresDatabase(
      testDatabaseUrl,
      "unlimited_pass_days"
    );
    const pool = makeDatabasePool({ connectionString: scratch.url, max: 1 });
    try {
      const db = drizzle({ client: pool });
      await migrate(db, { migrationsFolder: earlierMigrations });
      const buyerId = crypto.randomUUID();
      const passId = crypto.randomUUID();
      const ordinaryId = crypto.randomUUID();
      const insertOrdinary = (id: string) =>
        pool.query(
          `insert into workspace_reservations
           (id, checkout_attempt_key, dotypos_customer_id, author_account_id,
            reservation_state, payment_state, fulfillment_state,
            reservation_details, locale)
         values ($1, $1, '1', $2, 'draft', 'not_started', 'not_started', '{}', 'en-US')`,
          [id, buyerId]
        );
      await pool.query("insert into customer_accounts (id) values ($1)", [
        buyerId,
      ]);
      await insertOrdinary(ordinaryId);
      await migrate(db, { migrationsFolder: workspaceMigrationsFolder });
      const nextOrdinaryId = crypto.randomUUID();
      await insertOrdinary(nextOrdinaryId);
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
          '2027-03-16', '2027-04-15', '{}', 'en-US', now())`,
        [passId, buyerId]
      );
      await pool.query(
        `insert into workspace_reservations
         (checkout_attempt_key, dotypos_customer_id, author_account_id,
          reservation_state, payment_state, fulfillment_state, reservation_details,
          locale, pass_id, service_date, pass_day_table_id)
       select uuid_generate_v7(), '1', $2, 'creating_hold', 'not_started',
          'not_started', '{}', 'en-US', $1, date '2027-03-16' + day, '9'
       from generate_series(0, 29) day`,
        [passId, buyerId]
      );
      await pool.query(
        "update workspace_reservations set payment_state = 'pending' where id = $1 or pass_id = $2",
        [nextOrdinaryId, passId]
      );
      const days = await pool.query(
        "select count(*)::int as count from workspace_reservations where pass_id = $1",
        [passId]
      );
      expect(days.rows).toEqual([{ count: 30 }]);
      const orders = await pool.query(
        "select id, kind, payment_state from orders"
      );
      expect(orders.rows).toHaveLength(3);
      expect(orders.rows).toEqual(
        expect.arrayContaining([
          { id: ordinaryId, kind: "reservation", payment_state: "not_started" },
          { id: nextOrdinaryId, kind: "reservation", payment_state: "pending" },
          { id: passId, kind: "pass-purchase", payment_state: "not_started" },
        ])
      );
    } finally {
      await pool.end();
      await scratch.drop();
      await rm(earlierMigrations, { recursive: true, force: true });
    }
  }
);
