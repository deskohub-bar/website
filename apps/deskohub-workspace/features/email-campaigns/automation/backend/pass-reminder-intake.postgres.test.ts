import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import type { DotyposCustomerId } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { PassReminderReads } from "@/features/passes/backend/pass-reminder-reads.service";
import { getPassReminderDueAt } from "@/features/passes/pass-reminder-schedule";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  automationScenarioLayer,
  makeEngineDotypos,
  makeEngineFixtures,
  runEngineAt,
} from "./automation-engine-scenario.test-utils";
import {
  automationFlowFixture,
  automationLifecycleTestKit,
} from "./automation-lifecycle.test-utils";
import { AutomationPlanner } from "./automation-planner.service";
import {
  drainAutomationUnitQueue,
  makeAutomationUnitQueueFake,
} from "./automation-unit-queue.test-utils";
import { PassReminderWritesOpen } from "./pass-reminder-write-policy";

const database = await createWorkspacePostgresSuiteDatabase(
  "pass_reminder_intake"
);
afterAll(() => database?.close());

const dueDate = plainDateStringSchema.make("2027-01-07");
const dueAt = getPassReminderDueAt(dueDate);
const activatedAt = dueAt.subtract({ hours: 1 });
const flow = automationFlowFixture({
  trigger: { _tag: "EntryPackExpiring" },
  steps: [
    {
      _tag: "Condition",
      id: "eligible",
      filter: { _tag: "Group", operator: "and", filters: [] },
    },
    { _tag: "Send", id: "send" },
  ],
});

