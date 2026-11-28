import "@/shared/testing/workspace-test-env";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { DotyposCustomerId } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Schema } from "effect";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import type { AudienceFilter } from "../../audience-filter";
import type { CampaignId } from "../../campaign-identifiers";
import { automationRunIdSchema } from "../automation-identifiers";
import {
  databaseInstant,
  makeAutomationEngineScenario,
} from "./automation-engine-scenario.test-utils";
import { automationFlowFixture } from "./automation-lifecycle.test-utils";

/**
 * The engine plans over whole tables, so the suite runs on a database of
 * its own.
 */
const database = await createWorkspacePostgresSuiteDatabase(
  "automation_screen08_repeat_visit"
);
afterAll(() => database?.close());

const prague = "Europe/Prague";
const cowork = { family: "cowork", properties: [] } as const;

const readRepeatVisitRun = Schema.decodeUnknownSync(
  Schema.Struct({
    id: automationRunIdSchema,
    trigger_reservation_id: workspaceReservationIdSchema,
    status: Schema.String,
    outcome: Schema.NullOr(Schema.String),
    outcome_reason: Schema.NullOr(Schema.String),
    due_at: Schema.Union([Schema.Date, Schema.String, Schema.Null]),
  })
);
const readClaimRunId = Schema.decodeUnknownSync(automationRunIdSchema);

/** A second paid day visit to the coworking space within 60 days. */
const repeatDayVisits: AudienceFilter = {
  _tag: "Condition",
  attribute: "reservationCount",
  params: {
    dateBasis: "visitEnd",
    period: { _tag: "Last", count: 60, unit: "day" },
    product: cowork,
    stay: "day",
    payment: "individual",
  },
  operator: "gte",
  value: 2,
};

/**
 * Screen 08's repeat-visit automation: when a paid coworking day visit
 * finishes, send once per customer to a customer with two such visits in the
 * last 60 days, keeping 14 days from any one-off campaign email and skipping
 * pass holders.
 */
const repeatVisitFlow = automationFlowFixture({
  trigger: {
    _tag: "ReservationFinished",
    product: cowork,
    stay: "day",
    payment: "individual",
  },
  steps: [
    { _tag: "Condition", id: "repeat-visit", filter: repeatDayVisits },
    {
      _tag: "Send",
      id: "send",
      oncePerCustomer: true,
      oneOffCampaignGap: { days: 14 },
      skipPassHolders: true,
    },
  ],
});

