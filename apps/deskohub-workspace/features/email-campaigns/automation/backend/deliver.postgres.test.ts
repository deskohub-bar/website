import "@/shared/testing/workspace-test-env";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DotyposCustomerIdSchema, DotyposUnavailable } from "@deskohub/dotypos";
import type { EmailProviderFakeResponse } from "@deskohub/email/testing";
import { resendSimulatorAddress, testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { PassReminderReads } from "@/features/passes/backend/pass-reminder-reads.service";
import {
  getEntryPackBookingPath,
  getUnlimitedRenewalPath,
} from "@/features/passes/routes";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { getWorkspaceCanonicalUrl } from "@/shared/utils/site-constants";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  deleteAutomatedCampaigns,
  passReminderEmailDocumentFixture,
  seedPublishedEmail,
} from "../../backend/email-campaigns.test-utils";
import type { CampaignId } from "../../campaign-identifiers";
import type { AutomationWorkUnitId } from "../automation-identifiers";
import {
  deliverProfile,
  makeDeliverEngine,
  type SeedSendReadyRun,
  type SeedVisit,
  seedDeliverAutomation,
  seedDeliverReservations,
  seedSendReadyRuns,
  sendOnlyFlow,
} from "./deliver.test-utils";

/**
 * The engine plans over whole tables, so the suite runs on a database of
 * its own.
 */
const database =
  await createWorkspacePostgresSuiteDatabase("automation_deliver");
afterAll(() => database?.close());

/** Monday 19 October 2026, 12:00 in Prague. */
const startedAt = Temporal.Instant.from("2026-10-19T10:00:00Z");
const runKey = crypto.randomUUID().slice(0, 8);
const customerId = (name: string) =>
  DotyposCustomerIdSchema.make(`deliver-${runKey}-${name}`);

