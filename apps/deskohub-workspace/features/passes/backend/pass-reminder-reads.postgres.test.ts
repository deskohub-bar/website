import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposTableSchema } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  type CustomerAccountId,
  customerAccountIdSchema,
} from "@/features/account/customer-account";
import { type OrderId, orderIdSchema } from "@/features/order";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import {
  createWorkspacePostgresSuiteDatabase,
  requireTestDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { atInstant } from "@/shared/testing/workspace-test-clock.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import type { PassEntryClaimStatus } from "../pass";
import {
  type ListDuePassReminders,
  PassReminderReads,
  passReminderPageSize,
  type ReadDuePassReminder,
} from "./pass-reminder-reads.service";

const date = plainDateStringSchema.make;
const packDue = {
  kind: "entry-pack",
  dueDate: date("2027-01-07"),
  now: Temporal.Instant.from("2027-01-07T09:00:00Z"),
} as const;
const unlimitedDue = {
  kind: "unlimited",
  dueDate: date("2026-11-27"),
  now: Temporal.Instant.from("2026-11-27T09:00:00Z"),
} as const;

const table = Schema.decodeUnknownSync(DotyposTableSchema)({
  _cloudId: "1",
  id: "14",
  display: true,
  enabled: true,
  name: " Desk 14 ",
  seats: "1",
  tags: ["cowork:reserved-desk"],
});

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Pass reminder eligibility on disposable PostgreSQL",
  () => {
    let database: WorkspacePostgresSuiteDatabase;

    beforeAll(async () => {
      database = requireTestDatabase(
        await createWorkspacePostgresSuiteDatabase("pass_reminders")
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    const run = <A, E>(
      operation: Effect.Effect<A, E, PassReminderReads>,
      tables = Effect.succeed([table])
    ) =>
      Effect.runPromise(
        operation.pipe(
          Effect.provide(
            PassReminderReads.Default.pipe(
              Layer.provide(
                Layer.mergeAll(
                  database.layer,
                  Layer.mock(AdvisoryAvailabilityInventory, { tables })
                )
              )
            )
          )
        )
      );

    const seedAccount = async ({ verified = true, linked = true } = {}) => {
      const id = customerAccountIdSchema.make(crypto.randomUUID());
      await database.pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2)",
        [id, linked ? `customer-${id}` : null]
      );
      await database.pool.query(
        `insert into auth."user" (id, name, email, email_verified)
         values ($1, 'Synthetic holder', $2, $3)`,
        [id, testEmailAddress(`pass-reminder-${id}`), verified]
      );
      return id;
    };

    const seedPass = async ({
      holder,
      buyer = holder,
      kind = "entry-pack",
      tier = "open-space",
      validFrom = "2026-11-15",
      validUntil = "2027-01-15",
      gift = null,
      paid = false,
    }: {
      readonly holder: CustomerAccountId;
      readonly buyer?: CustomerAccountId;
      readonly kind?: "entry-pack" | "unlimited";
      readonly tier?: "open-space" | "reserved-desk";
      readonly validFrom?: string;
      readonly validUntil?: string;
      readonly gift?: "unclaimed" | "claimed" | null;
      readonly paid?: boolean;
    }) => {
      const id = orderIdSchema.make(crypto.randomUUID());
      await database.pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at, fulfilled_at)
         values ($1, 'pass-purchase', 'historical-billing-id', $2, 'fulfilled', case when $2 = 'paid' then now() end, now())`,
        [id, paid ? "paid" : "complimentary"]
      );
      await database.pool.query(
        `insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier,
           entry_count, unlimited_coffee, status, valid_from, valid_until, quote, locale,
           created_at, gift_issued_at, gift_claimed_at)
         values ($1, $2, $3, $4, $5, case when $4 = 'entry-pack' then 5 end,
           case when $4 = 'unlimited' and $5 = 'open-space' then false end, 'active',
           $6, $7, '{}', 'en-US', now(),
           case when $8::text is not null then now() end,
           case when $8 = 'claimed' then now() end)`,
        [id, buyer, holder, kind, tier, validFrom, validUntil, gift]
      );
      return id;
    };

    const seedClaim = async (
      passId: OrderId,
      holder: CustomerAccountId,
      claimStatus: PassEntryClaimStatus
    ) => {
      await database.pool.query(
        `with booking as (
           insert into workspace_reservations (checkout_attempt_key, dotypos_customer_id,
             dotypos_reservation_id, author_account_id, reservation_state, payment_state,
             fulfillment_state, reservation_details, locale, paid_at, fulfilled_at)
           values (uuid_generate_v7(), 'synthetic', uuid_generate_v7()::text, $2,
             'confirmed', 'paid', 'fulfilled', '{}', 'en-US', now(), now()) returning id
         )
         insert into pass_entry_claims (reservation_id, pass_id, date, status)
         select id, $1, '2027-01-08', $3 from booking`,
        [passId, holder, claimStatus]
      );
    };

    const seedDeskDays = (
      passId: OrderId,
      holder: CustomerAccountId,
      assignments: readonly (readonly [serviceDate: string, deskId: string])[]
    ) =>
      database.pool.query(
        `insert into workspace_reservations (checkout_attempt_key, pass_id, service_date,
           pass_day_table_id, dotypos_customer_id, author_account_id, dotypos_reservation_id,
           reservation_state, payment_state, fulfillment_state, paid_at, fulfilled_at,
           reservation_details, locale)
         select uuid_generate_v7(), $1, day, desk, 'synthetic', $2, uuid_generate_v7()::text,
           'confirmed', 'paid', 'fulfilled', now(), now(), '{}', 'en-US'
         from unnest($3::date[], $4::text[]) as days(day, desk)`,
        [
          passId,
          holder,
          assignments.map(([day]) => day),
          assignments.map(([, desk]) => desk),
        ]
      );

    const read = (
      input: ReadDuePassReminder,
      tables?: Effect.Effect<(typeof table)[]>
    ) =>
      run(
        atInstant(input.now)(
          Effect.flatMap(PassReminderReads, (reads) => reads.readDue(input))
        ),
        tables
      );

    test("rechecks reserved and consumed entries and permits delivery until Prague expiry", async () => {
      const holder = await seedAccount();
      const passId = await seedPass({ holder });
      await seedClaim(passId, holder, "consumed");
      await seedClaim(passId, holder, "reserved");
      await seedClaim(passId, holder, "released");
      const target = {
        ...packDue,
        passId,
        holderAccountId: holder,
        holderVersion: 0,
      };
      const beforeTen = {
        ...packDue,
        now: packDue.now.subtract({ milliseconds: 1 }),
      };
      const list = (input: ListDuePassReminders) =>
        run(Effect.flatMap(PassReminderReads, (reads) => reads.listDue(input)));

      expect(await list(beforeTen)).toEqual([]);
      expect(await list({ ...beforeTen, preview: true })).toMatchObject([
        { passId, entriesLeft: 3 },
      ]);
      expect(await read({ ...target, now: beforeTen.now })).toEqual(
        Option.none()
      );
      expect(Option.getOrThrow(await read(target))).toMatchObject({
        kind: "entry-pack",
        packSize: 5,
        entriesLeft: 3,
        lastUsableDate: "2027-01-14",
      });
      const late = Temporal.Instant.from("2027-01-14T22:59:59.999Z");
      expect(Option.isSome(await read({ ...target, now: late }))).toBe(true);
      expect(
        await read({ ...target, now: late.add({ milliseconds: 1 }) })
      ).toEqual(Option.none());

      for (let entries = 0; entries < 3; entries++) {
        await seedClaim(passId, holder, "reserved");
      }
      expect(await read(target)).toEqual(Option.none());
      expect(await list({ ...beforeTen, preview: true })).toEqual([]);
    });

    test("gift targeting follows the verified holder, current Dotypos link, version and pinned date", async () => {
      const buyer = await seedAccount();
      const holder = await seedAccount({ verified: false, linked: false });
      const passId = await seedPass({ buyer, holder, gift: "unclaimed" });
      const target = {
        ...packDue,
        passId,
        holderAccountId: holder,
        holderVersion: 0,
      };
      expect(await read(target)).toEqual(Option.none());

      await database.pool.query(
        'update auth."user" set email_verified = true where id = $1',
        [holder]
      );
      await database.pool.query(
        "update customer_accounts set dotypos_customer_id = 'linked-after-claim' where id = $1",
        [holder]
      );
      expect(await read(target)).toEqual(Option.none());

      await database.pool.query(
        "update pass_purchases set gift_claimed_at = now() where id = $1",
        [passId]
      );
      expect(Option.getOrThrow(await read(target))).toMatchObject({
        holderAccountId: holder,
        dotyposCustomerId: "linked-after-claim",
      });
      await database.pool.query(
        'update auth."user" set deletion_requested_at = now() where id = $1',
        [holder]
      );
      expect(await read(target)).toEqual(Option.none());

      const newHolder = await seedAccount();
      await database.pool.query(
        `update pass_purchases
         set holder_account_id = $2, holder_version = 1, gift_issued_at = now(), gift_claimed_at = null
         where id = $1`,
        [passId, newHolder]
      );
      expect(await read(target)).toEqual(Option.none());

      const newTarget = {
        ...target,
        holderAccountId: newHolder,
        holderVersion: 1,
      };
      expect(await read(newTarget)).toEqual(Option.none());
      await database.pool.query(
        "update pass_purchases set gift_claimed_at = now() where id = $1",
        [passId]
      );
      expect(await read({ ...newTarget, holderVersion: 0 })).toEqual(
        Option.none()
      );
      expect(Option.isSome(await read(newTarget))).toBe(true);
      await database.pool.query(
        "update pass_purchases set valid_until = valid_until + 1 where id = $1",
        [passId]
      );
      expect(await read(newTarget)).toEqual(Option.none());
    });

    test("Unlimited renewal uses the first assigned desk and stops for upcoming paid overlap", async () => {
      const holder = await seedAccount();
      const passId = await seedPass({
        holder,
        kind: "unlimited",
        tier: "reserved-desk",
        validFrom: "2026-11-03",
        validUntil: "2026-12-03",
      });
      await seedDeskDays(passId, holder, [
        ["2026-11-04", "15"],
        ["2026-11-03", "14"],
      ]);
      const target = {
        ...unlimitedDue,
        passId,
        holderAccountId: holder,
        holderVersion: 0,
      };
      const noTables = Effect.die(
        new Error("Desk label lookup must be opt-in")
      );
      const listed = await run(
        Effect.flatMap(PassReminderReads, (reads) =>
          reads.listDue(unlimitedDue)
        ),
        noTables
      );
      expect(listed.find((item) => item.passId === passId)).not.toHaveProperty(
        "deskLabel"
      );
      expect(
        Option.getOrThrow(await read(target, noTables))
      ).not.toHaveProperty("deskLabel");
      expect(
        Option.getOrThrow(await read({ ...target, includeDeskLabel: true }))
      ).toMatchObject({
        kind: "unlimited",
        lastUsableDate: "2026-12-02",
        nextPeriodStart: "2026-12-03",
        deskLabel: "Desk 14",
      });

      await seedPass({
        holder,
        kind: "unlimited",
        validFrom: "2026-12-07",
        validUntil: "2027-01-06",
        paid: true,
      });
      expect(await read(target)).toEqual(Option.none());
    });

    test("a submitted withdrawal suppresses delivery before cancellation settles", async () => {
      const holder = await seedAccount();
      const passId = await seedPass({
        holder,
        kind: "unlimited",
        validFrom: "2026-11-03",
        validUntil: "2026-12-03",
        paid: true,
      });
      const target = {
        ...unlimitedDue,
        passId,
        holderAccountId: holder,
        holderVersion: 0,
      };
      expect(Option.getOrThrow(await read(target))).toMatchObject({
        kind: "unlimited",
      });

      await database.pool.query(
        `insert into contract_withdrawals (contract_kind, contract_id, customer_account_id,
           locale, contract_label, submitted_at, period_ends_at, paid_amount_value,
           refund_amount_value, amount_exponent, currency)
         values ('unlimited-pass', $1, $2, 'en-US', 'Synthetic withdrawal', now(),
           now() + interval '1 day', 349000, 349000, 2, 'CZK')`,
        [passId, holder]
      );
      expect(await read(target)).toEqual(Option.none());
    });

    test("a pending admin change during the desk lookup invalidates delivery", async () => {
      const holder = await seedAccount();
      const passId = await seedPass({
        holder,
        kind: "unlimited",
        tier: "reserved-desk",
        validFrom: "2026-11-03",
        validUntil: "2026-12-03",
      });
      await seedDeskDays(passId, holder, [["2026-11-03", "14"]]);
      const tables = Effect.promise(async () => {
        await database.pool.query(
          `insert into pass_administration_changes (request_id, pass_id, actor_account_id,
             actor_account_email, reason, change, requested_at)
           values (uuid_generate_v7(), $1, $2, $3, 'Synthetic change', '{"_tag":"Cancelled"}', now())`,
          [passId, holder, testEmailAddress("pass-reminder-admin")]
        );
        return [table];
      });
      expect(
        await read(
          {
            ...unlimitedDue,
            passId,
            holderAccountId: holder,
            holderVersion: 0,
            includeDeskLabel: true,
          },
          tables
        )
      ).toEqual(Option.none());
    });

    test("a desk lookup that crosses the Prague expiry boundary invalidates delivery", async () => {
      const holder = await seedAccount();
      const passId = await seedPass({
        holder,
        kind: "unlimited",
        tier: "reserved-desk",
        validFrom: "2026-11-03",
        validUntil: "2026-12-03",
      });
      await seedDeskDays(passId, holder, [["2026-11-03", "14"]]);
      const lastMillisecond = Temporal.Instant.from("2026-12-02T22:59:59.999Z");
      const target: ReadDuePassReminder = {
        ...unlimitedDue,
        now: lastMillisecond,
        passId,
        holderAccountId: holder,
        holderVersion: 0,
        includeDeskLabel: true,
      };
      expect(Option.getOrThrow(await read(target))).toMatchObject({
        deskLabel: "Desk 14",
      });
      const crossesMidnight = TestClock.setTime(
        lastMillisecond.add({ milliseconds: 1 }).epochMilliseconds
      ).pipe(Effect.as([table]));
      expect(await read(target, crossesMidnight)).toEqual(Option.none());
    });

    test("pages a family by pass ID without duplicates or missing eligible passes", async () => {
      const holder = await seedAccount();
      const { rows } = await database.pool.query<{ id: string }>(
        `with purchases as (
           insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, fulfilled_at)
           select uuid_generate_v7(), 'pass-purchase', 'synthetic', 'complimentary', 'fulfilled', now()
           from generate_series(1, $2::integer) returning id
         )
         insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier,
           entry_count, status, valid_from, valid_until, quote, locale, created_at)
         select id, $1, $1, 'entry-pack', 'open-space', 5, 'active', '2028-01-01',
           '2028-03-01', '{}', 'en-US', now() from purchases returning id`,
        [holder, passReminderPageSize + 2]
      );
      const input = {
        ...packDue,
        dueDate: date("2028-02-22"),
        now: Temporal.Instant.from("2028-02-22T10:00:00Z"),
      };
      const first = await run(
        Effect.flatMap(PassReminderReads, (reads) => reads.listDue(input))
      );
      expect(first).toHaveLength(passReminderPageSize);
      const afterPassId = first.at(-1)?.passId;
      const second = await run(
        Effect.flatMap(PassReminderReads, (reads) =>
          reads.listDue({ ...input, afterPassId })
        )
      );
      expect(second).toHaveLength(2);
      expect([...first, ...second].map(({ passId }) => passId)).toEqual(
        rows.map(({ id }) => id).sort()
      );
    });
  }
);
