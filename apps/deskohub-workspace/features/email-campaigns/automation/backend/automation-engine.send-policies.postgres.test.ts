import "@/shared/testing/workspace-test-env";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { mapSupportedLocales } from "@deskohub/i18n/locale-registry";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Schema } from "effect";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { temporalInstantToIsoString } from "@/shared/utils/temporal";
import { seedPublishedEmail } from "../../backend/email-campaigns.test-utils";
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
  "automation_send_policies"
);
afterAll(() => database?.close());

const decodeSendPolicyRun = Schema.decodeUnknownSync(
  Schema.Struct({
    id: automationRunIdSchema,
    dotypos_customer_id: DotyposCustomerIdSchema,
    status: Schema.String,
    phase: Schema.NullOr(Schema.String),
    outcome: Schema.NullOr(Schema.String),
    outcome_reason: Schema.NullOr(Schema.String),
    due_at: Schema.NullOr(Schema.Union([Schema.Date, Schema.String])),
  })
);

describe.skipIf(!database)(
  "a Send's delivery policies end to end",
  async () => {
    if (!database) return;
    /** Tuesday 20 October 2026, 10:00 in Prague. */
    const start = Temporal.Instant.from("2026-10-20T08:00:00Z");
    const { pool } = database;

    type SendPolicies = {
      readonly oncePerCustomer?: true;
      readonly oneOffCampaignGap?: { readonly days: number };
      readonly skipPassHolders?: true;
    };

    /** "When `trigger` happens, send with `policies`." */
    const policyFlow = (
      policies: SendPolicies,
      trigger: "ReservationBooked" | "AccountCreated" = "AccountCreated"
    ) =>
      automationFlowFixture({
        trigger: { _tag: trigger },
        steps: [{ _tag: "Send", id: "send", ...policies }],
      });

    const scenario = await makeAutomationEngineScenario({
      database,
      now: start,
      deploymentEnvironment: "development",
    });
    const { fixtures, kit, read } = scenario;
    const emailOf = (customer: DotyposCustomerId) =>
      testEmailAddress(customer.slice(-48));

    // The Resend fake lives as long as the scenario; tests read their own share.
    const seen = { requests: 0, mailed: 0 };
    const requests = () => scenario.resend.requests().slice(seen.requests);
    const mailed = () => scenario.resend.mailed().slice(seen.mailed);

    beforeEach(async () => {
      await scenario.prepare(start);
      seen.requests = scenario.resend.requests().length;
      seen.mailed = scenario.resend.mailed().length;
    });
    // Nothing a test leaves active can plan work in the next one.
    afterEach(async () => {
      scenario.resend.respondWith(() => "accept");
      scenario.dotypos.onRequest(undefined);
      for (const campaignId of kit.campaignIds) {
        const automation = await read.automation(campaignId);
        if (
          automation?.status === "active" ||
          automation?.status === "paused"
        ) {
          await scenario.lifecycle(
            (lifecycle) => lifecycle.archive(campaignId),
            start.add({ hours: 60 * 24 })
          );
        }
      }
    });
    afterAll(() => scenario.cleanup());

    const iso = (value: Date | string | null | undefined) =>
      databaseInstant(value)?.toString() ?? null;

    /** An instant as timeline details store it. */
    const stored = (instant: string) =>
      temporalInstantToIsoString(Temporal.Instant.from(instant));

    /** The campaign's runs in the order they started. */
    const runsOf = async (campaignId: CampaignId) =>
      (await read.runs(campaignId)).map((row) => {
        const run = decodeSendPolicyRun(row);
        return {
          id: run.id,
          customer: run.dotypos_customer_id,
          status: run.status,
          phase: run.phase,
          outcome: run.outcome,
          reason: run.outcome_reason,
          dueAt: iso(run.due_at),
        };
      });

    const claimsOf = async (campaignId: CampaignId) =>
      (await read.claims(campaignId)).map((claim) => ({
        customer: claim.dotypos_customer_id,
        runId: claim.run_id,
      }));

    const timelineOf = async (runId: string) =>
      (await read.timeline(runId)).map((entry) => ({
        kind: entry.kind,
        detail: entry.detail,
      }));

    const deliverUnits = async (campaignId: CampaignId) =>
      (await read.units(campaignId)).filter((unit) => unit.kind === "deliver");

    /** `customer`'s visit two days ahead, booked at `at`. */
    const book = async (
      customer: DotyposCustomerId,
      label: string,
      at: Temporal.Instant
    ) => {
      const reservation = await fixtures.book({
        label,
        customer,
        startsAt: at.add({ hours: 48 }),
        endsAt: at.add({ hours: 50 }),
      });
      await fixtures.recordEvent({
        kind: "reservation-booked",
        customer,
        occurredAt: at,
        reservationId: reservation,
      });
      return reservation;
    };

    /** A consenting customer whose account was created at `at`. */
    const signUp = async (label: string, at: Temporal.Instant) => {
      const customer = await fixtures.addCustomer(label);
      await fixtures.recordEvent({
        kind: "account-created",
        customer,
        occurredAt: at,
      });
      return customer;
    };

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

    describe("once per customer", () => {
      const onceFlow = policyFlow(
        { oncePerCustomer: true },
        "ReservationBooked"
      );

      test("a later run of a customer who was sent the email ends skipped, and the claim admits no second holder", async () => {
        const { campaignId } = await kit.seedActive(onceFlow, { at: start });
        const customer = await fixtures.addCustomer("once-sent");
        await book(customer, "once-sent-first", start);
        await scenario.tick(start.add({ minutes: 1 }));
        // The next visit is booked once the first email went out, and enters
        // on the next tick.
        await book(customer, "once-sent-second", start.add({ hours: 1 }));
        await scenario.tick(start.add({ hours: 1, minutes: 1 }));

        const [first, second] = await runsOf(campaignId);
        expect([first, second]).toMatchObject([
          { status: "ended", outcome: "sent", reason: null },
          { status: "ended", outcome: "skipped", reason: "already-sent-once" },
        ]);
        const firstRun = requireValue(first, "first run");
        const secondRun = requireValue(second, "second run");
        expect(await timelineOf(secondRun.id)).toContainEqual({
          kind: "skipped",
          detail: { reason: "already-sent-once" },
        });
        expect(mailed()).toEqual([emailOf(customer)]);
        expect(await claimsOf(campaignId)).toEqual([
          { customer, runId: firstRun.id },
        ]);
        // The skipped run never held a recipient.
        expect(
          (await read.recipients(campaignId)).map((r) => r.dotypos_customer_id)
        ).toEqual([customer]);

        await expect(
          pool.query(
            "insert into email_campaign_automation_customer_claims (campaign_id, dotypos_customer_id, run_id) values ($1, $2, $3)",
            [campaignId, customer, secondRun.id]
          )
        ).rejects.toThrow(/duplicate key/);
      });

      test("enabling the policy on a later version skips a customer an earlier version already sent", async () => {
        const plainFlow = policyFlow({}, "ReservationBooked");
        const { campaignId } = await kit.seedActive(plainFlow, { at: start });
        const customer = await fixtures.addCustomer("once-later-version");
        await book(customer, "once-later-version-first", start);
        await scenario.tick(start.add({ minutes: 1 }));
        const [first] = await runsOf(campaignId);
        expect(first).toMatchObject({ status: "ended", outcome: "sent" });
        // Every send claims, with the policy or not.
        expect(await claimsOf(campaignId)).toEqual([
          { customer, runId: requireValue(first, "first run").id },
        ]);
        // As a run from before claims existed, it holds none.
        await pool.query(
          "delete from email_campaign_automation_customer_claims where campaign_id = $1",
          [campaignId]
        );

        await scenario.lifecycle(
          (lifecycle) => lifecycle.updateFlow({ campaignId, flow: onceFlow }),
          start.add({ minutes: 5 })
        );
        const previewId = await kit.seedPreview(campaignId, {
          status: "completed",
        });
        await scenario.lifecycle(
          (lifecycle) =>
            lifecycle.activate({ campaignId, previewId, activatedBy: null }),
          start.add({ minutes: 5 })
        );
        await book(
          customer,
          "once-later-version-second",
          start.add({ hours: 1 })
        );
        await scenario.tick(start.add({ hours: 1, minutes: 1 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "sent" },
          { status: "ended", outcome: "skipped", reason: "already-sent-once" },
        ]);
        expect(mailed()).toEqual([emailOf(customer)]);
        expect(await claimsOf(campaignId)).toEqual([]);
      });

      test("a claim another run commits while the unit reads Dotypos skips the run without a send", async () => {
        const { campaignId } = await kit.seedActive(onceFlow, { at: start });
        const customer = await fixtures.addCustomer("once-raced");
        await book(customer, "once-raced-first", start);
        await scenario.tick(start.add({ minutes: 1 }));
        const [sent] = await runsOf(campaignId);
        // Released as if that run had failed, then retaken by it mid-fetch
        // of the next run's deliver unit.
        await pool.query(
          "delete from email_campaign_automation_customer_claims where campaign_id = $1",
          [campaignId]
        );
        let retaken = false;
        scenario.dotypos.onRequest(({ method }) =>
          method !== "getCustomersByIds" || retaken
            ? Effect.void
            : Effect.promise(async () => {
                retaken = true;
                await pool.query(
                  "insert into email_campaign_automation_customer_claims (campaign_id, dotypos_customer_id, run_id) values ($1, $2, $3)",
                  [campaignId, customer, requireValue(sent, "sent run").id]
                );
              })
        );

        await book(customer, "once-raced-second", start.add({ hours: 1 }));
        await scenario.tick(start.add({ hours: 1, minutes: 1 }));

        expect(retaken).toBe(true);
        expect((await runsOf(campaignId)).map((run) => run.reason)).toEqual([
          null,
          "already-sent-once",
        ]);
        expect(mailed()).toEqual([emailOf(customer)]);
        expect(await read.sends(campaignId)).toHaveLength(1);
      });

      test("a claim another transaction commits after the verdict loses the send its insert", async () => {
        const { campaignId } = await kit.seedActive(onceFlow, { at: start });
        const customer = await fixtures.addCustomer("once-conflict");
        await book(customer, "once-conflict-first", start);
        await scenario.tick(start.add({ minutes: 1 }));
        const [sent] = await runsOf(campaignId);
        // The blocker below stands in for a concurrent run of the campaign,
        // so the verdict's read of earlier runs mustn't see the first one.
        await pool.query(
          "delete from email_campaign_automation_customer_claims where campaign_id = $1",
          [campaignId]
        );
        await pool.query(
          "update email_campaign_automation_runs set send_id = null where id = $1",
          [requireValue(sent, "sent run").id]
        );
        // Mid-fetch, another transaction takes the claim and holds it
        // uncommitted: the commit's verdict can't see it, and its claim
        // insert waits on it.
        const blocker = await pool.connect();
        let blockerPid: number | undefined;
        scenario.dotypos.onRequest(({ method }) =>
          method !== "getCustomersByIds" || blockerPid !== undefined
            ? Effect.void
            : Effect.promise(async () => {
                await blocker.query("begin");
                await blocker.query(
                  "insert into email_campaign_automation_customer_claims (campaign_id, dotypos_customer_id, run_id) values ($1, $2, $3)",
                  [campaignId, customer, requireValue(sent, "sent run").id]
                );
                const { rows } = await blocker.query(
                  "select pg_backend_pid() as pid"
                );
                blockerPid = rows[0].pid;
              })
        );

        try {
          await book(customer, "once-conflict-second", start.add({ hours: 1 }));
          const ticked = scenario.tick(start.add({ hours: 1, minutes: 1 }));
          const waitsOnBlocker = async () =>
            blockerPid !== undefined &&
            (
              await pool.query(
                "select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
                [blockerPid]
              )
            ).rows.length > 0;
          const deadline = Date.now() + 20_000;
          while (!(await waitsOnBlocker())) {
            if (Date.now() > deadline)
              throw new Error("The commit never waited on the held claim.");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await blocker.query("commit");
          await ticked;
        } finally {
          await blocker.query("rollback").catch(() => undefined);
          blocker.release();
        }

        expect((await runsOf(campaignId)).map((run) => run.reason)).toEqual([
          null,
          "already-sent-once",
        ]);
        expect(mailed()).toEqual([emailOf(customer)]);
        expect(await read.sends(campaignId)).toHaveLength(1);
        expect(await claimsOf(campaignId)).toEqual([
          { customer, runId: requireValue(sent, "sent run").id },
        ]);
      });

      test("an email the provider may have taken keeps the claim, so the next run is skipped", async () => {
        const { campaignId } = await kit.seedActive(onceFlow, { at: start });
        const customer = await fixtures.addCustomer("once-uncertain");
        await book(customer, "once-uncertain-first", start);
        scenario.resend.respondWith(() => "accept-hang");
        await scenario.killDuringRequest(start.add({ minutes: 1 }));
        await scenario.drain(start.add({ minutes: 1 }));
        scenario.resend.respondWith(() => "accept");
        // The replay can't reproduce the payload the provider may have taken.
        scenario.dotypos.customers.set(customer, {
          ...requireValue(
            scenario.dotypos.customers.get(customer),
            `profile for ${customer}`
          ),
          email: testEmailAddress(`${customer.slice(-40)}-moved`),
        });
        await scenario.tick(start.add({ minutes: 10 }));

        const [uncertain] = await runsOf(campaignId);
        expect(uncertain).toMatchObject({
          status: "ended",
          outcome: "unconfirmed",
        });
        expect(await claimsOf(campaignId)).toEqual([
          { customer, runId: requireValue(uncertain, "uncertain run").id },
        ]);

        await book(customer, "once-uncertain-second", start.add({ hours: 1 }));
        await scenario.tick(start.add({ hours: 1, minutes: 1 }));

        expect((await runsOf(campaignId)).map((run) => run.reason)).toEqual([
          null,
          "already-sent-once",
        ]);
        expect(requests().map((request) => request.to)).toEqual([
          [emailOf(customer)],
        ]);
      });

      test("an email the provider refused releases the claim, so the next run sends", async () => {
        const { campaignId } = await kit.seedActive(onceFlow, { at: start });
        const customer = await fixtures.addCustomer("once-refused");
        await book(customer, "once-refused-first", start);
        scenario.resend.respondWith(() => "refuse");
        await scenario.tick(start.add({ minutes: 1 }));
        scenario.resend.respondWith(() => "accept");

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "failed", reason: "delivery-refused" },
        ]);
        expect(await claimsOf(campaignId)).toEqual([]);

        await book(customer, "once-refused-second", start.add({ hours: 1 }));
        await scenario.tick(start.add({ hours: 1, minutes: 1 }));

        const runs = await runsOf(campaignId);
        expect(runs.map((run) => run.outcome)).toEqual(["failed", "sent"]);
        expect(await claimsOf(campaignId)).toEqual([
          { customer, runId: requireValue(runs[1], "second run").id },
        ]);
        expect(mailed()).toEqual([emailOf(customer)]);
      });

      test("a skipped attempt releases the claim, so the next run sends", async () => {
        const { campaignId } = await kit.seedActive(onceFlow, { at: start });
        const customer = await fixtures.addCustomer("once-skipped", {
          profile: { email: undefined },
        });
        await book(customer, "once-skipped-first", start);
        await scenario.tick(start.add({ minutes: 1 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "skipped", reason: "missing-email" },
        ]);
        expect(await claimsOf(campaignId)).toEqual([]);

        scenario.dotypos.customers.set(customer, {
          ...requireValue(
            scenario.dotypos.customers.get(customer),
            `profile for ${customer}`
          ),
          email: emailOf(customer),
        });
        await book(customer, "once-skipped-second", start.add({ hours: 1 }));
        await scenario.tick(start.add({ hours: 1, minutes: 1 }));

        expect((await runsOf(campaignId)).map((run) => run.outcome)).toEqual([
          "skipped",
          "sent",
        ]);
        expect(mailed()).toEqual([emailOf(customer)]);
      });
    });

    describe("one-off campaign gap", () => {
      const gapFlow = policyFlow({ oneOffCampaignGap: { days: 14 } });

      /** Ticks until every run of `campaignId` has ended, on the cron's ticks. */
      const settleRuns = (
        campaignId: CampaignId,
        from: Temporal.Instant,
        until: Temporal.Instant
      ) =>
        scenario.runUntil({
          from,
          until,
          onTicks: true,
          settled: async () => {
            const runs = await read.runs(campaignId);
            return (
              runs.length > 0 && runs.every((run) => run.status === "ended")
            );
          },
        });

      test("a one-off email five days earlier defers the send to 14 Prague days after it, sent on that tick", async () => {
        const { campaignId } = await kit.seedActive(gapFlow, { at: start });
        const customer = await fixtures.addCustomer("gap-marketing");
        // Thursday 15 October, 10:00 in Prague (summer time).
        await fixtures.deliverOneOffCampaign({
          customer,
          at: Temporal.Instant.from("2026-10-15T08:00:00Z"),
        });
        await fixtures.recordEvent({
          kind: "account-created",
          customer,
          occurredAt: start,
        });
        await scenario.tick(start.add({ minutes: 1 }));

        // 29 October, 10:00 in Prague, is in winter time.
        const gapEnd = "2026-10-29T09:00:00Z";
        const [run] = await runsOf(campaignId);
        expect(run).toMatchObject({
          status: "active",
          phase: "waiting",
          dueAt: gapEnd,
        });
        expect(
          await timelineOf(requireValue(run, "campaign run").id)
        ).toContainEqual({
          kind: "deferred",
          detail: {
            cause: "one-off-campaign-gap",
            recheckAt: stored(gapEnd),
          },
        });
        expect(requests()).toEqual([]);

        const progress = await settleRuns(
          campaignId,
          start.add({ minutes: 5 }),
          start.add({ hours: 12 * 24 })
        );

        expect(progress.settled).toBe(true);
        // The gap ends at the tick itself, so that tick sends.
        expect(progress.at.toString()).toBe(gapEnd);
        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "sent" },
        ]);
        expect(
          (await read.sends(campaignId)).map((send) => iso(send.created_at))
        ).toEqual([gapEnd]);
        expect(mailed()).toEqual([emailOf(customer)]);
      });

      test("another one-off email during the deferral defers the send again at its recheck", async () => {
        const { campaignId } = await kit.seedActive(gapFlow, { at: start });
        const customer = await fixtures.addCustomer("gap-again");
        await fixtures.deliverOneOffCampaign({
          customer,
          at: Temporal.Instant.from("2026-10-15T08:00:00Z"),
        });
        await fixtures.recordEvent({
          kind: "account-created",
          customer,
          occurredAt: start,
        });
        await scenario.tick(start.add({ minutes: 1 }));
        // Thursday 22 October, 10:00 in Prague.
        await fixtures.deliverOneOffCampaign({
          customer,
          at: Temporal.Instant.from("2026-10-22T08:00:00Z"),
        });

        await scenario.runUntil({
          from: Temporal.Instant.from("2026-10-29T09:00:00Z"),
          until: Temporal.Instant.from("2026-10-29T09:00:00Z"),
          onTicks: true,
        });

        const [run] = await runsOf(campaignId);
        expect(run).toMatchObject({
          status: "active",
          phase: "waiting",
          dueAt: "2026-11-05T09:00:00Z",
        });
        expect(
          (await timelineOf(requireValue(run, "campaign run").id))
            .filter((entry) => entry.kind === "deferred")
            .map((entry) => entry.detail)
        ).toEqual([
          {
            cause: "one-off-campaign-gap",
            recheckAt: stored("2026-10-29T09:00:00Z"),
          },
          {
            cause: "one-off-campaign-gap",
            recheckAt: stored("2026-11-05T09:00:00Z"),
          },
        ]);

        const progress = await settleRuns(
          campaignId,
          Temporal.Instant.from("2026-10-29T09:05:00Z"),
          Temporal.Instant.from("2026-11-06T00:00:00Z")
        );
        expect(progress.at.toString()).toBe("2026-11-05T09:00:00Z");
        expect(mailed()).toEqual([emailOf(customer)]);
      });

      test("an operational one-off email defers the send too", async () => {
        const { campaignId } = await kit.seedActive(gapFlow, { at: start });
        const customer = await fixtures.addCustomer("gap-operational");
        await fixtures.deliverOneOffCampaign({
          customer,
          purpose: "operational",
          at: Temporal.Instant.from("2026-10-15T08:00:00Z"),
        });
        await fixtures.recordEvent({
          kind: "account-created",
          customer,
          occurredAt: start,
        });
        await scenario.tick(start.add({ minutes: 1 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "active", dueAt: "2026-10-29T09:00:00Z" },
        ]);
        expect(requests()).toEqual([]);
      });

      test("a one-off email older than the gap, or one that never reached the customer, doesn't hold the send", async () => {
        const { campaignId } = await kit.seedActive(gapFlow, { at: start });
        const lapsed = await fixtures.addCustomer("gap-lapsed");
        const refused = await fixtures.addCustomer("gap-refused");
        // Exactly 14 Prague days before the send tick.
        await fixtures.deliverOneOffCampaign({
          customer: lapsed,
          at: Temporal.Instant.from("2026-10-06T08:00:00Z"),
        });
        await fixtures.deliverOneOffCampaign({
          customer: refused,
          status: "failed",
          campaignStatus: "failed",
          at: Temporal.Instant.from("2026-10-19T08:00:00Z"),
        });
        for (const customer of [lapsed, refused]) {
          await fixtures.recordEvent({
            kind: "account-created",
            customer,
            occurredAt: start,
          });
        }
        await scenario.tick(start);

        expect(
          (await runsOf(campaignId)).map((run) => [run.status, run.outcome])
        ).toEqual([
          ["ended", "sent"],
          ["ended", "sent"],
        ]);
      });

      test("a one-off email in flight in a requested batch defers the send to the next recheck, then to its gap", async () => {
        const { campaignId } = await kit.seedActive(gapFlow, { at: start });
        const customer = await fixtures.addCustomer("gap-in-flight");
        const oneOff = await fixtures.deliverOneOffCampaign({
          customer,
          status: "pending",
          at: start.subtract({ hours: 1 }),
        });
        await fixtures.recordEvent({
          kind: "account-created",
          customer,
          occurredAt: start,
        });
        await scenario.tick(start.add({ minutes: 1 }));

        const recheck = start.add({ minutes: 15 }).toString();
        const [run] = await runsOf(campaignId);
        expect(run).toMatchObject({ phase: "waiting", dueAt: recheck });
        expect(
          await timelineOf(requireValue(run, "campaign run").id)
        ).toContainEqual({
          kind: "deferred",
          detail: {
            cause: "one-off-campaign-gap",
            recheckAt: stored(recheck),
          },
        });

        // The provider took it; the gap counts from the batch's request.
        await pool.query(
          "update email_campaign_recipients set status = 'sent', status_updated_at = $2 where send_id = $1",
          [oneOff, start.add({ minutes: 5 }).toString()]
        );
        await scenario.runUntil({
          from: start.add({ minutes: 15 }),
          until: start.add({ minutes: 15 }),
          onTicks: true,
        });

        // 20 October, 09:00 in Prague, plus 14 days is 3 November, 09:00 CET.
        expect(await runsOf(campaignId)).toMatchObject([
          { phase: "waiting", dueAt: "2026-11-03T08:00:00Z" },
        ]);
        expect(requests()).toEqual([]);
      });
    });

    describe("skipping pass holders", () => {
      const guardedFlow = policyFlow({
        skipPassHolders: true,
        oncePerCustomer: true,
      });

      test("consent withdrawn after the batch was persisted skips the customer at the guard, with no request", async () => {
        const { campaignId } = await kit.seedActive(guardedFlow, { at: start });
        const customer = await signUp("guard-consent", start);
        beforeGuard(campaignId, () =>
          pool.query(
            "update customer_marketing_consents set withdrawn_at = $2 where dotypos_customer_id = $1",
            [customer, start.add({ minutes: 1 }).toString()]
          )
        );
        await scenario.tick(start.add({ minutes: 1 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "skipped", reason: "consent-withdrawn" },
        ]);
        expect(
          (await read.recipients(campaignId)).map((r) => [
            r.status,
            r.skip_reason,
          ])
        ).toEqual([["skipped", "consent-withdrawn"]]);
        expect(requests()).toEqual([]);
        expect(await claimsOf(campaignId)).toEqual([]);
      });

      test("an operational Send rechecks marketing consent too: withdrawn consent skips the customer at the guard", async () => {
        // The version pins the purpose the draft had at activation.
        const { campaignId } = await kit.seedDraft({ flow: guardedFlow });
        await pool.query(
          "update email_campaigns set purpose = 'operational' where id = $1",
          [campaignId]
        );
        const previewId = await kit.seedPreview(campaignId, {
          status: "completed",
        });
        await scenario.lifecycle(
          (lifecycle) =>
            lifecycle.activate({ campaignId, previewId, activatedBy: null }),
          start
        );
        const { rows: versions } = await pool.query(
          "select purpose from email_campaign_automation_versions where campaign_id = $1",
          [campaignId]
        );
        expect(versions).toEqual([{ purpose: "operational" }]);
        const customer = await signUp("guard-operational-consent", start);
        beforeGuard(campaignId, () =>
          pool.query(
            "update customer_marketing_consents set withdrawn_at = $2 where dotypos_customer_id = $1",
            [customer, start.add({ minutes: 1 }).toString()]
          )
        );
        await scenario.tick(start.add({ minutes: 1 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "skipped", reason: "consent-withdrawn" },
        ]);
        expect(requests()).toEqual([]);
        expect(await claimsOf(campaignId)).toEqual([]);
      });

      test("an Entry pack acquired before the request skips the customer as a pass holder and releases the claim", async () => {
        const { campaignId } = await kit.seedActive(guardedFlow, { at: start });
        const customer = await signUp("guard-pack", start);
        beforeGuard(campaignId, () =>
          fixtures.holdPass({
            customer,
            kind: "entry-pack",
            validFrom: "2026-10-20",
            validUntil: "2026-12-31",
          })
        );
        await scenario.tick(start.add({ minutes: 1 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "skipped", reason: "pass-holder" },
        ]);
        expect(
          (await read.recipients(campaignId)).map((r) => [
            r.status,
            r.skip_reason,
          ])
        ).toEqual([["skipped", "pass-holder"]]);
        expect(requests()).toEqual([]);
        expect(await claimsOf(campaignId)).toEqual([]);
      });

      test("active and upcoming Unlimited passes skip their holders; an expired or used-up Entry pack doesn't", async () => {
        const { campaignId } = await kit.seedActive(guardedFlow, { at: start });
        const active = await fixtures.addCustomer("guard-unlimited-active");
        const upcoming = await fixtures.addCustomer("guard-unlimited-upcoming");
        const expired = await fixtures.addCustomer("guard-pack-expired");
        const depleted = await fixtures.addCustomer("guard-pack-depleted");
        await fixtures.holdPass({
          customer: active,
          kind: "unlimited",
          validFrom: "2026-10-10",
          validUntil: "2026-11-09",
        });
        await fixtures.holdPass({
          customer: upcoming,
          kind: "unlimited",
          validFrom: "2026-11-01",
          validUntil: "2026-12-01",
        });
        await fixtures.holdPass({
          customer: expired,
          kind: "entry-pack",
          validFrom: "2026-08-01",
          validUntil: "2026-10-01",
        });
        await fixtures.holdPass({
          customer: depleted,
          kind: "entry-pack",
          validFrom: "2026-10-01",
          validUntil: "2026-12-31",
          depleted: true,
        });
        for (const customer of [active, upcoming, expired, depleted]) {
          await fixtures.recordEvent({
            kind: "account-created",
            customer,
            occurredAt: start,
          });
        }
        await scenario.tick(start.add({ minutes: 1 }));

        const outcomes = Object.fromEntries(
          (await runsOf(campaignId)).map((run) => [
            run.customer,
            [run.outcome, run.reason],
          ])
        );
        expect(outcomes).toEqual({
          [active]: ["skipped", "pass-holder"],
          [upcoming]: ["skipped", "pass-holder"],
          [expired]: ["sent", null],
          [depleted]: ["sent", null],
        });
        expect(mailed().toSorted()).toEqual(
          [emailOf(expired), emailOf(depleted)].toSorted()
        );
        // Each customer delivered alone.
        expect(await deliverUnits(campaignId)).toHaveLength(4);
      });

      test("a guard that can't read the customer requests nothing, and the unit's retry sends", async () => {
        const { campaignId } = await kit.seedActive(guardedFlow, { at: start });
        const customer = await signUp("guard-unreadable", start);
        let failed = false;
        scenario.dotypos.onRequest(({ method }) =>
          method !== "getCustomersByIds" || failed
            ? Effect.void
            : Effect.promise(() => batchPersisted(campaignId)).pipe(
                Effect.flatMap((persisted) => {
                  if (!persisted) return Effect.void;
                  failed = true;
                  return Effect.fail(
                    new DotyposUnavailable({
                      operation: "getCustomersByIds",
                      reason: "server",
                      httpStatus: 503,
                    })
                  );
                })
              )
        );
        const first = await scenario.tick(start.add({ minutes: 1 }));

        expect(failed).toBe(true);
        expect(first.deliveries.map((delivery) => delivery.outcome)).toContain(
          "redelivered"
        );
        expect(requests()).toEqual([]);
        expect(await runsOf(campaignId)).toMatchObject([{ status: "sending" }]);

        await scenario.tick(start.add({ minutes: 3 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "sent" },
        ]);
        expect(mailed()).toEqual([emailOf(customer)]);
      });

      test("a pass acquired between a failed guard read and the unit's retry skips the customer, with no request", async () => {
        const { campaignId } = await kit.seedActive(guardedFlow, { at: start });
        const customer = await signUp("guard-retry-pack", start);
        let failed = false;
        scenario.dotypos.onRequest(({ method }) =>
          method !== "getCustomersByIds" || failed
            ? Effect.void
            : Effect.promise(() => batchPersisted(campaignId)).pipe(
                Effect.flatMap((persisted) => {
                  if (!persisted) return Effect.void;
                  failed = true;
                  return Effect.fail(
                    new DotyposUnavailable({
                      operation: "getCustomersByIds",
                      reason: "server",
                      httpStatus: 503,
                    })
                  );
                })
              )
        );
        await scenario.tick(start.add({ minutes: 1 }));
        expect(failed).toBe(true);
        expect(await runsOf(campaignId)).toMatchObject([{ status: "sending" }]);
        expect(await claimsOf(campaignId)).toHaveLength(1);

        await fixtures.holdPass({
          customer,
          kind: "entry-pack",
          validFrom: "2026-10-20",
          validUntil: "2026-12-31",
        });
        await scenario.tick(start.add({ minutes: 3 }));

        expect(await runsOf(campaignId)).toMatchObject([
          { status: "ended", outcome: "skipped", reason: "pass-holder" },
        ]);
        expect(requests()).toEqual([]);
        expect(await claimsOf(campaignId)).toEqual([]);
      });

      test("a version that froze a library email delivers that email through the guard, and still skips a pass holder", async () => {
        const subject = "Synthetic library email";
        const published = await seedPublishedEmail(database.db, {
          document: {
            purpose: "marketing",
            templateKey: "workspace",
            values: [],
            structure: [{ _tag: "Paragraph", id: "body", textKey: "body" }],
            translations: mapSupportedLocales(() => ({
              subject: [{ _tag: "Text" as const, text: subject }],
              preheader: [],
              texts: { body: [{ _tag: "Text" as const, text: "Hello" }] },
            })),
          },
        });
        // Activation freezes the version the draft links.
        const { campaignId } = await kit.seedDraft({
          flow: policyFlow({ skipPassHolders: true }),
        });
        await pool.query(
          "update email_campaigns set email_id = $2, content = '{}'::jsonb where id = $1",
          [campaignId, published.emailId]
        );
        const previewId = await kit.seedPreview(campaignId, {
          status: "completed",
        });
        await kit.run(
          kit.lifecycle((lifecycle) =>
            lifecycle.activate({ campaignId, previewId, activatedBy: null })
          ),
          start
        );
        const customer = await signUp("guard-library-email", start);
        const holder = await signUp("guard-library-holder", start);
        await fixtures.holdPass({
          customer: holder,
          kind: "entry-pack",
          validFrom: "2026-10-01",
          validUntil: "2026-12-31",
        });
        await scenario.tick(start.add({ minutes: 1 }));

        const outcomes = Object.fromEntries(
          (await runsOf(campaignId)).map((run) => [
            run.customer,
            [run.status, run.outcome, run.reason],
          ])
        );
        expect(outcomes).toEqual({
          [customer]: ["ended", "sent", null],
          [holder]: ["ended", "skipped", "pass-holder"],
        });
        expect(requests().map((request) => request.to)).toEqual([
          [emailOf(customer)],
        ]);
        expect(
          scenario.resend
            .subjects()
            .filter(
              ({ to }) => to === emailOf(customer) || to === emailOf(holder)
            )
        ).toEqual([{ to: emailOf(customer), subject }]);
      });

      test("a pass holder and another customer on the same tick settle independently", async () => {
        const { campaignId } = await kit.seedActive(
          policyFlow({ skipPassHolders: true }),
          { at: start }
        );
        const holder = await fixtures.addCustomer("guard-pair-holder");
        const other = await fixtures.addCustomer("guard-pair-other");
        await fixtures.holdPass({
          customer: holder,
          kind: "entry-pack",
          validFrom: "2026-10-01",
          validUntil: "2026-12-31",
        });
        for (const customer of [holder, other]) {
          await fixtures.recordEvent({
            kind: "account-created",
            customer,
            occurredAt: start,
          });
        }
        await scenario.tick(start.add({ minutes: 1 }));

        const outcomes = Object.fromEntries(
          (await runsOf(campaignId)).map((run) => [
            run.customer,
            [run.outcome, run.reason],
          ])
        );
        expect(outcomes).toEqual({
          [holder]: ["skipped", "pass-holder"],
          [other]: ["sent", null],
        });
        expect(requests().map((request) => request.to)).toEqual([
          [emailOf(other)],
        ]);
        expect(await read.sends(campaignId)).toHaveLength(2);
      });
    });
  }
);