describe.skipIf(!database)(
  "Screen 08's repeat-visit automation end to end",
  async () => {
    if (!database) return;
    const { pool } = database;
    /** Monday 5 January 2026, the first test's first day. */
    const firstDay = Temporal.PlainDate.from("2026-01-05");

    const scenario = await makeAutomationEngineScenario({
      database,
      now: Temporal.Instant.from("2026-01-05T07:00:00Z"),
      deploymentEnvironment: "development",
    });
    const { fixtures, kit, read } = scenario;
    const emailOf = (customer: DotyposCustomerId) =>
      testEmailAddress(customer.slice(-48));

    /** `date` at `time` in Prague. */
    const pragueAt = (date: Temporal.PlainDate, time: string) =>
      date.toZonedDateTime({ timeZone: prague, plainTime: time }).toInstant();

    /**
     * Each test runs on days after the previous test's, so one test's visits
     * never reach another's sweep or count.
     */
    let nextDay = firstDay;
    let today = firstDay;
    let latest = pragueAt(firstDay, "08:00");
    const seen = { requests: 0, mailed: 0 };
    const activated: CampaignId[] = [];

    /** Starts the test on its own first day, 08:00 in Prague, with the automation active. */
    const begin = async () => {
      today = nextDay;
      const at = pragueAt(today, "08:00");
      latest = at;
      await scenario.prepare(at);
      seen.requests = scenario.resend.requests().length;
      seen.mailed = scenario.resend.mailed().length;
      const { campaignId } = await kit.seedActive(repeatVisitFlow, { at });
      activated.push(campaignId);
      return { at, campaignId };
    };

    afterEach(async () => {
      scenario.resend.respondWith(() => "accept");
      scenario.dotypos.onRequest(undefined);
      const archiveAt = latest.add({ hours: 47 });
      for (const campaignId of activated.splice(0)) {
        await scenario.lifecycle(
          (lifecycle) => lifecycle.archive(campaignId),
          archiveAt
        );
      }
      nextDay = archiveAt
        .toZonedDateTimeISO(prague)
        .toPlainDate()
        .add({ days: 1 });
    });
    afterAll(() => scenario.cleanup());

    const requests = () => scenario.resend.requests().slice(seen.requests);
    const mailed = () => scenario.resend.mailed().slice(seen.mailed);

    const iso = (value: Date | string | null | undefined) =>
      databaseInstant(value)?.toString() ?? null;

    type Visit = {
      readonly label: string;
      readonly customer: DotyposCustomerId;
      /** Days after the test's first day. */
      readonly day: number;
      /** A Reserved Desk from noon to noon the next day; else 09:00 to 17:00. */
      readonly overnight?: boolean;
      readonly payment?: "individual" | "entry-pack";
    };

    /** Books `visit` in Workspace and Dotypos, paid as it says (individually by default). */
    const visit = async (input: Visit) => {
      const date = today.add({ days: input.day });
      const startsAt = pragueAt(date, input.overnight ? "12:00" : "09:00");
      const endsAt = input.overnight
        ? pragueAt(date.add({ days: 1 }), "12:00")
        : pragueAt(date, "17:00");
      const reservationId = await fixtures.book({
        label: input.label,
        customer: input.customer,
        startsAt,
        endsAt,
        reservedDesk: input.overnight ?? false,
      });
      if ((input.payment ?? "individual") === "individual") {
        await fixtures.payIndividually(reservationId);
      } else {
        await fixtures.payFromEntryPack({
          reservationId,
          customer: input.customer,
          date: date.toString(),
        });
      }
      if (Temporal.Instant.compare(endsAt, latest) > 0) latest = endsAt;
      return { reservationId, endsAt };
    };

    /** Ticks from `from` until nothing more falls due before `until`. */
    const settle = (
      from: Temporal.Instant,
      until: Temporal.Instant = latest.add({ hours: 2 })
    ) => scenario.runUntil({ from, until });

    /** The campaign's runs in the order they started. */
    const runsOf = async (campaignId: CampaignId) =>
      (await read.runs(campaignId)).map((row) => {
        const run = readRepeatVisitRun(row);
        return {
          id: run.id,
          reservation: run.trigger_reservation_id,
          status: run.status,
          outcome: run.outcome,
          reason: run.outcome_reason,
          dueAt: iso(run.due_at),
        };
      });

    /** Each run's trigger reservation with how it ended. */
    const outcomesOf = async (campaignId: CampaignId) =>
      (await runsOf(campaignId)).map((run) => [
        run.reservation,
        run.outcome,
        run.reason,
      ]);

    const finishedKey = (reservationId: WorkspaceReservationId) =>
      `reservation-finished:${reservationId}`;

    /** Each receipt's disposition by its dedup key. */
    const dispositions = async (campaignId: CampaignId) =>
      Object.fromEntries(
        (await read.receipts(campaignId)).map((receipt) => [
          receipt.dedup_key,
          receipt.disposition,
        ])
      );

    const claimHolders = async (campaignId: CampaignId) =>
      (await read.claims(campaignId)).map((claim) =>
        readClaimRunId(claim.run_id)
      );

    /** Whether the campaign has a persisted delivery batch. */
    const batchPersisted = async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select 1 from email_campaign_delivery_batches b join email_campaign_sends s on s.id = b.send_id where s.campaign_id = $1",
          [campaignId]
        )
      ).rows.length > 0;

    /**
     * Runs `act` on the first Dotypos profile read after the campaign's batch
     * was persisted: the guard's, immediately before the provider request.
     */
    const beforeGuard = (
      campaignId: CampaignId,
      act: () => Promise<unknown>
    ) => {
      let done = false;
      scenario.dotypos.onRequest(({ method }) =>
        method !== "getCustomersByIds" || done
          ? Effect.void
          : Effect.promise(async () => {
              if (!(await batchPersisted(campaignId))) return;
              done = true;
              await act();
            })
      );
    };

    test("a second paid day visit within 60 days sends the email once", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("second-visit");
      const first = await visit({ label: "second-first", customer, day: 0 });
      const second = await visit({ label: "second-second", customer, day: 59 });

      await settle(at);

      expect(await outcomesOf(campaignId)).toEqual([
        [first.reservationId, "condition-failed", null],
        [second.reservationId, "sent", null],
      ]);
      expect(mailed()).toEqual([emailOf(customer)]);
      const runs = await runsOf(campaignId);
      expect(await claimHolders(campaignId)).toEqual([
        requireValue(runs[1]).id,
      ]);
    });

    test("a first visit alone sends nothing", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("first-only");
      const only = await visit({ label: "first-only", customer, day: 0 });

      await settle(at);

      expect(await outcomesOf(campaignId)).toEqual([
        [only.reservationId, "condition-failed", null],
      ]);
      expect(requests()).toEqual([]);
      expect(await claimHolders(campaignId)).toEqual([]);
    });

    test("an overnight Reserved Desk stay before a paid day visit doesn't count", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("overnight");
      const overnight = await visit({
        label: "overnight-stay",
        customer,
        day: 0,
        overnight: true,
      });
      const day = await visit({ label: "overnight-day", customer, day: 3 });

      await settle(at);

      // The overnight finish starts no run; the day visit's run counts one visit.
      expect(await dispositions(campaignId)).toEqual({
        [finishedKey(day.reservationId)]: "started",
      });
      expect(
        (await read.receipts(campaignId)).map((receipt) => receipt.dedup_key)
      ).not.toContain(finishedKey(overnight.reservationId));
      expect(await outcomesOf(campaignId)).toEqual([
        [day.reservationId, "condition-failed", null],
      ]);
      expect(requests()).toEqual([]);
    });

    test("an Entry-pack-funded visit before a paid day visit doesn't count", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("entry-funded");
      await visit({
        label: "entry-funded-pack",
        customer,
        day: 0,
        payment: "entry-pack",
      });
      const paid = await visit({
        label: "entry-funded-paid",
        customer,
        day: 3,
      });

      await settle(at);

      expect(await dispositions(campaignId)).toEqual({
        [finishedKey(paid.reservationId)]: "started",
      });
      expect(await outcomesOf(campaignId)).toEqual([
        [paid.reservationId, "condition-failed", null],
      ]);
      expect(requests()).toEqual([]);
    });

    test("paid day visits 61 days apart send nothing", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("far-apart");
      const first = await visit({ label: "far-first", customer, day: 0 });
      const second = await visit({ label: "far-second", customer, day: 61 });

      await settle(at);

      expect(await outcomesOf(campaignId)).toEqual([
        [first.reservationId, "condition-failed", null],
        [second.reservationId, "condition-failed", null],
      ]);
      expect(requests()).toEqual([]);
    });

    test("a third qualifying visit after the email never sends again", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("third-visit");
      const first = await visit({ label: "third-first", customer, day: 0 });
      const second = await visit({ label: "third-second", customer, day: 2 });
      const third = await visit({ label: "third-third", customer, day: 4 });

      await settle(at);

      expect(await outcomesOf(campaignId)).toEqual([
        [first.reservationId, "condition-failed", null],
        [second.reservationId, "sent", null],
        [third.reservationId, "skipped", "already-sent-once"],
      ]);
      expect(mailed()).toEqual([emailOf(customer)]);
    });

    test("two qualifying finishes one intake takes together send exactly once", async () => {
      const { campaignId } = await begin();
      const customer = await fixtures.addCustomer("one-intake");
      const first = await visit({
        label: "one-intake-first",
        customer,
        day: 0,
      });
      const second = await visit({
        label: "one-intake-second",
        customer,
        day: 1,
      });

      // The engine first runs once both visits have finished.
      await settle(second.endsAt.add({ minutes: 5 }));

      const { rows: finishes } = await pool.query<{ id: string }>(
        "select id from customer_events where kind = 'reservation-finished' and workspace_reservation_id = any($1)",
        [[first.reservationId, second.reservationId]]
      );
      const { rows: intakes } = await pool.query<{ eventIds: string[] }>(
        `select subject->'eventIds' as "eventIds" from email_campaign_automation_work_units
          where kind = 'intake' and subject->'eventIds' ?| $1`,
        [finishes.map((event) => event.id)]
      );
      // One intake unit took both finishes.
      expect(finishes).toHaveLength(2);
      expect(intakes).toHaveLength(1);
      expect(requireValue(intakes[0]).eventIds).toEqual(
        expect.arrayContaining(finishes.map((event) => event.id))
      );
      expect(await dispositions(campaignId)).toEqual({
        [finishedKey(first.reservationId)]: "started",
        [finishedKey(second.reservationId)]: "already-active",
      });
      expect(await outcomesOf(campaignId)).toEqual([
        [first.reservationId, "sent", null],
      ]);
      expect(mailed()).toEqual([emailOf(customer)]);
    });

    test("qualifying and non-qualifying finishes one intake takes together start runs only for the qualifying visit", async () => {
      const { campaignId } = await begin();
      const paid = await fixtures.addCustomer("mixed-paid");
      const packed = await fixtures.addCustomer("mixed-entry-pack");
      const stayed = await fixtures.addCustomer("mixed-overnight");
      const day = await visit({
        label: "mixed-paid-day",
        customer: paid,
        day: 1,
      });
      const pack = await visit({
        label: "mixed-pack-day",
        customer: packed,
        day: 1,
        payment: "entry-pack",
      });
      const overnight = await visit({
        label: "mixed-overnight",
        customer: stayed,
        day: 0,
        overnight: true,
      });

      // The engine first runs once all three visits have finished.
      await settle(day.endsAt.add({ minutes: 5 }));

      const { rows: finishes } = await pool.query<{
        id: string;
        reservation: WorkspaceReservationId;
        processed: boolean;
      }>(
        `select id, workspace_reservation_id as reservation, automation_processed_at is not null as processed
          from customer_events where kind = 'reservation-finished' and workspace_reservation_id = any($1)`,
        [[day.reservationId, pack.reservationId, overnight.reservationId]]
      );
      const finishOf = (reservationId: WorkspaceReservationId) =>
        requireValue(
          finishes.find((event) => event.reservation === reservationId)
        ).id;
      const { rows: intakes } = await pool.query<{ eventIds: string[] }>(
        `select subject->'eventIds' as "eventIds" from email_campaign_automation_work_units
          where kind = 'intake' and subject->'eventIds' ?| $1`,
        [finishes.map((event) => event.id)]
      );
      // Matching rules the Entry-pack visit out in SQL; one intake unit took
      // the day visit and the overnight stay, whose visit it judges.
      expect(finishes.map((event) => event.processed)).toEqual([
        true,
        true,
        true,
      ]);
      expect(intakes).toHaveLength(1);
      expect(requireValue(intakes[0]).eventIds.toSorted()).toEqual(
        [
          finishOf(day.reservationId),
          finishOf(overnight.reservationId),
        ].toSorted()
      );
      expect(await dispositions(campaignId)).toEqual({
        [finishedKey(day.reservationId)]: "started",
      });
      expect(await outcomesOf(campaignId)).toEqual([
        [day.reservationId, "condition-failed", null],
      ]);
      expect(requests()).toEqual([]);
    });

    test("a one-off campaign email five days before the second visit defers the send 14 Prague days, sent on the first tick after", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("one-off-gap");
      await visit({ label: "gap-first", customer, day: 0 });
      const second = await visit({ label: "gap-second", customer, day: 10 });
      const deliveredAt = pragueAt(today.add({ days: 5 }), "10:00");
      await fixtures.deliverOneOffCampaign({ customer, at: deliveredAt });
      const gapEnd = deliveredAt
        .toZonedDateTimeISO(prague)
        .add({ days: 14 })
        .toInstant();

      await settle(at, second.endsAt.add({ hours: 1 }));

      const [, deferred] = await runsOf(campaignId);
      expect(deferred).toMatchObject({
        reservation: second.reservationId,
        status: "active",
        dueAt: gapEnd.toString(),
      });
      expect(requests()).toEqual([]);

      const progress = await scenario.runUntil({
        from: second.endsAt.add({ hours: 1 }),
        until: gapEnd.add({ hours: 24 }),
        onTicks: true,
        settled: async () =>
          (await read.runs(campaignId)).every((run) => run.status === "ended"),
      });
      latest = progress.at;

      expect(progress.settled).toBe(true);
      expect(progress.at.toString()).toBe(gapEnd.toString());
      expect((await runsOf(campaignId))[1]).toMatchObject({
        status: "ended",
        outcome: "sent",
      });
      expect(
        (await read.sends(campaignId)).map((send) => iso(send.created_at))
      ).toEqual([gapEnd.toString()]);
      expect(mailed()).toEqual([emailOf(customer)]);
    });

    test("a pass acquired while the one-off campaign gap defers the send skips the customer at the due tick, with no request", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("gap-pass");
      await visit({ label: "gap-pass-first", customer, day: 0 });
      const second = await visit({
        label: "gap-pass-second",
        customer,
        day: 10,
      });
      const deliveredAt = pragueAt(today.add({ days: 5 }), "10:00");
      await fixtures.deliverOneOffCampaign({ customer, at: deliveredAt });
      const gapEnd = deliveredAt
        .toZonedDateTimeISO(prague)
        .add({ days: 14 })
        .toInstant();

      await settle(at, second.endsAt.add({ hours: 1 }));

      expect((await runsOf(campaignId))[1]).toMatchObject({
        reservation: second.reservationId,
        status: "active",
        dueAt: gapEnd.toString(),
      });
      await fixtures.holdPass({
        customer,
        kind: "entry-pack",
        validFrom: today.add({ days: 12 }).toString(),
        validUntil: today.add({ days: 60 }).toString(),
      });

      const progress = await scenario.runUntil({
        from: second.endsAt.add({ hours: 1 }),
        until: gapEnd.add({ hours: 24 }),
        onTicks: true,
        settled: async () =>
          (await read.runs(campaignId)).every((run) => run.status === "ended"),
      });
      latest = progress.at;

      expect(progress.settled).toBe(true);
      expect(progress.at.toString()).toBe(gapEnd.toString());
      expect((await outcomesOf(campaignId))[1]).toEqual([
        second.reservationId,
        "skipped",
        "pass-holder",
      ]);
      expect(requests()).toEqual([]);
      expect(await claimHolders(campaignId)).toEqual([]);
    });

    test("consent withdrawn before the email is submitted skips the customer", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("consent-withdrawn");
      await visit({ label: "consent-first", customer, day: 0 });
      const second = await visit({ label: "consent-second", customer, day: 2 });
      beforeGuard(campaignId, () =>
        pool.query(
          "update customer_marketing_consents set withdrawn_at = $2 where dotypos_customer_id = $1",
          [customer, second.endsAt.toString()]
        )
      );

      await settle(at);

      expect((await outcomesOf(campaignId))[1]).toEqual([
        second.reservationId,
        "skipped",
        "consent-withdrawn",
      ]);
      expect(requests()).toEqual([]);
      expect(await claimHolders(campaignId)).toEqual([]);
    });

    test.each([
      ["a usable Entry pack", "entry-pack", 2, 4],
      ["an active Unlimited pass", "unlimited", 2, 4],
      ["an upcoming Unlimited pass", "unlimited", 3, 4],
    ] as const)(
      "%s acquired before the email is submitted skips the customer, and a qualifying visit after it ends sends",
      async (_, kind, from, until) => {
        const { at, campaignId } = await begin();
        const customer = await fixtures.addCustomer(`pass-${kind}-${from}`);
        await visit({ label: `pass-${kind}-${from}-first`, customer, day: 0 });
        const second = await visit({
          label: `pass-${kind}-${from}-second`,
          customer,
          day: 2,
        });
        const later = await visit({
          label: `pass-${kind}-${from}-later`,
          customer,
          day: 6,
        });
        beforeGuard(campaignId, () =>
          fixtures.holdPass({
            customer,
            kind,
            validFrom: today.add({ days: from }).toString(),
            validUntil: today.add({ days: until }).toString(),
          })
        );

        await settle(at, second.endsAt.add({ hours: 1 }));

        expect((await outcomesOf(campaignId))[1]).toEqual([
          second.reservationId,
          "skipped",
          "pass-holder",
        ]);
        expect(requests()).toEqual([]);
        expect(await claimHolders(campaignId)).toEqual([]);

        await settle(second.endsAt.add({ hours: 1 }));

        const runs = await runsOf(campaignId);
        expect(runs[2]).toMatchObject({
          reservation: later.reservationId,
          outcome: "sent",
        });
        expect(mailed()).toEqual([emailOf(customer)]);
        expect(await claimHolders(campaignId)).toEqual([
          requireValue(runs[2]).id,
        ]);
      }
    );

    test("an email the provider may have taken keeps the claim, so a later qualifying visit never sends", async () => {
      const { at, campaignId } = await begin();
      const customer = await fixtures.addCustomer("uncertain");
      await visit({ label: "uncertain-first", customer, day: 0 });
      const second = await visit({
        label: "uncertain-second",
        customer,
        day: 2,
      });
      const later = await visit({ label: "uncertain-later", customer, day: 4 });

      await settle(at, second.endsAt.subtract({ minutes: 1 }));
      const finishedAt = second.endsAt.add({ minutes: 1 });
      // The sweep records the finish, then intake and the condition run.
      await scenario.planUntilQueued(finishedAt, "deliver");
      await scenario.planUntilQueued(finishedAt, "deliver");
      scenario.resend.respondWith(() => "accept-hang");
      await scenario.killDuringRequest(finishedAt);
      await scenario.drain(finishedAt);
      scenario.resend.respondWith(() => "accept");
      // The replay can't reproduce the payload the provider may have taken.
      scenario.dotypos.customers.set(customer, {
        ...requireValue(scenario.dotypos.customers.get(customer)),
        email: testEmailAddress(`${customer.slice(-40)}-moved`),
      });

      await settle(finishedAt, second.endsAt.add({ hours: 6 }));

      const uncertain = requireValue((await runsOf(campaignId))[1]);
      expect(uncertain).toMatchObject({
        reservation: second.reservationId,
        status: "ended",
        outcome: "unconfirmed",
      });
      expect(await claimHolders(campaignId)).toEqual([uncertain.id]);

      await settle(second.endsAt.add({ hours: 6 }));

      expect((await outcomesOf(campaignId))[2]).toEqual([
        later.reservationId,
        "skipped",
        "already-sent-once",
      ]);
      expect(requests().map((request) => request.to)).toEqual([
        [emailOf(customer)],
      ]);
      expect(await claimHolders(campaignId)).toEqual([uncertain.id]);
    });
  }
);
