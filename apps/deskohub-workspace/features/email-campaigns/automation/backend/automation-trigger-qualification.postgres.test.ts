import "@/shared/testing/workspace-test-env";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { DotyposCustomerId } from "@deskohub/dotypos";
import type { AutomationFlowType } from "@deskohub/workspace-admin-api";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import type { CampaignId } from "../../campaign-identifiers";
import { makeAutomationEngineScenario } from "./automation-engine-scenario.test-utils";
import { automationFlowFixture } from "./automation-lifecycle.test-utils";

/**
 * The engine plans over whole tables, so the suite runs on a database of
 * its own.
 */
const database = await createWorkspacePostgresSuiteDatabase(
  "automation_trigger_qualification"
);
afterAll(() => database?.close());

describe.skipIf(!database)(
  "a reservation trigger's stay and payment",
  async () => {
    if (!database) return;
    /** Tuesday 1 September 2026, 08:00 in Prague, in the wall clock's past. */
    const start = Temporal.Instant.from("2026-09-01T06:00:00Z");
    /** Each test runs on its own days, so one test's visits never reach another's sweep. */
    const dayStart = (day: number) => start.add({ hours: 24 * day });

    type ReservationTriggerFields = Omit<
      Extract<
        AutomationFlowType["trigger"],
        { readonly _tag: "ReservationFinished" }
      >,
      "_tag"
    >;
    const reservationSend = (
      tag: "ReservationFinished" | "ReservationCancelled",
      trigger: ReservationTriggerFields
    ) =>
      automationFlowFixture({
        trigger: { _tag: tag, ...trigger },
        steps: [{ _tag: "Send", id: "send" }],
      });
    const finishedSend = (trigger: ReservationTriggerFields) =>
      reservationSend("ReservationFinished", trigger);
    const cowork = { family: "cowork", properties: [] } as const;

    const scenario = await makeAutomationEngineScenario({
      database,
      now: start,
    });
    const { fixtures, kit, read } = scenario;
    const { pool } = database;

    const activated: CampaignId[] = [];
    const entryPacks: string[] = [];
    let today = start;

    const begin = async (day: number) => {
      today = dayStart(day);
      await scenario.prepare(today);
      return today;
    };

    const activate = async (flow: AutomationFlowType, at: Temporal.Instant) => {
      const { campaignId } = await kit.seedActive(flow, { at });
      activated.push(campaignId);
      return campaignId;
    };

    afterEach(async () => {
      for (const campaignId of activated.splice(0)) {
        await scenario.lifecycle(
          (lifecycle) => lifecycle.archive(campaignId),
          today.add({ hours: 47 })
        );
      }
    });
    afterAll(async () => {
      // Entry claims keep their reservations; drop them before the scenario's.
      await pool.query(
        "delete from pass_entry_claims where pass_id = any($1)",
        [entryPacks]
      );
      await pool.query("delete from pass_purchases where id = any($1)", [
        entryPacks,
      ]);
      await scenario.cleanup();
    });

    /** Each receipt's disposition by its dedup key. */
    const dispositions = async (campaignId: CampaignId) =>
      Object.fromEntries(
        (await read.receipts(campaignId)).map((receipt) => [
          receipt.dedup_key,
          receipt.disposition,
        ])
      );

    const finishedKey = (reservationId: WorkspaceReservationId) =>
      `reservation-finished:${reservationId}`;

    const unprocessedFinishes = async (
      reservationIds: readonly WorkspaceReservationId[]
    ) =>
      (
        await pool.query(
          "select id from customer_events where workspace_reservation_id = any($1) and kind = 'reservation-finished' and automation_processed_at is null",
          [reservationIds]
        )
      ).rows;

    /** Pays the reservation by its own order: a paid card attempt it keeps. */
    const payIndividually = async (reservationId: WorkspaceReservationId) => {
      const attemptId = `qualification-card-${reservationId}`;
      await pool.query(
        `insert into payment_attempts (id, order_id, workspace_reservation_id, provider,
         provider_order_id, state, amount_value, amount_exponent, currency)
       values ($1, $2, $2, 'nexi', $3, 'paid', 29000, 2, 'CZK')`,
        [attemptId, reservationId, `order-${attemptId}`]
      );
      await pool.query(
        "update workspace_reservations set active_payment_attempt_id = $2 where id = $1",
        [reservationId, attemptId]
      );
    };

    /**
     * Funds the reservation from the customer's Entry pack: a consumed entry
     * claim and the zero-amount internal attempt that marks it paid.
     */
    const payFromEntryPack = async (
      reservationId: WorkspaceReservationId,
      customer: DotyposCustomerId
    ) => {
      const accountId = await kit.seedAccount();
      const passId = `qualification-pack-${reservationId}`;
      entryPacks.push(passId);
      await pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at, fulfilled_at)
       values ($1, 'pass-purchase', $2, 'paid', 'fulfilled', now(), now())`,
        [passId, customer]
      );
      await pool.query(
        `insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier,
         entry_count, status, valid_from, valid_until, quote, locale, created_at)
       values ($1, $2, $2, 'entry-pack', 'open-space', 5, 'active',
         '2026-08-01', '2026-12-31', '{}', 'en-US', now())`,
        [passId, accountId]
      );
      await pool.query(
        `insert into pass_entry_claims (reservation_id, pass_id, date, status)
       values ($1, $2, '2026-09-04', 'consumed')`,
        [reservationId, passId]
      );
      const attemptId = `qualification-entry-${reservationId}`;
      await pool.query(
        `insert into payment_attempts (id, order_id, workspace_reservation_id, provider,
         state, amount_value, amount_exponent, currency)
       values ($1, $2, $2, 'internal', 'paid', 0, 2, 'CZK')`,
        [attemptId, reservationId]
      );
      await pool.query(
        "update workspace_reservations set active_payment_attempt_id = $2 where id = $1",
        [reservationId, attemptId]
      );
    };

    test("a day stay trigger starts no run for an overnight Reserved Desk finish", async () => {
      const at = await begin(0);
      const dayOnly = await activate(
        finishedSend({ product: cowork, stay: "day" }),
        at
      );
      const anyStay = await activate(finishedSend({ product: cowork }), at);
      const dayCustomer = await fixtures.addCustomer("stay-day");
      const overnightCustomer = await fixtures.addCustomer("stay-overnight");
      // 09:00 to 17:00 in Prague.
      const day = await fixtures.book({
        label: "stay-day",
        customer: dayCustomer,
        startsAt: at.add({ hours: 1 }),
        endsAt: at.add({ hours: 9 }),
        reservedDesk: true,
      });
      // Noon to noon the next day in Prague.
      const overnight = await fixtures.book({
        label: "stay-overnight",
        customer: overnightCustomer,
        startsAt: at.add({ hours: 4 }),
        endsAt: at.add({ hours: 28 }),
        reservedDesk: true,
      });
      // Dotypos cancelled this overnight visit, yet its finish was recorded:
      // the stay decides before the re-check, so no withdrawn receipt.
      const goneCustomer = await fixtures.addCustomer("stay-gone");
      const gone = await fixtures.book({
        label: "stay-gone",
        customer: goneCustomer,
        startsAt: at.add({ hours: 4 }),
        endsAt: at.add({ hours: 28 }),
        reservedDesk: true,
      });
      fixtures.cancelVisit(gone);
      await fixtures.recordEvent({
        kind: "reservation-finished",
        customer: goneCustomer,
        occurredAt: at.add({ hours: 28 }),
        reservationId: gone,
      });

      await scenario.runUntil({ from: at, until: at.add({ hours: 30 }) });

      expect(await unprocessedFinishes([day, overnight, gone])).toEqual([]);
      expect(await dispositions(dayOnly)).toEqual({
        [finishedKey(day)]: "started",
      });
      expect(await dispositions(anyStay)).toEqual({
        [finishedKey(day)]: "started",
        [finishedKey(overnight)]: "started",
        [finishedKey(gone)]: "withdrawn",
      });
    });

    test("an individual payment trigger starts no run for an Entry-pack-funded finish", async () => {
      const at = await begin(3);
      const individual = await activate(
        finishedSend({ payment: "individual" }),
        at
      );
      const coworkIndividual = await activate(
        finishedSend({ product: cowork, payment: "individual" }),
        at
      );
      const anyPayment = await activate(finishedSend({}), at);
      const paidCustomer = await fixtures.addCustomer("payment-card");
      const packCustomer = await fixtures.addCustomer("payment-pack");
      const paid = await fixtures.book({
        label: "payment-card",
        customer: paidCustomer,
        startsAt: at.add({ hours: 1 }),
        endsAt: at.add({ hours: 3 }),
      });
      await payIndividually(paid);
      const pack = await fixtures.book({
        label: "payment-pack",
        customer: packCustomer,
        startsAt: at.add({ hours: 1 }),
        endsAt: at.add({ hours: 3 }),
      });
      await payFromEntryPack(pack, packCustomer);

      await scenario.runUntil({ from: at, until: at.add({ hours: 5 }) });

      expect(await unprocessedFinishes([paid, pack])).toEqual([]);
      expect(await dispositions(individual)).toEqual({
        [finishedKey(paid)]: "started",
      });
      expect(await dispositions(coworkIndividual)).toEqual({
        [finishedKey(paid)]: "started",
      });
      expect(await dispositions(anyPayment)).toEqual({
        [finishedKey(paid)]: "started",
        [finishedKey(pack)]: "started",
      });
    });

    test("a cancellation trigger judges the stay of the visit Workspace cancelled", async () => {
      const at = await begin(6);
      const overnightOnly = await activate(
        reservationSend("ReservationCancelled", {
          product: cowork,
          stay: "overnight",
        }),
        at
      );
      const anyStay = await activate(
        reservationSend("ReservationCancelled", { product: cowork }),
        at
      );
      const cancel = async (label: string, hours: number) => {
        const customer = await fixtures.addCustomer(`cancel-${label}`);
        // Booked for tomorrow, from the hour given in Prague.
        const startsAt = at.add({ hours: 24 + hours });
        const reservationId = await fixtures.book({
          label: `cancel-${label}`,
          customer,
          startsAt,
          endsAt:
            label === "overnight"
              ? startsAt.add({ hours: 24 })
              : startsAt.add({ hours: 8 }),
          reservedDesk: true,
        });
        const cancelledAt = at.add({ hours: 1 });
        // Cancelled as a customer's cancellation leaves it: state and instant.
        await pool.query(
          "update workspace_reservations set reservation_state = 'cancelled', reservation_cancelled_at = $2 where id = $1",
          [reservationId, cancelledAt.toString()]
        );
        fixtures.cancelVisit(reservationId);
        await fixtures.recordEvent({
          kind: "reservation-cancelled",
          customer,
          occurredAt: cancelledAt,
          reservationId,
        });
        return reservationId;
      };
      // Noon to noon, and 09:00 to 17:00, in Prague.
      const overnight = await cancel("overnight", 4);
      const day = await cancel("day", 1);

      await scenario.runUntil({ from: at, until: at.add({ hours: 3 }) });

      const cancelledKey = (reservationId: WorkspaceReservationId) =>
        `reservation-cancelled:${reservationId}`;
      expect(await dispositions(overnightOnly)).toEqual({
        [cancelledKey(overnight)]: "started",
      });
      expect(await dispositions(anyStay)).toEqual({
        [cancelledKey(overnight)]: "started",
        [cancelledKey(day)]: "started",
      });
    });

    test("an expired event takes no receipt when its stored tier rules the stay out", async () => {
      const at = await begin(9);
      const overnightOnly = await activate(
        finishedSend({ product: cowork, stay: "overnight" }),
        at
      );
      const expired = async (label: string, reservedDesk: boolean) => {
        const customer = await fixtures.addCustomer(label);
        // Visits far ahead, so the sweep records nothing of its own.
        const reservationId = await fixtures.book({
          label,
          customer,
          startsAt: at.add({ hours: 90 }),
          endsAt: at.add({ hours: 100 }),
          reservedDesk,
        });
        await fixtures.recordEvent({
          kind: "reservation-finished",
          customer,
          occurredAt: at.add({ hours: 1 }),
          reservationId,
        });
        return reservationId;
      };
      const openSpace = await expired("expire-open-space", false);
      const reservedDesk = await expired("expire-reserved-desk", true);

      // A day later the events are past intake's limit and expire unfetched.
      await scenario.runUntil({
        from: at.add({ hours: 26 }),
        until: at.add({ hours: 27 }),
      });

      expect(await unprocessedFinishes([openSpace, reservedDesk])).toEqual([]);
      // Open Space can't be overnight; a Reserved Desk stay needs the visit.
      expect(await dispositions(overnightOnly)).toEqual({
        [finishedKey(reservedDesk)]: "failed",
      });
    });
  }
);