describe.skipIf(!database)("deliver units on disposable Postgres", () => {
  if (!database) return;
  const { db, pool } = database;
  const campaignIds: CampaignId[] = [];
  const reservationPrefixes: string[] = [];

  // A test that failed midway can't hold the deliver slot for the next.
  beforeEach(() =>
    pool.query(
      `update email_campaign_automation_work_units
          set status = 'dropped', claim_id = null, claim_expires_at = null, settled_at = now()
        where campaign_id = any($1) and status in ('planned', 'enqueued', 'claimed')`,
      [campaignIds]
    )
  );

  afterAll(async () => {
    await deleteAutomatedCampaigns(db, campaignIds);
    await pool.query(
      "delete from workspace_reservations where id like any($1)",
      [reservationPrefixes.map((prefix) => `${prefix}-%`)]
    );
  });

  const setUp = (
    input: Omit<Parameters<typeof makeDeliverEngine>[0], "database">
  ) => makeDeliverEngine({ database, ...input });

  const seedAutomation = async (
    input: Omit<Parameters<typeof seedDeliverAutomation>[1], "activatedAt">
  ) => {
    const seeded = await seedDeliverAutomation(db, {
      ...input,
      activatedAt: startedAt.subtract({ hours: 48 }),
    });
    campaignIds.push(seeded.campaignId);
    return seeded;
  };

  const seedVisits = (label: string, visits: readonly SeedVisit[]) => {
    const prefix = `deliver-${runKey}-${label}`;
    reservationPrefixes.push(prefix);
    return seedDeliverReservations(db, prefix, visits);
  };

  const seedRuns = (
    seeded: Awaited<ReturnType<typeof seedAutomation>>,
    runs: readonly SeedSendReadyRun[]
  ) => seedSendReadyRuns(db, { ...seeded, runs, at: startedAt });

  const seedPassReminder = async (
    kind: "entry-pack" | "unlimited" = "entry-pack",
    count = 1,
    deskLabel?: string,
    policies: Parameters<typeof sendOnlyFlow>[1] = {}
  ) => {
    const customer = customerId(crypto.randomUUID());
    const account = customerAccountIdSchema.make(crypto.randomUUID());
    const email = testEmailAddress(customer);
    await pool.query(
      "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2)",
      [account, customer]
    );
    await pool.query(
      `insert into auth."user" (id, name, email, email_verified)
       values ($1, 'Synthetic holder', $2, true)`,
      [account, email]
    );
    await pool.query(
      `insert into customer_marketing_consents
         (dotypos_customer_id, document_hash, locale, granted_at)
       values ($1, 'hash', 'en-US', '2026-01-01T00:00:00Z')`,
      [customer]
    );
    const published = await seedPublishedEmail(db, {
      title: `Synthetic ${kind} reminder`,
      document: passReminderEmailDocumentFixture(
        kind === "entry-pack" ? "entry-pack-expiring" : "unlimited-ending"
      ),
    });
    const seeded = await seedAutomation({
      purpose: "marketing",
      flow: sendOnlyFlow(
        kind === "entry-pack"
          ? { _tag: "EntryPackExpiring" }
          : { _tag: "UnlimitedEnding" },
        policies
      ),
      emailId: published.emailId,
      frozenEmailVersionId: published.versionId,
    });
    const passIds = Array.from({ length: count }, () =>
      orderIdSchema.make(crypto.randomUUID())
    );
    const validUntil = kind === "entry-pack" ? "2026-10-27" : "2026-10-25";
    const common = {
      copyVersion: 1,
      holderAccountId: account,
      holderVersion: 0,
      tier: "open-space",
      endsOn: plainDateStringSchema.make(
        kind === "entry-pack" ? "2026-10-26" : "2026-10-24"
      ),
    } as const;
    for (const passId of passIds) {
      await pool.query(
        `insert into orders
           (id, kind, dotypos_customer_id, payment_state, fulfillment_state, fulfilled_at)
         values ($1, 'pass-purchase', 'historical-billing-id', 'complimentary', 'fulfilled', now())`,
        [passId]
      );
      await pool.query(
        `insert into pass_purchases
           (id, buyer_account_id, holder_account_id, product, tier, entry_count,
            unlimited_coffee, status, valid_from, valid_until, quote, locale, created_at)
         values ($1, $2, $2, $3, 'open-space', case when $3 = 'entry-pack' then 5 end,
            case when $3 = 'unlimited' then false end, 'active', '2026-09-25', $4,
            '{}', 'en-US', now())`,
        [passId, account, kind, validUntil]
      );
    }
    await seedRuns(
      seeded,
      passIds.map((passId) => ({
        customer,
        triggerKind:
          kind === "entry-pack" ? "entry-pack-expiring" : "unlimited-ending",
        triggerPassId: passId,
        passReminderContext:
          kind === "entry-pack"
            ? { ...common, product: kind, remainingEntries: 1, totalEntries: 5 }
            : {
                ...common,
                product: kind,
                renewalStartsOn: plainDateStringSchema.make(validUntil),
              },
      }))
    );
    let gateOpen = true;
    const passReads = PassReminderReads.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          database.layer,
          Layer.mock(AdvisoryAvailabilityInventory, {
            tables: Effect.succeed([]),
          })
        )
      )
    );
    const passReadsWithLabel = Layer.effect(
      PassReminderReads,
      Effect.map(PassReminderReads, (reads) =>
        PassReminderReads.of({
          ...reads,
          readDue: (input) =>
            reads
              .readDue(input)
              .pipe(
                Effect.map(
                  Option.map((candidate) =>
                    deskLabel !== undefined &&
                    candidate.kind === "unlimited" &&
                    input.includeDeskLabel
                      ? { ...candidate, deskLabel }
                      : candidate
                  )
                )
              ),
        })
      )
    ).pipe(Layer.provide(passReads));
    const engine = await setUp({
      customers: [deliverProfile(customer, { firstName: "Synthetic Holder" })],
      passReminderReads: passReadsWithLabel,
      passReminderGate: CoworkPassesReleaseGate.fromEvaluation(
        Effect.sync(() => gateOpen)
      ),
    });
    return {
      ...seeded,
      account,
      customer,
      email,
      passIds,
      engine,
      closeGate: () => {
        gateOpen = false;
      },
    };
  };

  test("renders localized pass copy with unsubscribe and a separate send for each pass", async () => {
    // The legacy index stays during the reader rollout. The writer removes it.
    await pool.query(
      "drop index if exists email_campaign_automation_runs_one_open_run_idx"
    );
    const { campaignId, engine, email, passIds } = await seedPassReminder(
      "entry-pack",
      2
    );
    await engine.tick(startedAt);
    await engine.tick(startedAt.add({ minutes: 15 }));
    const requests = engine.resend.requests();
    expect(requests).toHaveLength(2);
    const { rows } = await pool.query(
      `select trigger_pass_id, pass_reminder_context, outcome, send_id
         from email_campaign_automation_runs where campaign_id = $1`,
      [campaignId]
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(({ send_id }) => send_id)).size).toBe(2);
    for (const row of rows) {
      expect(row.outcome).toBe("sent");
      expect(row.pass_reminder_context).toMatchObject({
        copyVersion: 1,
        remainingEntries: 5,
        totalEntries: 5,
      });
      expect(JSON.stringify(row.pass_reminder_context)).not.toContain(email);
      expect(JSON.stringify(row.pass_reminder_context)).not.toContain(
        "Synthetic Holder"
      );
      const request = requests.find(({ key }) => key.includes(row.send_id));
      expect(request?.to).toEqual([email]);
      expect(request?.payload).toContain("Synthetic Holder");
      expect(request?.payload).toContain("List-Unsubscribe");
      expect(request?.payload).not.toContain("Generic automation copy");
      const passId = requireValue(
        passIds.find((id) => id === row.trigger_pass_id)
      );
      expect(request?.payload).toContain(
        getWorkspaceCanonicalUrl(getEntryPackBookingPath("en-US", passId))
      );
    }
  });

  test("Unlimited reminders budget the advisory read and omit an overlong desk label", async () => {
    const deskLabel = "x".repeat(121);
    const {
      campaignId,
      engine,
      passIds: [passId],
    } = await seedPassReminder("unlimited", 1, deskLabel);
    await engine.planOnly(startedAt);
    const {
      rows: [planned],
    } = await pool.query(
      "select request_cost from email_campaign_automation_work_units where campaign_id = $1",
      [campaignId]
    );
    expect(planned?.request_cost).toBe(2);
    await engine.drain(startedAt);
    const [request] = engine.resend.requests();
    expect(request?.payload).toContain(
      getWorkspaceCanonicalUrl(
        getUnlimitedRenewalPath("en-US", requireValue(passId))
      )
    );
    expect(request?.payload).not.toContain(deskLabel);
  });

  test("Unlimited reminders render the conditional desk block for a Reserved Desk holder", async () => {
    const {
      engine,
      passIds: [passId],
    } = await seedPassReminder("unlimited", 1, "Desk 14");
    await pool.query(
      "update pass_purchases set tier = 'reserved-desk', unlimited_coffee = null where id = $1",
      [passId]
    );
    await engine.tick(startedAt);
    const [request] = engine.resend.requests();
    expect(request?.payload).toContain("Desk 14");
    expect(request?.payload).toContain(
      getWorkspaceCanonicalUrl(
        getUnlimitedRenewalPath("en-US", requireValue(passId))
      )
    );
  });

  test.each(["sent", "skipped"] as const)(
    "settles %s after a temporary admission read failure",
    async (outcome) => {
      const { campaignId, customer, engine } = await seedPassReminder();
      engine.dotypos.onRequest(({ method }) => {
        if (
          method !== "getCustomersByIds" ||
          engine.dotypos.calls.getCustomersByIds !== 2
        ) {
          return Effect.void;
        }
        if (outcome === "skipped") {
          engine.dotypos.setCustomers([
            deliverProfile(customer, {
              email: resendSimulatorAddress("delivered"),
            }),
          ]);
        }
        return new DotyposUnavailable({
          operation: method,
          reason: "server",
          httpStatus: 503,
        });
      });
      await engine.tick(startedAt);
      expect(engine.dotypos.calls.getCustomersByIds).toBeGreaterThanOrEqual(3);
      expect(engine.resend.requests()).toHaveLength(outcome === "sent" ? 1 : 0);
      expect(outcomesOf(await runsOf(campaignId))).toEqual({
        [customer]: [
          "ended",
          outcome,
          outcome === "sent" ? null : "outside-test-domain",
        ],
      });
    }
  );

  test("stops a prepared provider request when its analytics identity is withdrawn", async () => {
    const { account, campaignId, customer, engine } = await seedPassReminder();
    const recordAnalyticsDecision = (
      decision: "grant" | "withdraw",
      decidedAt: string
    ) =>
      pool.query(
        `insert into account_analytics_consent_decisions
           (account_id, decision, document_hash, locale, decided_at, source)
         values ($1, $2, 'hash', 'en-US', $3, 'preference')`,
        [account, decision, decidedAt]
      );
    await recordAnalyticsDecision("grant", "2026-10-19T09:00:00Z");
    engine.resend.beforeEachRequest(async () => {
      await recordAnalyticsDecision("withdraw", "2026-10-19T10:00:00Z");
    });
    await engine.tick(startedAt);
    expect(engine.resend.requests()).toEqual([]);
    expect(outcomesOf(await runsOf(campaignId))).toEqual({
      [customer]: ["ended", "withdrawn", null],
    });
  });

  test("a reminder withdrawn on its first request releases its once-per-customer claim", async () => {
    const { campaignId, customer, engine } = await seedPassReminder(
      "entry-pack",
      1,
      undefined,
      { oncePerCustomer: true }
    );
    engine.dotypos.onRequest(({ method }) =>
      method === "getCustomersByIds" &&
      engine.dotypos.calls.getCustomersByIds === 2
        ? TestClock.adjust("2 seconds")
        : Effect.void
    );
    await engine.tick(Temporal.Instant.from("2026-10-26T22:59:59Z"));
    expect(engine.resend.requests()).toEqual([]);
    expect(outcomesOf(await runsOf(campaignId))).toEqual({
      [customer]: ["ended", "withdrawn", null],
    });
    const { rows } = await pool.query(
      "select 1 from email_campaign_automation_customer_claims where campaign_id = $1",
      [campaignId]
    );
    expect(rows).toEqual([]);
  });

  test("withdraws an Entry Pack that expires while its first request is being checked", async () => {
    const { campaignId, customer, engine } = await seedPassReminder();
    engine.dotypos.onRequest(({ method }) =>
      method === "getCustomersByIds" &&
      engine.dotypos.calls.getCustomersByIds === 2
        ? TestClock.adjust("2 seconds")
        : Effect.void
    );
    // One second before midnight in Prague, after the change back to CET.
    await engine.tick(Temporal.Instant.from("2026-10-26T22:59:59Z"));
    expect(engine.resend.requests()).toEqual([]);
    expect(outcomesOf(await runsOf(campaignId))).toEqual({
      [customer]: ["ended", "withdrawn", null],
    });
  });

  test.each(["holder", "consent", "gate", "test-domain"] as const)(
    "settles the first request without calling the provider after a late %s change",
    async (change) => {
      const {
        campaignId,
        customer,
        engine,
        closeGate,
        passIds: [passId],
      } = await seedPassReminder();
      let checked = false;
      engine.resend.beforeEachRequest(async () => {
        checked = true;
        if (change === "holder") {
          await pool.query(
            "update pass_purchases set holder_version = 1 where id = $1",
            [passId]
          );
        } else if (change === "consent") {
          await pool.query(
            "update customer_marketing_consents set withdrawn_at = now() where dotypos_customer_id = $1",
            [customer]
          );
        } else if (change === "gate") {
          closeGate();
        } else {
          engine.dotypos.setCustomers([
            deliverProfile(customer, {
              email: resendSimulatorAddress("delivered"),
            }),
          ]);
        }
      });
      await engine.tick(startedAt);
      expect(checked).toBe(true);
      expect(engine.resend.requests()).toEqual([]);
      const outcomes = {
        holder: ["ended", "withdrawn", null],
        consent: ["ended", "skipped", "consent-withdrawn"],
        gate: ["ended", "withdrawn", null],
        "test-domain": ["ended", "skipped", "outside-test-domain"],
      };
      expect(outcomesOf(await runsOf(campaignId))).toEqual({
        [customer]: outcomes[change],
      });
    }
  );

  test.each(["unchanged", "holder", "email", "provider"] as const)(
    "reconciles a lost pass reminder response after a %s check",
    async (change) => {
      const {
        campaignId,
        customer,
        engine,
        passIds: [passId],
      } = await seedPassReminder();
      engine.resend.respondWith(() => "accept-hang");
      await engine.killDuringRequest(startedAt);
      if (change === "holder") {
        await pool.query(
          "update pass_purchases set holder_version = 1 where id = $1",
          [passId]
        );
      }
      if (change === "email") {
        engine.dotypos.setCustomers([
          deliverProfile(customer, { email: testEmailAddress("changed") }),
        ]);
      }
      if (change === "provider") {
        const [unit] = await unitsOf(campaignId);
        await pool.query(
          `update email_campaign_delivery_batches
             set payload_hash = split_part(payload_hash, ':', 1) || ':' ||
               split_part(payload_hash, ':', 2) || ':' || repeat('0', 64)
           where send_id = $1`,
          [unit?.send_id]
        );
      }
      await engine.tick(startedAt.add({ minutes: 6 }));
      const requests = engine.resend.requests();
      if (change === "unchanged") {
        expect(requests).toHaveLength(2);
        expect(requests[0]).toEqual(requests[1]);
      } else {
        expect(requests).toHaveLength(1);
      }
      expect(engine.resend.mailed()).toHaveLength(1);
      expect(outcomesOf(await runsOf(campaignId))).toEqual({
        [customer]: [
          "ended",
          change === "unchanged" ? "sent" : "unconfirmed",
          null,
        ],
      });
    }
  );

  const runsOf = async (campaignId: CampaignId) => {
    const { rows } = await pool.query<{
      dotypos_customer_id: string;
      status: string;
      phase: string | null;
      outcome: string | null;
      outcome_reason: string | null;
      due_at: Date | null;
      work_unit_id: string | null;
      send_id: string | null;
      events: string[];
    }>(
      `select r.dotypos_customer_id, r.status, r.phase, r.outcome, r.outcome_reason, r.due_at, r.work_unit_id, r.send_id,
              coalesce(array_agg(e.kind order by e.sequence) filter (where e.kind is not null), '{}') as events
         from email_campaign_automation_runs r
         left join email_campaign_automation_run_events e on e.run_id = r.id
        where r.campaign_id = $1
        group by r.id
        order by r.dotypos_customer_id`,
      [campaignId]
    );
    return new Map(rows.map((row) => [row.dotypos_customer_id, row]));
  };

  const unitsOf = async (campaignId: CampaignId) => {
    const { rows } = await pool.query<{
      id: AutomationWorkUnitId;
      status: string;
      send_id: string | null;
      cancel_requested_at: Date | null;
      last_error_code: string | null;
    }>(
      "select id, status, send_id, cancel_requested_at, last_error_code from email_campaign_automation_work_units where campaign_id = $1 order by created_at, id",
      [campaignId]
    );
    return rows;
  };

  const outcomesOf = (runs: Awaited<ReturnType<typeof runsOf>>) =>
    Object.fromEntries(
      [...runs].map(([customer, run]) => [
        customer,
        [run.status, run.outcome, run.outcome_reason],
      ])
    );

  test("verifies, persists, submits and settles one batch in one invocation", async () => {
    const booked = customerId("verify-booked");
    const extended = customerId("verify-extended");
    const dotyposCancelled = customerId("verify-dotypos-cancelled");
    const workspaceCancelled = customerId("verify-workspace-cancelled");
    const account = customerId("verify-account");
    const outside = customerId("verify-outside");
    const visits = await seedVisits("verify", [
      {
        label: "booked",
        customer: booked,
        startsAt: startedAt.add({ hours: 24 }),
        endsAt: startedAt.add({ hours: 26 }),
      },
      {
        // Finished at the trigger, then extended past now in Dotypos.
        label: "extended",
        customer: extended,
        startsAt: startedAt.subtract({ hours: 2 }),
        endsAt: startedAt.add({ hours: 1 }),
      },
      {
        label: "dotypos-cancelled",
        customer: dotyposCancelled,
        startsAt: startedAt.add({ hours: 24 }),
        endsAt: startedAt.add({ hours: 26 }),
        dotyposStatus: "CANCELLED",
      },
      {
        label: "workspace-cancelled",
        customer: workspaceCancelled,
        startsAt: startedAt.add({ hours: 24 }),
        endsAt: startedAt.add({ hours: 26 }),
        cancelledAt: startedAt.subtract({ minutes: 5 }),
      },
    ]);
    const engine = await setUp({
      customers: [
        booked,
        extended,
        dotyposCancelled,
        workspaceCancelled,
        account,
      ]
        .map((id) => deliverProfile(id))
        .concat(
          deliverProfile(outside, {
            email: resendSimulatorAddress("delivered"),
          })
        ),
    });
    engine.dotypos.setReservations(visits.dotypos);
    const seeded = await seedAutomation({ text: "Verze doručení" });
    await seedRuns(seeded, [
      {
        customer: booked,
        triggerKind: "reservation-booked",
        reservationId: visits.ids.get("booked"),
      },
      {
        customer: extended,
        triggerKind: "reservation-finished",
        reservationId: visits.ids.get("extended"),
      },
      {
        customer: dotyposCancelled,
        triggerKind: "reservation-booked",
        reservationId: visits.ids.get("dotypos-cancelled"),
      },
      {
        customer: workspaceCancelled,
        triggerKind: "reservation-booked",
        reservationId: visits.ids.get("workspace-cancelled"),
      },
      { customer: account },
      { customer: outside },
    ]);

    await engine.tick(startedAt);

    const runs = await runsOf(seeded.campaignId);
    expect(outcomesOf(runs)).toEqual({
      [booked]: ["ended", "sent", null],
      [extended]: ["active", null, null],
      [dotyposCancelled]: ["ended", "withdrawn", null],
      [workspaceCancelled]: ["ended", "withdrawn", null],
      [account]: ["ended", "sent", null],
      [outside]: ["ended", "skipped", "outside-test-domain"],
    });
    expect(requireValue(runs.get(booked)).events).toEqual([
      "send-queued",
      "sent",
    ]);
    expect(requireValue(runs.get(outside)).events).toEqual([
      "send-queued",
      "skipped",
    ]);
    expect(requireValue(runs.get(dotyposCancelled)).events).toEqual([
      "withdrawn",
    ]);
    const deferred = requireValue(runs.get(extended));
    expect(deferred).toMatchObject({
      phase: "waiting",
      work_unit_id: null,
      send_id: null,
      events: ["deferred"],
    });
    expect(new Date(requireValue(deferred.due_at)).toISOString()).toBe(
      new Date(startedAt.add({ minutes: 15 }).epochMilliseconds).toISOString()
    );
    const {
      rows: [deferredEntry],
    } = await pool.query(
      `select e.detail from email_campaign_automation_run_events e
         join email_campaign_automation_runs r on r.id = e.run_id
        where r.dotypos_customer_id = $1`,
      [extended]
    );
    expect(deferredEntry.detail).toEqual({
      cause: "trigger-not-reached",
      recheckAt: "2026-10-19T10:15:00.000Z",
    });

    const [unit] = await unitsOf(seeded.campaignId);
    expect(unit).toMatchObject({ status: "done" });
    expect(engine.resend.requests()).toMatchObject([
      {
        key: `email-campaign:${requireValue(unit).send_id}:attempt-1:batch-0`,
        to: expect.arrayContaining([
          testEmailAddress(booked),
          testEmailAddress(account),
        ]),
      },
    ]);
    expect(engine.resend.mailed()).toHaveLength(2);
    const {
      rows: [send],
    } = await pool.query(
      "select s.completed_at, s.automation_version_id, c.status from email_campaign_sends s join email_campaigns c on c.id = s.campaign_id where s.id = $1",
      [requireValue(unit).send_id]
    );
    expect(send.completed_at).not.toBeNull();
    expect(send.automation_version_id).toBe(seeded.versionId);
    expect(send.status).toBe("active");
  });

  test("the pre-submit check reads each trigger kind's own moment and withdraws a cancellation trigger only once a restore undid it", async () => {
    const startedNow = customerId("kind-started-now");
    const startedLater = customerId("kind-started-later");
    const finishedGone = customerId("kind-finished-gone");
    const cancellation = customerId("kind-cancellation");
    const restored = customerId("kind-cancellation-restored");
    const cancelledAgain = customerId("kind-cancellation-again");
    const cancelledAt = startedAt.subtract({ minutes: 5 });
    const visits = await seedVisits("kind", [
      {
        // Started at the send instant itself.
        label: "started-now",
        customer: startedNow,
        startsAt: startedAt,
        endsAt: startedAt.add({ hours: 2 }),
      },
      {
        // Moved in Dotypos to start after now.
        label: "started-later",
        customer: startedLater,
        startsAt: startedAt.add({ hours: 1 }),
        endsAt: startedAt.add({ hours: 3 }),
      },
      {
        label: "finished-gone",
        customer: finishedGone,
        startsAt: startedAt.subtract({ hours: 3 }),
        endsAt: startedAt.subtract({ hours: 1 }),
      },
      {
        label: "cancellation",
        customer: cancellation,
        startsAt: startedAt.add({ hours: 24 }),
        endsAt: startedAt.add({ hours: 26 }),
        dotyposStatus: "CANCELLED",
        cancelledAt,
      },
      {
        // Restored since the cancellation.
        label: "cancellation-restored",
        customer: restored,
        startsAt: startedAt.add({ hours: 24 }),
        endsAt: startedAt.add({ hours: 26 }),
      },
      {
        // Restored, then cancelled again later.
        label: "cancellation-again",
        customer: cancelledAgain,
        startsAt: startedAt.add({ hours: 24 }),
        endsAt: startedAt.add({ hours: 26 }),
        dotyposStatus: "CANCELLED",
        cancelledAt: cancelledAt.add({ minutes: 1 }),
      },
    ]);
    const engine = await setUp({
      customers: [
        startedNow,
        startedLater,
        finishedGone,
        cancellation,
        restored,
        cancelledAgain,
      ].map((id) => deliverProfile(id)),
    });
    // Dotypos no longer returns the finished visit.
    engine.dotypos.setReservations(
      visits.dotypos.filter((_, index) => index !== 2)
    );
    const seeded = await seedAutomation({ text: "Verze druhů spouštěčů" });
    await seedRuns(seeded, [
      {
        customer: startedNow,
        triggerKind: "reservation-started",
        reservationId: visits.ids.get("started-now"),
      },
      {
        customer: startedLater,
        triggerKind: "reservation-started",
        reservationId: visits.ids.get("started-later"),
      },
      {
        customer: finishedGone,
        triggerKind: "reservation-finished",
        reservationId: visits.ids.get("finished-gone"),
      },
      ...(
        [
          [cancellation, "cancellation"],
          [restored, "cancellation-restored"],
          [cancelledAgain, "cancellation-again"],
        ] as const
      ).map(([customer, label]) => ({
        customer,
        triggerKind: "reservation-cancelled" as const,
        reservationId: visits.ids.get(label),
        triggerAt: cancelledAt,
      })),
    ]);

    await engine.tick(startedAt);

    const runs = await runsOf(seeded.campaignId);
    expect(outcomesOf(runs)).toEqual({
      [startedNow]: ["ended", "sent", null],
      [startedLater]: ["active", null, null],
      [finishedGone]: ["ended", "withdrawn", null],
      [cancellation]: ["ended", "sent", null],
      [restored]: ["ended", "withdrawn", null],
      [cancelledAgain]: ["ended", "withdrawn", null],
    });
    expect(requireValue(runs.get(startedLater)).events).toEqual(["deferred"]);
  });

  test("a refused first request ends the runs failed / delivery-refused", async () => {
    const id = customerId("refused");
    const engine = await setUp({ customers: [deliverProfile(id)] });
    engine.resend.respondWith(() => "refuse");
    const seeded = await seedAutomation({});
    await seedRuns(seeded, [{ customer: id }]);

    await engine.tick(startedAt);

    expect(outcomesOf(await runsOf(seeded.campaignId))).toEqual({
      [id]: ["ended", "failed", "delivery-refused"],
    });
    expect((await unitsOf(seeded.campaignId))[0]).toMatchObject({
      status: "done",
    });
  });

  test("a paused automation's unit is dropped; its runs stay ready and are planned afresh after resume", async () => {
    const id = customerId("paused");
    const engine = await setUp({ customers: [deliverProfile(id)] });
    const seeded = await seedAutomation({});
    await seedRuns(seeded, [{ customer: id }]);

    // The pause commits while the unit is queued: lifecycle marks it.
    await engine.planOnly(startedAt);
    await engine.lifecycle(
      (lifecycle) => lifecycle.pause(seeded.campaignId),
      startedAt
    );
    await engine.tick(startedAt.add({ minutes: 1 }));

    expect(await unitsOf(seeded.campaignId)).toEqual([
      expect.objectContaining({ status: "dropped", send_id: null }),
    ]);
    expect(await runsOf(seeded.campaignId)).toEqual(
      new Map([
        [
          id,
          expect.objectContaining({
            status: "active",
            phase: "ready",
            work_unit_id: null,
          }),
        ],
      ])
    );
    expect(engine.resend.requests()).toEqual([]);

    await engine.lifecycle(
      (lifecycle) => lifecycle.resume(seeded.campaignId),
      startedAt.add({ minutes: 2 })
    );
    await engine.tick(startedAt.add({ minutes: 3 }));

    expect(outcomesOf(await runsOf(seeded.campaignId))).toEqual({
      [id]: ["ended", "sent", null],
    });
    expect(engine.resend.mailed()).toEqual([testEmailAddress(id)]);
  });

  test("a deliver commit that finds its automation paused writes nothing and drops the unit", async () => {
    const id = customerId("recheck");
    const engine = await setUp({ customers: [deliverProfile(id)] });
    const seeded = await seedAutomation({});
    await seedRuns(seeded, [{ customer: id }]);
    await engine.planOnly(startedAt);
    // The status changes after planning, without marking the unit, as when
    // a pause commits during the unit's fetch.
    await pool.query(
      "update email_campaigns set status = 'paused' where id = $1",
      [seeded.campaignId]
    );

    await engine.drain(startedAt);

    expect(await unitsOf(seeded.campaignId)).toEqual([
      expect.objectContaining({
        status: "dropped",
        send_id: null,
        last_error_code: "automation-paused",
      }),
    ]);
    expect(await runsOf(seeded.campaignId)).toEqual(
      new Map([
        [
          id,
          expect.objectContaining({
            status: "active",
            phase: "ready",
            work_unit_id: null,
            events: [],
          }),
        ],
      ])
    );
    expect(engine.resend.requests()).toEqual([]);
    // A paused automation's runs aren't planned.
    await engine.tick(startedAt.add({ minutes: 1 }));
    expect(await unitsOf(seeded.campaignId)).toHaveLength(1);

    await pool.query(
      "update email_campaigns set status = 'active' where id = $1",
      [seeded.campaignId]
    );
    await engine.tick(startedAt.add({ minutes: 2 }));
    expect(outcomesOf(await runsOf(seeded.campaignId))).toEqual({
      [id]: ["ended", "sent", null],
    });
  });

  test.each<
    readonly [
      string,
      EmailProviderFakeResponse,
      "none" | "pause" | "archive" | "lost-message",
    ]
  >([
    ["before the provider accepted its batch", "hang", "none"],
    ["after the provider accepted its batch", "accept-hang", "none"],
    ["then paused", "accept-hang", "pause"],
    ["then archived", "hang", "archive"],
    ["whose requeued message was lost", "accept-hang", "lost-message"],
  ])(
    "a unit killed after persisting %s is reaped, replays batch 0 once without re-verifying, and holds the deliver slot until it settles",
    async (_label, crash, then) => {
      // Short ids keep the test-domain addresses valid.
      const slug = `kill${crash}${then}`.replaceAll("-", "").slice(0, 16);
      const booked = customerId(`kill-${slug}-booked`);
      const account = customerId(`kill-${slug}-account`);
      const other = customerId(`kill-${slug}-other`);
      const visits = await seedVisits(`kill-${slug}`, [
        {
          label: "booked",
          customer: booked,
          startsAt: startedAt.add({ hours: 24 }),
          endsAt: startedAt.add({ hours: 26 }),
        },
      ]);
      const engine = await setUp({
        customers: [booked, account, other].map((id) => deliverProfile(id)),
      });
      engine.dotypos.setReservations(visits.dotypos);
      const seeded = await seedAutomation({});
      await seedRuns(seeded, [
        {
          customer: booked,
          triggerKind: "reservation-booked",
          reservationId: visits.ids.get("booked"),
        },
        { customer: account },
      ]);

      engine.resend.respondWith(() => crash);
      await engine.killDuringRequest(startedAt);
      engine.resend.respondWith(() => "accept");
      const [killed] = await unitsOf(seeded.campaignId);
      expect(killed).toMatchObject({ status: "claimed" });
      expect(requireValue(killed).send_id).not.toBeNull();
      const verified = engine.dotypos.calls.getReservationsByIds;
      expect(verified).toBe(1);

      if (then === "pause") {
        await engine.lifecycle(
          (lifecycle) => lifecycle.pause(seeded.campaignId),
          startedAt.add({ minutes: 1 })
        );
      }
      if (then === "archive") {
        await engine.lifecycle(
          (lifecycle) => lifecycle.archive(seeded.campaignId),
          startedAt.add({ minutes: 1 })
        );
      }
      // Lifecycle operations never mark a unit with a persisted batch.
      expect((await unitsOf(seeded.campaignId))[0]).toMatchObject({
        status: "claimed",
        cancel_requested_at: null,
      });

      // Another automation's send waits: the killed unit holds the slot.
      const waiting = await seedAutomation({});
      await seedRuns(waiting, [{ customer: other }]);
      await engine.tick(startedAt.add({ minutes: 2 }));
      expect(await unitsOf(waiting.campaignId)).toEqual([
        expect.objectContaining({ status: "planned" }),
      ]);
      expect(engine.resend.requests()).toHaveLength(1);

      // The claim expires; the reaper requeues the unit whatever the status.
      if (then === "lost-message") {
        await engine.planOnly(startedAt.add({ minutes: 6 }));
        engine.queue.dropPending();
        await engine.tick(startedAt.add({ minutes: 17 }));
      } else {
        await engine.tick(startedAt.add({ minutes: 6 }));
      }

      const runs = await runsOf(seeded.campaignId);
      expect(outcomesOf(runs)).toEqual({
        [account]: ["ended", "sent", null],
        [booked]: ["ended", "sent", null],
      });
      // Settling the send leaves the campaign's status to its lifecycle.
      const {
        rows: [settled],
      } = await pool.query(
        "select c.status, s.completed_at from email_campaign_sends s join email_campaigns c on c.id = s.campaign_id where s.id = $1",
        [requireValue(killed).send_id]
      );
      expect(settled.status).toBe(
        {
          none: "active",
          "lost-message": "active",
          pause: "paused",
          archive: "archived",
        }[then]
      );
      expect(settled.completed_at).not.toBeNull();
      const keys = engine.resend.requests().map(({ key }) => key);
      const killedKey = `email-campaign:${requireValue(killed).send_id}:attempt-1:batch-0`;
      expect(keys.filter((key) => key === killedKey)).toHaveLength(2);
      // One email per recipient, even when the provider had accepted it.
      expect(engine.resend.mailed().sort()).toEqual(
        [booked, account, other].map((id) => testEmailAddress(id)).sort()
      );
      expect(engine.dotypos.calls.getReservationsByIds).toBe(verified);
      expect((await unitsOf(seeded.campaignId))[0]).toMatchObject({
        status: "done",
      });
      // The settlement handed the slot to the waiting automation's unit.
      expect(outcomesOf(await runsOf(waiting.campaignId))).toEqual({
        [other]: ["ended", "sent", null],
      });
    }
  );

  test("a persisted batch past the 23-hour replay window ends unconfirmed without a request", async () => {
    const id = customerId("expired");
    const engine = await setUp({ customers: [deliverProfile(id)] });
    const seeded = await seedAutomation({});
    await seedRuns(seeded, [{ customer: id }]);
    engine.resend.respondWith(() => "hang");
    await engine.killDuringRequest(startedAt);
    engine.resend.respondWith(() => "accept");

    await engine.tick(startedAt.add({ hours: 23, minutes: 1 }));

    expect(outcomesOf(await runsOf(seeded.campaignId))).toEqual({
      [id]: ["ended", "unconfirmed", null],
    });
    expect(engine.resend.requests()).toHaveLength(1);
    expect((await unitsOf(seeded.campaignId))[0]).toMatchObject({
      status: "done",
    });
  });

  test("a lost provider response requeues the unit, which replays its batch under the same key", async () => {
    const id = customerId("lost-response");
    const engine = await setUp({ customers: [deliverProfile(id)] });
    const seeded = await seedAutomation({ flow: sendOnlyFlow() });
    await seedRuns(seeded, [{ customer: id }]);
    engine.resend.respondWith(() => "accept-lost");

    await engine.tick(startedAt);

    expect(outcomesOf(await runsOf(seeded.campaignId))).toEqual({
      [id]: ["ended", "sent", null],
    });
    const keys = engine.resend.requests().map(({ key }) => key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(engine.resend.mailed()).toEqual([testEmailAddress(id)]);
    expect((await unitsOf(seeded.campaignId))[0]).toMatchObject({
      status: "done",
      last_error_code: "delivery-incomplete",
    });
  });
});