describe.skipIf(!database)("pass reminder intake on PostgreSQL", () => {
  if (database === null) return;

  const { pool } = database;
  const provider = makeEngineDotypos();
  const fixtures = makeEngineFixtures(
    database,
    provider,
    "pass-reminder-intake"
  );
  const kit = automationLifecycleTestKit(database, { now: activatedAt });

  const seedPass = async (
    customer: DotyposCustomerId,
    unclaimed = false,
    existingHolder?: string
  ) => {
    const id = orderIdSchema.make(crypto.randomUUID());
    const holder = existingHolder ?? crypto.randomUUID();
    const buyer = unclaimed ? crypto.randomUUID() : holder;
    if (existingHolder === undefined) {
      await pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2)",
        [holder, customer]
      );
      await pool.query(
        `insert into auth."user" (id, name, email, email_verified)
         values ($1, 'Synthetic holder', $2, true)`,
        [holder, testEmailAddress(holder)]
      );
    }
    if (unclaimed) {
      await pool.query("insert into customer_accounts (id) values ($1)", [
        buyer,
      ]);
    }
    await pool.query(
      `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, fulfilled_at)
       values ($1, 'pass-purchase', $2, 'complimentary', 'fulfilled', now())`,
      [id, customer]
    );
    await pool.query(
      `insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier,
         entry_count, status, valid_from, valid_until, quote, locale, created_at, gift_issued_at)
       values ($1, $2, $3, 'entry-pack', 'open-space', 5, 'active',
         '2026-12-11', '2027-01-15', '{}', 'en-US', now(),
         case when $2 <> $3 then now() end)`,
      [id, buyer, holder]
    );
    return { id, holder };
  };

  const seedVersion = async (draftFlow = flow) => {
    const { campaignId } = await kit.seedDraft();
    const permit = Effect.provideService(
      PassReminderWritesOpen,
      Effect.succeed(true)
    );
    await kit.run(
      kit
        .lifecycle((lifecycle) =>
          lifecycle.updateFlow({ campaignId, flow: draftFlow })
        )
        .pipe(permit)
    );
    const previewId = await kit.seedPreview(campaignId, {
      status: "completed",
    });
    const activate = kit
      .lifecycle((lifecycle) =>
        lifecycle.activate({ campaignId, previewId, activatedBy: null })
      )
      .pipe(permit);
    expect((await kit.failure(activate))._tag).toBe(
      "AutomationPreviewRequired"
    );
    await pool.query(
      "update email_campaign_automation_previews set as_of = $2 where id = $1",
      [previewId, dueAt.toString()]
    );
    await kit.run(activate);
    return campaignId;
  };

  test("plans the 10:00 occurrence and processes its retained passes after Prague midnight", async () => {
    const eligible = await fixtures.addCustomer("eligible");
    const revokedConsent = await fixtures.addCustomer("revoked-consent");
    const unclaimedGift = await fixtures.addCustomer("unclaimed-gift");
    const { id, holder } = await seedPass(eligible);
    const otherPass = await seedPass(eligible, false, holder);
    await seedPass(revokedConsent);
    await seedPass(unclaimedGift, true);
    const editedCampaign = await seedVersion();
    const resumedCampaign = await seedVersion(
      automationFlowFixture({
        trigger: { _tag: "UnlimitedEnding" },
        steps: [{ _tag: "Send", id: "send" }],
      })
    );
    const { rows: versionsAtFire } = await pool.query(
      "select active_version_id from email_campaign_automations where campaign_id = $1",
      [editedCampaign]
    );
    await kit.run(
      kit.lifecycle((lifecycle) => lifecycle.pause(resumedCampaign))
    );
    const queue = makeAutomationUnitQueueFake();
    const afterMidnight = dueAt.add({ hours: 15 });
    const liveOpen = Effect.map(currentInstant, (now) =>
      now.equals(afterMidnight)
    );
    const layer = await automationScenarioLayer({
      database,
      dotypos: provider,
      queue,
      kinds: ["pass-reminder-intake", "condition"],
      planning: ["intake"],
      passReminderGate: Layer.succeed(CoworkPassesReleaseGate, {
        isOpen: liveOpen,
        decision: liveOpen,
      }),
      passReminderReads: PassReminderReads.Default.pipe(
        Layer.provide(
          Layer.merge(
            database.layer,
            Layer.mock(AdvisoryAvailabilityInventory, {})
          )
        )
      ),
    });
    const plan = (open: boolean) =>
      Effect.flatMap(AutomationPlanner, (planner) => planner.plan).pipe(
        Effect.provideService(PassReminderWritesOpen, Effect.succeed(open))
      );
    expect(
      (await runEngineAt(plan(true), layer, dueAt.subtract({ minutes: 1 })))
        .intake.unitsPlanned
    ).toBe(0);
    expect(
      (await runEngineAt(plan(false), layer, dueAt)).intake.unitsPlanned
    ).toBe(0);
    const afterFire = dueAt.add({ minutes: 5 });
    const nextFlow = automationFlowFixture({
      trigger: { _tag: "AccountCreated" },
      steps: [{ _tag: "Send", id: "send" }],
    });
    await kit.run(
      kit.lifecycle((lifecycle) =>
        lifecycle.updateFlow({ campaignId: editedCampaign, flow: nextFlow })
      ),
      afterFire
    );
    const nextPreview = await kit.seedPreview(editedCampaign, {
      status: "completed",
    });
    await kit.run(
      kit.lifecycle((lifecycle) =>
        lifecycle.activate({
          campaignId: editedCampaign,
          previewId: nextPreview,
          activatedBy: null,
        })
      ),
      afterFire
    );
    await kit.run(
      kit
        .lifecycle((lifecycle) => lifecycle.resume(resumedCampaign))
        .pipe(
          Effect.provideService(PassReminderWritesOpen, Effect.succeed(true))
        ),
      afterFire
    );
    expect(
      (await runEngineAt(plan(true), layer, dueAt.add({ minutes: 15 }))).intake
        .unitsPlanned
    ).toBe(1);
    expect(
      (await runEngineAt(plan(true), layer, dueAt.add({ minutes: 30 }))).intake
        .unitsPlanned
    ).toBe(0);
    const { rows: pages } = await pool.query(
      `select campaign_id, subject->>'versionId' as version_id
       from email_campaign_automation_work_units where kind = 'pass-reminder-intake' and subject->>'_tag' = 'Page'`
    );
    expect(
      pages.find(({ campaign_id }) => campaign_id === editedCampaign)
        ?.version_id
    ).toBe(versionsAtFire[0].active_version_id);
    expect(
      pages.some(({ campaign_id }) => campaign_id === resumedCampaign)
    ).toBe(false);
    expect(new Set(queue.pending().map(({ unitId }) => unitId)).size).toBe(1);
    await pool.query(
      "update customer_marketing_consents set withdrawn_at = $2 where dotypos_customer_id = $1",
      [revokedConsent, afterMidnight.toString()]
    );
    await runEngineAt(drainAutomationUnitQueue(queue), layer, afterMidnight);
    expect(
      (await runEngineAt(plan(true), layer, afterMidnight)).intake.unitsPlanned
    ).toBe(0);
    const { rows } = await pool.query(
      `select trigger_pass_id, pass_reminder_context, dotypos_customer_id, step_id,
              trigger_at = $1::timestamptz as original_fire
       from email_campaign_automation_runs where trigger_pass_id is not null`,
      [dueAt.toString()]
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        [id, otherPass.id].map((passId) => ({
          trigger_pass_id: passId,
          original_fire: true,
          step_id: "send",
          dotypos_customer_id: eligible,
          pass_reminder_context: {
            copyVersion: 1,
            holderAccountId: holder,
            holderVersion: 0,
            tier: "open-space",
            endsOn: "2027-01-14",
            product: "entry-pack",
            remainingEntries: 5,
            totalEntries: 5,
          },
        }))
      )
    );
  });
});
