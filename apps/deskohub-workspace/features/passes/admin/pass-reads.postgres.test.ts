import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DotyposCloudIdSchema,
  type DotyposCustomer,
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
} from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { AdministrationCustomerDirectory } from "@/features/administration/customer-directory.service";
import { orderIdSchema } from "@/features/order";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  createWorkspacePostgresSuiteDatabase,
  requireTestDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  listAdminPasses,
  readAdminCustomerPasses,
  readAdminPass,
  readReservationPassLinks,
} from "./pass-reads";

const fixtureDotyposCustomer = (fields: {
  readonly id: DotyposCustomerId;
  readonly firstName: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly deleted?: boolean;
}): DotyposCustomer => ({
  _cloudId: DotyposCloudIdSchema.make("1"),
  points: null,
  flags: "0",
  display: true,
  deleted: false,
  ...fields,
});

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Administration pass projections on disposable PostgreSQL",
  () => {
    let database: WorkspacePostgresSuiteDatabase;
    const passId = orderIdSchema.make(crypto.randomUUID());
    const unlimitedId = orderIdSchema.make(crypto.randomUUID());
    const buyerId = DotyposCustomerIdSchema.make("pass-admin-test-buyer");
    const holderId = DotyposCustomerIdSchema.make("pass-admin-test-holder");
    const buyerAccount = crypto.randomUUID();
    const holderAccount = crypto.randomUUID();
    const invitedAccount = crypto.randomUUID();
    const invitationEmail = testEmailAddress("admin-pass-invite");
    const winner = crypto.randomUUID();
    const extraCapture = crypto.randomUUID();
    const reservedDate = "2099-06-01";
    let packReservationId: ReturnType<typeof workspaceReservationIdSchema.make>;
    let dayReservationId: ReturnType<typeof workspaceReservationIdSchema.make>;
    const providerDirectory = Layer.mock(AdministrationCustomerDirectory, {
      findMany: () => Effect.succeed(new Map()),
      search: () =>
        Effect.die(new Error("No directory required for these fixtures")),
    });

    const run = <A, E>(
      read: Effect.Effect<
        A,
        E,
        | AdministrationCustomerDirectory
        | import("@/db/database.service").WorkspaceDatabase
      >
    ) =>
      Effect.runPromise(
        read.pipe(
          Effect.provide(providerDirectory),
          Effect.provide(database.layer)
        )
      );

    beforeAll(async () => {
      database = requireTestDatabase(
        await createWorkspacePostgresSuiteDatabase("admin_pass_reads")
      );
      const { pool } = database;
      await pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2), ($3, $4), ($5, null)",
        [buyerAccount, buyerId, holderAccount, holderId, invitedAccount]
      );
      await pool.query(
        "insert into auth.\"user\" (id, name, email) values ($1, '', $2)",
        [invitedAccount, invitationEmail]
      );
      await pool.query(
        `insert into orders
          (id, kind, dotypos_customer_id, payment_state, fulfillment_state,
           active_payment_attempt_id, paid_at, fulfilled_at)
         values
          ($1, 'pass-purchase', 'old-billing-customer', 'paid', 'fulfilled', $3, now(), now()),
          ($2, 'pass-purchase', 'old-billing-customer', 'paid', 'fulfilled', null, now(), now())`,
        [passId, unlimitedId, winner]
      );
      await pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, entry_count,
           status, valid_from, valid_until, quote, locale, created_at, unlimited_coffee)
         values
          ($1, $3, $4, 'entry-pack', 'open-space', 5, 'active', '2024-06-01',
            '2024-07-01', '{}', 'en-US', now(), null),
          ($2, $3, $5, 'unlimited', 'open-space', null, 'active', $6::date,
            $6::date + 30, '{}', 'en-US', now(), true)`,
        [
          passId,
          unlimitedId,
          buyerAccount,
          holderAccount,
          invitedAccount,
          reservedDate,
        ]
      );
      await pool.query(
        `insert into payment_attempts
          (id, order_id, provider, provider_order_id, security_token, state,
           refund_state, refund_target_value, refunded_amount_value, refunded_at,
           amount_value, amount_exponent, currency)
         values
          ($1, $3, 'mock', 'winning-synthetic-order', 'synthetic-private-token', 'paid',
           'required', 50000, 10000, now(), 100000, 2, 'CZK'),
          ($2, $3, 'mock', 'replaced-synthetic-order', null, 'paid',
           'not_required', null, null, null, 70000, 2, 'CZK')`,
        [winner, extraCapture, passId]
      );
      await pool.query(
        `insert into legal_evidence_events
          (order_id, document_key, document_path, document_hash, hash_algorithm,
           accepted, accepted_at, locale, source, acknowledgements)
         values ($1, 'termsAndConditions', '/conditions', 'synthetic-hash',
           'sha256', true, now(), 'en-US', 'payment_submit', '{"entryPackEarlyStartRequested":true}')`,
        [passId]
      );
      const pack = await pool.query<{ id: string }>(
        `insert into workspace_reservations
          (checkout_attempt_key, author_account_id, dotypos_customer_id, reservation_state, payment_state,
           fulfillment_state, reservation_details, locale)
         values (uuid_generate_v7(), $1, $2, 'draft', 'not_started', 'not_started', '{}', 'en-US')
         returning id`,
        [holderAccount, holderId]
      );
      const [packRow] = pack.rows;
      assert(packRow);
      packReservationId = workspaceReservationIdSchema.make(packRow.id);
      await pool.query(
        `insert into pass_entry_claims (reservation_id, pass_id, date, status)
         values ($1, $2, '2024-06-20', 'consumed')`,
        [packReservationId, passId]
      );
      const day = await pool.query<{ id: string }>(
        `insert into workspace_reservations
          (checkout_attempt_key, dotypos_customer_id, dotypos_reservation_id, author_account_id,
           reservation_state, payment_state, fulfillment_state, reservation_details,
           locale, pass_id, service_date, pass_day_table_id, pass_day_hold_requested_at,
           pass_day_hold_generation, paid_at, fulfilled_at, reservation_confirmed_at)
         values (uuid_generate_v7(), $1, 'synthetic-current-reservation', $2, 'confirmed', 'paid',
           'fulfilled', '{}', 'en-US', $3, $4, 'synthetic-desk-2', now(),
           uuid_generate_v7(), now(), now(), now())
         returning id`,
        [holderId, buyerAccount, unlimitedId, reservedDate]
      );
      const [dayRow] = day.rows;
      assert(dayRow);
      dayReservationId = workspaceReservationIdSchema.make(dayRow.id);
      await pool.query(
        `insert into reservation_access_grants
          (workspace_reservation_id, device_id, state, reservation_starts_at,
           access_starts_at, access_ends_at, issued_at)
         values ($1, 'synthetic-device', 'expired', now(),
           now(), now() + interval '1 hour', now())`,
        [dayReservationId]
      );
      await pool.query(
        `insert into unlimited_pass_day_moves
          (generation, reservation_id, customer_id, source_reservation_id,
           source_table_id, target_table_id, target_reservation_id, requested_at,
           checked_at, attached_at, settled_at)
         values (uuid_generate_v7(), $1, $2, 'synthetic-old-reservation',
           'synthetic-desk-1', 'synthetic-desk-2', 'synthetic-current-reservation',
           now(), now(), now(), now())`,
        [dayReservationId, holderId]
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    test("filters calendar status, tier, product and paid gift source together", async () => {
      const page = await run(
        listAdminPasses({
          product: "entry-pack",
          tier: "open-space",
          status: "expired",
          source: "gift",
        })
      );
      expect(page.total).toBe(1);
      expect(page.passes).toMatchObject([
        { id: passId, entriesLeft: 4, status: "expired" },
      ]);
      expect(
        (await run(listAdminPasses({ status: "scheduled" }))).passes
      ).toMatchObject([
        { id: unlimitedId, claimed: false, holder: { email: invitationEmail } },
      ]);
      expect(
        (await run(listAdminPasses({ query: passId }))).passes
      ).toMatchObject([{ id: passId }]);
    });

    test("keeps eligible unlinked invitations searchable during a customer directory outage", async () => {
      const response = await run(listAdminPasses({ query: invitationEmail }));
      expect(response.searchIncomplete).toBe(true);
      expect(response.passes).toMatchObject([{ id: unlimitedId }]);
    });

    test("matches the full eligible party set without sending the search term to the directory", async () => {
      const { rows: fixtureCustomers } = await database.pool.query<{
        id: string;
        customer: string;
      }>(
        `with accounts as (
          insert into customer_accounts (id, dotypos_customer_id)
          select uuid_generate_v7(), 'eligible-pass-customer-' || number
          from generate_series(1, 51) as number
          returning id, dotypos_customer_id
        ), purchased as (
          insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state)
          select id, 'pass-purchase', dotypos_customer_id, 'not_started', 'not_started'
          from accounts
          returning id, dotypos_customer_id
        )
        insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, status,
           valid_from, valid_until, quote, locale, created_at)
        select id, id, id, 'unlimited', 'reserved-desk', 'pending_payment',
          '2098-01-01', '2098-02-01', '{}', 'en-US', now()
        from purchased
        returning id, (select dotypos_customer_id from accounts where accounts.id = pass_purchases.id) as customer`
      );
      const match = fixtureCustomers.find(
        ({ customer }) => customer === "eligible-pass-customer-51"
      );
      assert(match);
      const contacts = new Map(
        fixtureCustomers.map(({ customer }) => {
          const id = DotyposCustomerIdSchema.make(customer);
          return [
            id,
            fixtureDotyposCustomer({
              id,
              firstName: customer === match.customer ? "Target" : "Unrelated",
              lastName: "Customer",
              deleted: false,
            }),
          ] as const;
        })
      );
      const requests: DotyposCustomerId[] = [];
      const directory = Layer.mock(AdministrationCustomerDirectory, {
        findMany: (ids) =>
          Effect.sync(() => {
            requests.push(...ids);
            return new Map(
              requests.flatMap((id) => {
                const contact = contacts.get(id);
                return contact ? [[id, contact] as const] : [];
              })
            );
          }),
        search: () =>
          Effect.die(
            new Error("Private search terms must never reach the directory")
          ),
      });
      const answer = await Effect.runPromise(
        listAdminPasses({
          product: "unlimited",
          tier: "reserved-desk",
          query: "Target Customer",
        }).pipe(Effect.provide(directory), Effect.provide(database.layer))
      );
      expect(requests).toHaveLength(51);
      expect(answer.searchIncomplete).toBe(false);
      expect(answer.total).toBe(1);
      expect(answer.passes).toMatchObject([{ id: match.id, claimed: null }]);
    });

    test("requires issuance before treating a pass bought for oneself as claimed", async () => {
      try {
        for (const status of ["pending_payment", "void", "active"]) {
          await database.pool.query(
            "update pass_purchases set holder_account_id = buyer_account_id, status = $1 where id = $2",
            [status, passId]
          );
          const detail = await run(readAdminPass(passId));
          expect(detail?.pass.claimed).toBe(status === "active" ? true : null);
        }
      } finally {
        await database.pool.query(
          "update pass_purchases set holder_account_id = $1, status = 'active' where id = $2",
          [holderAccount, passId]
        );
      }
    });

    test("uses current account links and counts only the winning payment less confirmed refunds", async () => {
      const buyer = await run(readAdminCustomerPasses(buyerId));
      const holder = await run(readAdminCustomerPasses(holderId));
      expect(buyer.held).toEqual([]);
      expect(buyer.boughtForOthers).toMatchObject([{ id: passId }]);
      expect(buyer.spent).toEqual([
        { value: 90000, exponent: 2, currency: "CZK" },
      ]);
      expect(holder.held).toMatchObject([{ id: passId }]);
      expect(holder.spent).toEqual([]);
    });

    test("keeps paid but unfulfilled passes out of the entitlement lists and in spending", async () => {
      try {
        for (const status of ["void", "pending_payment"]) {
          await database.pool.query(
            "update pass_purchases set status = $1 where id = $2",
            [status, passId]
          );
          const customer = await run(readAdminCustomerPasses(buyerId));
          expect(customer.boughtForOthers).toEqual([]);
          expect(customer.spent).toEqual([
            { value: 90000, exponent: 2, currency: "CZK" },
          ]);
        }
      } finally {
        await database.pool.query(
          "update pass_purchases set status = 'active' where id = $1",
          [passId]
        );
      }
    });

    test("matches a linked login email only for active accounts and never projects pending-deletion contact data", async () => {
      const buyerEmail = testEmailAddress("admin-pass-buyer-login");
      const holderEmail = testEmailAddress("admin-pass-pending-deletion");
      await database.pool.query(
        `insert into auth."user" (id, name, email, deletion_requested_at)
         values ($1, '', $3, null), ($2, '', $4, now())`,
        [buyerAccount, holderAccount, buyerEmail, holderEmail]
      );
      const seen = new Set<DotyposCustomerId>();
      const profiles = new Map<DotyposCustomerId, DotyposCustomer>([
        [
          buyerId,
          fixtureDotyposCustomer({
            id: buyerId,
            firstName: "Eligible Buyer",
            email: testEmailAddress("different-directory-email"),
            deleted: false,
          }),
        ],
        [
          holderId,
          fixtureDotyposCustomer({
            id: holderId,
            firstName: "Pending Deletion Holder",
            email: holderEmail,
            deleted: false,
          }),
        ],
      ]);
      const directory = Layer.mock(AdministrationCustomerDirectory, {
        findMany: (ids) =>
          Effect.sync(
            () =>
              new Map(
                [...ids].flatMap((id) => {
                  seen.add(id);
                  const profile = profiles.get(id);
                  return profile ? [[id, profile] as const] : [];
                })
              )
          ),
        search: () =>
          Effect.die(
            new Error("Private search terms must never reach the directory")
          ),
      });
      try {
        const read = <A, E>(
          effect: Effect.Effect<
            A,
            E,
            | AdministrationCustomerDirectory
            | import("@/db/database.service").WorkspaceDatabase
          >
        ) =>
          Effect.runPromise(
            effect.pipe(
              Effect.provide(directory),
              Effect.provide(database.layer)
            )
          );
        const buyer = await read(
          listAdminPasses({ product: "entry-pack", query: buyerEmail })
        );
        expect(buyer.passes).toMatchObject([{ id: passId }]);
        const holder = await read(
          listAdminPasses({ product: "entry-pack", query: holderEmail })
        );
        expect(holder.passes).toEqual([]);
        expect(seen.has(holderId)).toBe(false);
        const detail = await read(readAdminPass(passId));
        expect(detail?.pass.holder).toMatchObject({
          customerId: null,
          name: null,
          email: null,
        });
        expect(JSON.stringify(detail)).not.toContain(holderEmail);
      } finally {
        await database.pool.query(
          'delete from auth."user" where id in ($1, $2)',
          [buyerAccount, holderAccount]
        );
      }
    });

    test("projects attempts, consent, claims and day moves without provider credentials", async () => {
      const pack = await run(readAdminPass(passId));
      expect(pack?.attempts).toHaveLength(2);
      expect(pack?.attempts.find(({ id }) => id === winner)).toMatchObject({
        refundState: "required",
        refundTargetValue: 50000,
        refundedAmountValue: 10000,
      });
      expect(JSON.stringify(pack)).not.toContain("synthetic-private-token");
      expect(pack?.consent).toMatchObject([
        {
          accepted: true,
          acknowledgements: { entryPackEarlyStartRequested: true },
        },
      ]);
      expect(pack?.claims).toMatchObject([
        { reservationId: packReservationId, status: "consumed" },
      ]);

      const unlimited = await run(readAdminPass(unlimitedId));
      expect(unlimited?.days).toMatchObject([
        {
          id: dayReservationId,
          date: reservedDate,
          tableId: "synthetic-desk-2",
          accessIssued: true,
        },
      ]);
      expect(unlimited?.moves).toMatchObject([
        {
          date: reservedDate,
          sourceTableId: "synthetic-desk-1",
          targetTableId: "synthetic-desk-2",
        },
      ]);
      const links = await run(
        readReservationPassLinks([packReservationId, dayReservationId])
      );
      expect(links.get(packReservationId)).toEqual({
        passId,
        product: "entry-pack",
      });
      expect(links.get(dayReservationId)).toEqual({
        passId: unlimitedId,
        product: "unlimited",
      });
    });
  }
);
