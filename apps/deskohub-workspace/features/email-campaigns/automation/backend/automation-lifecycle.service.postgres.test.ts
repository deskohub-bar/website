import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import type { AutomationFlowType } from "@deskohub/workspace-admin-api";
import { Context, Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { withPostgresAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  campaignContentFixture,
  passReminderEmailDocumentFixture,
  seedAutomatedSend,
  seedPublishedEmail,
} from "@/features/email-campaigns/backend/email-campaigns.test-utils";
import {
  type CampaignAudienceId,
  type CampaignId,
  campaignAudienceIdSchema,
} from "@/features/email-campaigns/campaign-identifiers";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import {
  holdPostgresTransaction,
  waitForAdvisoryLockWaiter,
  waitForPostgresLockWaiter,
} from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import { connectWorkspacePostgresTestDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  type AutomationVersionId,
  automationPreviewIdSchema,
} from "../automation-identifiers";
import {
  automationFlowFixture,
  automationLifecycleTestKit,
  bookedSendFlow,
} from "./automation-lifecycle.test-utils";
import { nextPassReminderPreviewOccurrence } from "./automation-pass-reminder-preview";
import { PassReminderWritesOpen } from "./pass-reminder-write-policy";

const testDatabase = await connectWorkspacePostgresTestDatabase();

/** Monday 19 October 2026, 12:30 in Prague. */
const now = Temporal.Instant.from("2026-10-19T10:30:00Z");

/** Mondays 10:00–10:59 in Prague. */
const mondayFlow: AutomationFlowType = automationFlowFixture({
  trigger: {
    _tag: "Schedule",
    calendar: { weekdays: ["monday"], hours: [10] },
  },
  steps: [{ _tag: "Send", id: "send" }],
});

const wednesdayFlow: AutomationFlowType = automationFlowFixture({
  trigger: {
    _tag: "Schedule",
    calendar: { weekdays: ["wednesday"], hours: [10] },
  },
  steps: [{ _tag: "Send", id: "send" }],
});

const inAudienceFlow = (audienceId: CampaignAudienceId): AutomationFlowType =>
  automationFlowFixture({
    trigger: { _tag: "ReservationBooked" },
    steps: [
      {
        _tag: "Condition",
        id: "regulars",
        filter: { _tag: "InAudience", audienceId, operator: "in" },
      },
      { _tag: "Send", id: "send" },
    ],
  });

describe.skipIf(!testDatabase)(
  "automation lifecycle on disposable Postgres",
  () => {
    if (!testDatabase) return;
    const { db, pool } = testDatabase;
    const {
      runId,
      campaignIds,
      run,
      failure,
      lifecycle,
      insertAudience,
      seedDraft,
      draftHash,
      seedPreview,
      seedActive,
      seedAccount,
      cleanup,
    } = automationLifecycleTestKit(testDatabase, { now });

    afterAll(cleanup);

    const automationRow = async (campaignId: CampaignId) => {
      const { rows } = await pool.query<{
        status: string;
        active_version_id: AutomationVersionId | null;
        accepting_since: Date | null;
        paused_at: Date | null;
        resumed_at: Date | null;
        archived_at: Date | null;
        next_fire_at: Date | null;
      }>(
        `select c.status, a.active_version_id, a.accepting_since, a.paused_at,
                a.resumed_at, a.archived_at, a.next_fire_at
           from email_campaign_automations a
           join email_campaigns c on c.id = a.campaign_id
          where a.campaign_id = $1`,
        [campaignId]
      );
      return requireValue(rows[0], "stored automation");
    };

    /** A timestamp column as an ISO instant, whatever the driver returns. */
    const iso = (value: Date | string | null) =>
      value === null
        ? null
        : Temporal.Instant.from(
            String(value instanceof Date ? value.toISOString() : value)
          ).toString();

    const versionRows = async (campaignId: CampaignId) => {
      const { rows } = await pool.query<{
        id: AutomationVersionId;
        version_number: number;
        row: string;
      }>(
        `select id, version_number, row_to_json(v)::text as row
           from email_campaign_automation_versions v
          where campaign_id = $1 order by version_number`,
        [campaignId]
      );
      return rows;
    };

    test("allows saving marketing pass reminder drafts while keeping activation gated until the release opens", async () => {
      const { campaignId } = await seedDraft();
      const { campaignId: operationalId } = await seedDraft();
      await pool.query(
        "update email_campaigns set purpose = 'operational' where id = $1",
        [operationalId]
      );
      for (const tag of ["EntryPackExpiring", "UnlimitedEnding"] as const) {
        const trigger = { _tag: tag };
        const flow = automationFlowFixture({
          trigger,
          steps: [{ _tag: "Send", id: "send" }],
        });
        const operationalError = await failure(
          lifecycle((l) => l.updateFlow({ campaignId: operationalId, flow }))
        );
        expect(operationalError._tag).toBe("AutomationFlowInvalid");

        const saved = await run(
          lifecycle((l) => l.updateFlow({ campaignId, flow }))
        );
        expect(saved.flow?.trigger).toEqual({ _tag: tag, copyVersion: 1 });

        const previewId = await seedPreview(campaignId, {
          status: "completed",
        });
        const { fireAt } = nextPassReminderPreviewOccurrence(trigger, now);
        await pool.query(
          "update email_campaign_automation_previews set as_of = $2 where id = $1",
          [previewId, fireAt.toString()]
        );
        const activationError = await failure(
          lifecycle((l) =>
            l.activate({ campaignId, previewId, activatedBy: null })
          )
        );
        expect(activationError._tag).toBe("AutomationFlowInvalid");
        expect((await automationRow(campaignId)).status).toBe("draft");
        expect(await versionRows(campaignId)).toEqual([]);
      }
    });

    test("freezes linked published email version on activation, changes draft hash on republish, and rejects trigger mismatch", async () => {
      const permitPassReminders = Effect.provideService(
        PassReminderWritesOpen,
        Effect.succeed(true)
      );
      const entryEmail = await seedPublishedEmail(db, {
        title: "Entry pack reminder",
        document: passReminderEmailDocumentFixture("entry-pack-expiring"),
      });
      const unlimitedEmail = await seedPublishedEmail(db, {
        title: "Unlimited reminder",
        document: passReminderEmailDocumentFixture("unlimited-ending"),
      });
      const { campaignId } = await seedDraft();
      const flow = automationFlowFixture({
        trigger: { _tag: "EntryPackExpiring" },
        steps: [{ _tag: "Send", id: "send" }],
      });
      await run(
        lifecycle((service) => service.updateFlow({ campaignId, flow })).pipe(
          permitPassReminders
        )
      );

      // Mismatched trigger email is refused at activation.
      await pool.query(
        "update email_campaigns set email_id = $2, content = '{}'::jsonb where id = $1",
        [campaignId, unlimitedEmail.emailId]
      );
      const mismatchedPreview = await seedPreview(campaignId, {
        status: "completed",
      });
      const { fireAt } = nextPassReminderPreviewOccurrence(
        { _tag: "EntryPackExpiring" },
        now
      );
      await pool.query(
        "update email_campaign_automation_previews set as_of = $2 where id = $1",
        [mismatchedPreview, fireAt.toString()]
      );
      expect(
        (
          await failure(
            lifecycle((service) =>
              service.activate({
                campaignId,
                previewId: mismatchedPreview,
                activatedBy: null,
              })
            ).pipe(permitPassReminders)
          )
        )._tag
      ).toBe("AutomationFlowInvalid");

      // Matching trigger email changes draft hash when republished and freezes its version on activation.
      await pool.query(
        "update email_campaigns set email_id = $2 where id = $1",
        [campaignId, entryEmail.emailId]
      );
      const hashV1 = await draftHash(campaignId);
      const [v2] = (
        await pool.query<{ id: string }>(
          `insert into email_versions (email_id, version_number, document, required_value_names)
             select email_id, 2, document, required_value_names
               from email_versions where id = $1
             returning id`,
          [entryEmail.versionId]
        )
      ).rows;
      const hashV2 = await draftHash(campaignId);
      expect(hashV2).not.toBe(hashV1);

      const previewId = await seedPreview(campaignId, { status: "completed" });
      await pool.query(
        "update email_campaign_automation_previews set as_of = $2 where id = $1",
        [previewId, fireAt.toString()]
      );
      await run(
        lifecycle((service) =>
          service.activate({ campaignId, previewId, activatedBy: null })
        ).pipe(permitPassReminders)
      );
      const {
        rows: [frozen],
      } = await pool.query<{
        email_id: string | null;
        frozen_email_version_id: string | null;
      }>(
        "select email_id, frozen_email_version_id from email_campaign_automation_versions where campaign_id = $1",
        [campaignId]
      );
      expect(frozen).toEqual({
        email_id: entryEmail.emailId,
        frozen_email_version_id: requireValue(v2, "published email version").id,
      });
      await run(lifecycle((service) => service.archive(campaignId)));
    });

    describe("pass reminder campaign ownership", () => {
      const permitPassReminders = Effect.provideService(
        PassReminderWritesOpen,
        Effect.succeed(true)
      );

      const previewPassReminder = async (
        campaignId: CampaignId,
        tag: "EntryPackExpiring" | "UnlimitedEnding",
        at = now
      ) => {
        const trigger = { _tag: tag };
        const flow = automationFlowFixture({
          trigger,
          steps: [{ _tag: "Send", id: "send" }],
        });
        await run(
          lifecycle((service) => service.updateFlow({ campaignId, flow })).pipe(
            permitPassReminders
          ),
          at
        );
        const previewId = await seedPreview(campaignId, {
          status: "completed",
        });
        const { fireAt } = nextPassReminderPreviewOccurrence(trigger, at);
        await pool.query(
          "update email_campaign_automation_previews set as_of = $2 where id = $1",
          [previewId, fireAt.toString()]
        );
        return lifecycle((service) =>
          service.activate({ campaignId, previewId, activatedBy: null })
        ).pipe(permitPassReminders);
      };

      test("allows one active campaign per kind and transfers ownership through pause and archive", async () => {
        const first = (await seedDraft()).campaignId;
        const replacement = (await seedDraft()).campaignId;
        const unlimited = (await seedDraft()).campaignId;
        const activateFirst = await previewPassReminder(
          first,
          "EntryPackExpiring"
        );
        const activateReplacement = await previewPassReminder(
          replacement,
          "EntryPackExpiring"
        );
        await run(activateFirst);
        await run(await previewPassReminder(unlimited, "UnlimitedEnding"));
        expect(await failure(activateReplacement)).toMatchObject({
          _tag: "AutomationTriggerInUse",
          campaignId: replacement,
        });
        expect((await automationRow(replacement)).status).toBe("draft");
        expect(await versionRows(replacement)).toEqual([]);

        await run(lifecycle((service) => service.pause(first)));
        await run(activateReplacement);
        await run(
          lifecycle((service) =>
            service.updateFlow({ campaignId: first, flow: bookedSendFlow })
          )
        );
        const resumeFirst = lifecycle((service) => service.resume(first)).pipe(
          permitPassReminders
        );
        expect(await failure(resumeFirst)).toMatchObject({
          _tag: "AutomationTriggerInUse",
          campaignId: first,
        });
        expect((await automationRow(first)).status).toBe("paused");
        await run(lifecycle((service) => service.archive(replacement)));
        await run(resumeFirst);

        const switchToUnlimited = await previewPassReminder(
          first,
          "UnlimitedEnding"
        );
        const beforeSwitch = await automationRow(first);
        expect((await failure(switchToUnlimited))._tag).toBe(
          "AutomationTriggerInUse"
        );
        expect(await automationRow(first)).toEqual(beforeSwitch);
        expect(await versionRows(first)).toHaveLength(1);

        await run(lifecycle((service) => service.pause(first)));
        await run(switchToUnlimited);
        expect(await versionRows(first)).toHaveLength(2);
        expect((await failure(resumeFirst))._tag).toBe(
          "AutomationTriggerInUse"
        );
        expect((await automationRow(first)).status).toBe("paused");
        await run(lifecycle((service) => service.archive(unlimited)));
      });

      test("serializes competing activation transactions for the same kind", async () => {
        const first = (await seedDraft()).campaignId;
        const second = (await seedDraft()).campaignId;
        const activateFirst = await previewPassReminder(
          first,
          "EntryPackExpiring"
        );
        const activateSecond = await previewPassReminder(
          second,
          "EntryPackExpiring"
        );
        const outcomes = await Promise.all([
          run(Effect.result(activateFirst)),
          run(Effect.result(activateSecond)),
        ]);
        expect(outcomes).toContainEqual(
          expect.objectContaining({ _tag: "Success" })
        );
        expect(outcomes).toContainEqual(
          expect.objectContaining({
            _tag: "Failure",
            failure: expect.objectContaining({
              _tag: "AutomationTriggerInUse",
            }),
          })
        );
        const campaigns = await Promise.all([
          automationRow(first),
          automationRow(second),
        ]);
        expect(campaigns.map(({ status }) => status).sort()).toEqual([
          "active",
          "draft",
        ]);
        await run(lifecycle((service) => service.archive(first)));
        await run(lifecycle((service) => service.archive(second)));
      });

      test.each(["changes trigger", "stays active"] as const)(
        "rechecks the preview cutoff when the owner %s during an activation wait",
        async (ownerBehavior) => {
          const owner = (await seedDraft()).campaignId;
          const replacement = (await seedDraft()).campaignId;
          const beforeCutoff = Temporal.Instant.from("2026-10-19T07:59:00Z");
          const afterCutoff = beforeCutoff.add({ minutes: 2 });
          await run(
            await previewPassReminder(owner, "EntryPackExpiring", beforeCutoff),
            beforeCutoff
          );
          const activateReplacement = await previewPassReminder(
            replacement,
            "EntryPackExpiring",
            beforeCutoff
          );
          await run(
            lifecycle((service) =>
              service.updateFlow({ campaignId: owner, flow: bookedSendFlow })
            ),
            beforeCutoff
          );
          const editedPreview = await seedPreview(owner, {
            status: "completed",
          });
          const lockKey = [
            "email-pass-reminder-campaign",
            "EntryPackExpiring",
          ] as const;

          const result = await run(
            Effect.gen(function* () {
              const held = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const holder = yield* Effect.forkChild(
                withPostgresAdvisoryLock(
                  Context.get(
                    testDatabase.databasePool.postgres,
                    SqlClient.SqlClient
                  ),
                  lockKey,
                  Deferred.succeed(held, undefined).pipe(
                    Effect.andThen(Deferred.await(release))
                  )
                )
              );
              yield* Deferred.await(held);
              const contender = yield* Effect.forkChild(
                Effect.result(activateReplacement)
              );
              yield* Effect.promise(() =>
                waitForAdvisoryLockWaiter(pool, lockKey)
              );
              yield* TestClock.setTime(afterCutoff.epochMilliseconds);
              if (ownerBehavior === "changes trigger") {
                yield* lifecycle((service) =>
                  service.activate({
                    campaignId: owner,
                    previewId: editedPreview,
                    activatedBy: null,
                  })
                );
              }
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(holder);
              return yield* Fiber.join(contender);
            }),
            beforeCutoff
          );
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "AutomationPreviewRequired" },
          });
          expect((await automationRow(replacement)).status).toBe("draft");
          expect(await versionRows(replacement)).toEqual([]);
          await run(lifecycle((service) => service.archive(owner)));
        }
      );

      test("a replacement resumed at 10:00 cannot take the departing owner's occurrence", async () => {
        const owner = (await seedDraft()).campaignId;
        const replacement = (await seedDraft()).campaignId;
        const cutoff = Temporal.Instant.from("2026-10-19T08:00:00Z");
        const beforeCutoff = cutoff.subtract({ minutes: 1 });
        await run(
          await previewPassReminder(
            replacement,
            "EntryPackExpiring",
            beforeCutoff
          ),
          beforeCutoff
        );
        await run(
          lifecycle((service) => service.pause(replacement)),
          beforeCutoff
        );
        await run(
          await previewPassReminder(owner, "EntryPackExpiring", beforeCutoff),
          beforeCutoff
        );

        await run(
          lifecycle((service) => service.pause(owner)),
          cutoff
        );
        await run(
          lifecycle((service) => service.resume(replacement)).pipe(
            permitPassReminders
          ),
          cutoff
        );
        const { rows } = await pool.query(
          `select accepting_since = $2 as accepts_next_instant,
                  resumed_at = $2 as resumes_next_instant
             from email_campaign_automations where campaign_id = $1`,
          [replacement, cutoff.add({ microseconds: 1 }).toString()]
        );
        expect(rows).toEqual([
          { accepts_next_instant: true, resumes_next_instant: true },
        ]);
        await run(lifecycle((service) => service.archive(replacement)));
      });

      test("first activation at 10:00 starts after that day's occurrence even when the kind is vacant", async () => {
        const { campaignId } = await seedDraft();
        const cutoff = Temporal.Instant.from("2026-10-19T08:00:00Z");
        await run(
          await previewPassReminder(campaignId, "EntryPackExpiring", cutoff),
          cutoff
        );
        const { rows } = await pool.query(
          `select a.accepting_since = $2 as accepts_next_instant,
                  v.activated_at = $2 as activates_next_instant
             from email_campaign_automations a
             join email_campaign_automation_versions v on v.id = a.active_version_id
            where a.campaign_id = $1`,
          [campaignId, cutoff.add({ microseconds: 1 }).toString()]
        );
        expect(rows).toEqual([
          { accepts_next_instant: true, activates_next_instant: true },
        ]);
        await run(lifecycle((service) => service.archive(campaignId)));
      });

      test("checks the preview against the version timestamp when a previous publication is newer than the clock", async () => {
        const cutoff = Temporal.Instant.from("2026-10-19T08:00:00Z");
        const beforeCutoff = cutoff.subtract({ minutes: 1 });
        const { campaignId } = await seedActive(bookedSendFlow, {
          at: cutoff.add({ minutes: 1 }),
        });
        const before = await automationRow(campaignId);
        const activate = await previewPassReminder(
          campaignId,
          "EntryPackExpiring",
          beforeCutoff
        );
        expect((await failure(activate, beforeCutoff))._tag).toBe(
          "AutomationPreviewRequired"
        );
        expect(await automationRow(campaignId)).toEqual(before);
        expect(await versionRows(campaignId)).toHaveLength(1);
      });
    });

    describe("the preview gate (§7.5)", () => {
      test("refuses without a completed dry run of this campaign", async () => {
        const { campaignId } = await seedDraft({ flow: bookedSendFlow });
        const other = await seedDraft({ flow: bookedSendFlow });
        const previews = {
          missing: automationPreviewIdSchema.make(crypto.randomUUID()),
          running: await seedPreview(campaignId, { status: "running" }),
          superseded: await seedPreview(campaignId, { status: "superseded" }),
          failed: await seedPreview(campaignId, { status: "failed" }),
          otherCampaign: await seedPreview(other.campaignId, {
            status: "completed",
          }),
        };

        for (const previewId of Object.values(previews)) {
          const error = await failure(
            lifecycle((l) =>
              l.activate({ campaignId, previewId, activatedBy: null })
            )
          );
          expect(error._tag).toBe("AutomationPreviewRequired");
        }
        expect(await versionRows(campaignId)).toEqual([]);
        expect((await automationRow(campaignId)).status).toBe("draft");
      });

      test("refuses a completed dry run of an older draft", async () => {
        const { campaignId, audienceId } = await seedDraft({
          flow: bookedSendFlow,
        });
        const flowPreview = await seedPreview(campaignId, {
          status: "completed",
        });
        await run(
          lifecycle((l) => l.updateFlow({ campaignId, flow: mondayFlow }))
        );
        expect(
          (
            await failure(
              lifecycle((l) =>
                l.activate({
                  campaignId,
                  previewId: flowPreview,
                  activatedBy: null,
                })
              )
            )
          )._tag
        ).toBe("AutomationDraftChanged");

        // Editing the campaign audience's filter changes the draft too.
        const audiencePreview = await seedPreview(campaignId, {
          status: "completed",
        });
        await pool.query(
          "update email_campaign_audiences set filter = $2 where id = $1",
          [
            audienceId,
            JSON.stringify({
              _tag: "Group",
              operator: "or",
              filters: [],
            }),
          ]
        );
        expect(
          (
            await failure(
              lifecycle((l) =>
                l.activate({
                  campaignId,
                  previewId: audiencePreview,
                  activatedBy: null,
                })
              )
            )
          )._tag
        ).toBe("AutomationDraftChanged");
      });

      test("a completed dry run of the current draft activates it", async () => {
        const { campaignId, audienceId } = await seedDraft({
          flow: mondayFlow,
        });
        const accountId = await seedAccount();
        const previewId = await seedPreview(campaignId, {
          status: "completed",
        });
        const hash = await draftHash(campaignId);

        const version = await run(
          lifecycle((l) =>
            l.activate({ campaignId, previewId, activatedBy: accountId })
          )
        );

        expect(version).toMatchObject({
          campaignId,
          versionNumber: 1,
          draftHash: hash,
          activatedAt: now.toString(),
          audienceId,
          active: true,
          trigger: {
            kind: "schedule",
            frequency: { maxFiresPerHour: 1, firesMoreThanHourly: false },
          },
        });
        expect(version.activatedByEmail).toContain(`automation-${runId}`);
        const automation = await automationRow(campaignId);
        expect(automation.status).toBe("active");
        expect(iso(automation.accepting_since)).toBe("2026-10-19T10:30:00Z");
        // Next Monday 10:00 in Prague, after the switch to winter time.
        expect(iso(automation.next_fire_at)).toBe("2026-10-26T09:00:00Z");

        const detail = await run(lifecycle((l) => l.get(campaignId)));
        expect(detail.activation).toEqual({ _tag: "Published" });
        expect(detail.pendingChanges).toBe(false);
        expect(detail.versionCount).toBe(1);

        // A retried activation returns the version it published.
        const retried = await run(
          lifecycle((l) =>
            l.activate({ campaignId, previewId, activatedBy: accountId })
          ),
          now.add({ minutes: 1 })
        );
        expect(retried).toEqual(version);
        expect(await versionRows(campaignId)).toHaveLength(1);
      });

      test("validates what it publishes", async () => {
        const archivedAudience = await seedDraft({ flow: bookedSendFlow });
        const archivedPreview = await seedPreview(archivedAudience.campaignId, {
          status: "completed",
        });
        await pool.query(
          "update email_campaign_audiences set archived_at = now() where id = $1",
          [archivedAudience.audienceId]
        );
        expect(
          (
            await failure(
              lifecycle((l) =>
                l.activate({
                  campaignId: archivedAudience.campaignId,
                  previewId: archivedPreview,
                  activatedBy: null,
                })
              )
            )
          )._tag
        ).toBe("CampaignAudienceArchived");

        // English-only content leaves an unrestricted audience's Czech
        // recipients without their fallback.
        const english = await seedDraft({ flow: bookedSendFlow });
        const czech = campaignContentFixture("Hello")["cs-CZ"];
        await pool.query(
          "update email_campaigns set content = $2 where id = $1",
          [english.campaignId, JSON.stringify({ "en-US": czech })]
        );
        const englishPreview = await seedPreview(english.campaignId, {
          status: "completed",
        });
        expect(
          (
            await failure(
              lifecycle((l) =>
                l.activate({
                  campaignId: english.campaignId,
                  previewId: englishPreview,
                  activatedBy: null,
                })
              )
            )
          )._tag
        ).toBe("CampaignFallbackContentMissing");

        // A saved audience the conditions name was deleted after the edit.
        const referenced = await insertAudience();
        const missing = await seedDraft({ flow: inAudienceFlow(referenced) });
        const missingPreview = await seedPreview(missing.campaignId, {
          status: "completed",
        });
        await pool.query("delete from email_campaign_audiences where id = $1", [
          referenced,
        ]);
        const error = await failure(
          lifecycle((l) =>
            l.activate({
              campaignId: missing.campaignId,
              previewId: missingPreview,
              activatedBy: null,
            })
          )
        );
        assert(error._tag === "AutomationFlowInvalid");
        expect(error.message).toContain(referenced);
      });

      test("reports the activation rule adapters gate on", async () => {
        const { campaignId } = await seedDraft();
        expect(
          (await run(lifecycle((l) => l.get(campaignId)))).activation
        ).toEqual({ _tag: "PreviewRequired" });

        await run(
          lifecycle((l) => l.updateFlow({ campaignId, flow: bookedSendFlow }))
        );
        const running = await seedPreview(campaignId, { status: "running" });
        expect(
          (await run(lifecycle((l) => l.get(campaignId)))).activation
        ).toEqual({
          _tag: "PreviewRunning",
          previewId: running,
          unitsDone: 1,
          unitsTotal: 2,
        });

        await pool.query(
          "update email_campaign_automation_previews set status = 'completed', completed_at = now() where id = $1",
          [running]
        );
        expect(
          (await run(lifecycle((l) => l.get(campaignId)))).activation
        ).toEqual({
          _tag: "Ready",
          previewId: running,
          draftHash: await draftHash(campaignId),
        });

        // An edit leaves the completed dry run behind.
        await run(
          lifecycle((l) => l.updateFlow({ campaignId, flow: mondayFlow }))
        );
        expect(
          (await run(lifecycle((l) => l.get(campaignId)))).activation
        ).toEqual({ _tag: "PreviewRequired" });
      });
    });

    describe("versions (§1.2.3)", () => {
      test("deleting the activating account and source audience nulls only provenance", async () => {
        const { campaignId, audienceId } = await seedDraft({
          flow: bookedSendFlow,
        });
        const accountId = await seedAccount();
        const previewId = await seedPreview(campaignId, {
          status: "completed",
        });
        const version = await run(
          lifecycle((l) =>
            l.activate({ campaignId, previewId, activatedBy: accountId })
          )
        );
        const before = requireValue(
          (await versionRows(campaignId))[0],
          "first automation version"
        );

        await pool.query('delete from auth."user" where id = $1', [accountId]);
        await pool.query("delete from email_campaign_audiences where id = $1", [
          audienceId,
        ]);

        expect(await versionRows(campaignId)).toEqual([before]);
        const { rows: provenance } = await pool.query(
          `select audience_id, activated_by_account_id
             from email_campaign_automation_version_provenance where version_id = $1`,
          [before.id]
        );
        expect(provenance).toEqual([
          { audience_id: null, activated_by_account_id: null },
        ]);
        const [listed] = await run(
          lifecycle((l) => l.listVersions(campaignId))
        );
        expect(listed).toEqual({
          ...version,
          audienceId: null,
          activatedByEmail: null,
        });
      });

      test("a version can't be updated", async () => {
        const { campaignId } = await seedActive();
        const [version] = await versionRows(campaignId);
        await expect(
          pool.query(
            "update email_campaign_automation_versions set draft_hash = 'x' where id = $1",
            [requireValue(version, "stored automation version").id]
          )
        ).rejects.toThrow();
      });

      test("a new version leaves the status and earlier versions as they were", async () => {
        const { campaignId } = await seedActive(mondayFlow);
        const [v1] = await versionRows(campaignId);
        await run(lifecycle((l) => l.pause(campaignId)));
        await run(
          lifecycle((l) => l.updateFlow({ campaignId, flow: wednesdayFlow }))
        );
        const detail = await run(lifecycle((l) => l.get(campaignId)));
        expect(detail.pendingChanges).toBe(true);
        const previewId = await seedPreview(campaignId, {
          status: "completed",
        });

        const v2 = await run(
          lifecycle((l) =>
            l.activate({ campaignId, previewId, activatedBy: null })
          ),
          now.add({ hours: 1 })
        );

        expect(v2.versionNumber).toBe(2);
        const automation = await automationRow(campaignId);
        expect(automation).toMatchObject({
          status: "paused",
          active_version_id: requireValue(
            (await versionRows(campaignId))[1],
            "second automation version"
          ).id,
          accepting_since: null,
          next_fire_at: null,
        });
        expect((await versionRows(campaignId))[0]).toEqual(
          requireValue(v1, "first automation version")
        );
        const versions = await run(
          lifecycle((l) => l.listVersions(campaignId))
        );
        expect(versions.map((v) => [v.versionNumber, v.active])).toEqual([
          [2, true],
          [1, false],
        ]);
        const v1Detail = await run(
          lifecycle((l) => l.getVersion({ campaignId, versionNumber: 1 }))
        );
        expect(v1Detail.flow).toEqual(mondayFlow);

        // Resuming follows the new calendar: Wednesday 10:00 in Prague.
        await run(
          lifecycle((l) => l.resume(campaignId)),
          now.add({ hours: 2 })
        );
        expect(iso((await automationRow(campaignId)).next_fire_at)).toBe(
          "2026-10-21T08:00:00Z"
        );
      });

      test("saved audiences in conditions stay live, so editing one changes no draft", async () => {
        const referenced = await insertAudience();
        const { campaignId } = await seedActive(inAudienceFlow(referenced));
        await pool.query(
          "update email_campaign_audiences set filter = $2 where id = $1",
          [
            referenced,
            JSON.stringify({ _tag: "Group", operator: "or", filters: [] }),
          ]
        );
        const detail = await run(lifecycle((l) => l.get(campaignId)));
        expect(detail.pendingChanges).toBe(false);
        expect(detail.activation).toEqual({ _tag: "Published" });
      });
    });

    describe("pause, resume and archive (§5.10)", () => {
      test("keeps a published pass reminder paused while writes are closed even if the draft changed", async () => {
        const { campaignId } = await seedDraft();
        const flow = automationFlowFixture({
          trigger: { _tag: "UnlimitedEnding" },
          steps: [{ _tag: "Send", id: "send" }],
        });
        const permit = Effect.provideService(
          PassReminderWritesOpen,
          Effect.succeed(true)
        );
        await run(
          lifecycle((service) => service.updateFlow({ campaignId, flow })).pipe(
            permit
          )
        );
        const previewId = await seedPreview(campaignId, {
          status: "completed",
        });
        const { fireAt } = nextPassReminderPreviewOccurrence(
          { _tag: "UnlimitedEnding" },
          now
        );
        await pool.query(
          "update email_campaign_automation_previews set as_of = $2 where id = $1",
          [previewId, fireAt.toString()]
        );
        await run(
          lifecycle((service) =>
            service.activate({ campaignId, previewId, activatedBy: null })
          ).pipe(permit)
        );
        await run(lifecycle((service) => service.pause(campaignId)));
        await run(
          lifecycle((service) =>
            service.updateFlow({ campaignId, flow: bookedSendFlow })
          )
        );
        const before = await automationRow(campaignId);
        const refused = await failure(
          lifecycle((service) => service.resume(campaignId)).pipe(
            Effect.provideService(PassReminderWritesOpen, Effect.succeed(false))
          )
        );
        expect(refused._tag).toBe("AutomationFlowInvalid");
        expect(await automationRow(campaignId)).toEqual(before);
      });
      const seedRun = async (input: {
        readonly campaignId: CampaignId;
        readonly versionId: AutomationVersionId;
        readonly customerId: string;
        readonly status?: "active" | "sending";
        readonly workUnitId?: string;
        readonly sendId?: string;
      }) => {
        const sending = input.status === "sending";
        const { rows } = await pool.query<{ id: string }>(
          `insert into email_campaign_automation_runs
             (campaign_id, version_id, dotypos_customer_id, trigger_kind, trigger_at,
              status, step_id, phase, step_entered_at, due_at, work_unit_id, send_id)
           values ($1, $2, $3, 'schedule', $4, $5, 'send', $6, $4, $7, $8, $9)
           returning id`,
          [
            input.campaignId,
            input.versionId,
            input.customerId,
            now.toString(),
            input.status ?? "active",
            sending ? null : "ready",
            sending ? null : now.toString(),
            input.workUnitId ?? null,
            input.sendId ?? null,
          ]
        );
        return requireValue(rows[0], "inserted row").id;
      };

      const seedUnit = async (input: {
        readonly campaignId: CampaignId;
        readonly kind: string;
        readonly status: "planned" | "enqueued" | "claimed";
        readonly sendId?: string;
      }) => {
        const claimed = input.status === "claimed";
        const { rows } = await pool.query<{ id: string }>(
          `insert into email_campaign_automation_work_units
             (kind, priority, campaign_id, key, subject, request_cost, status,
              claim_id, claim_expires_at, send_id)
           values ($1, 4, $2, $3, '{}', 1, $4, $5, $6, $7)
           returning id`,
          [
            input.kind,
            input.campaignId,
            `${input.kind}:${crypto.randomUUID()}`,
            input.status,
            claimed ? crypto.randomUUID() : null,
            claimed ? now.add({ minutes: 5 }).toString() : null,
            input.sendId ?? null,
          ]
        );
        return requireValue(rows[0], "inserted row").id;
      };

      const unitStates = async (unitIds: readonly string[]) => {
        const { rows } = await pool.query<{
          id: string;
          status: string;
          cancel_requested_at: Date | null;
        }>(
          `select id, status, cancel_requested_at
             from email_campaign_automation_work_units where id = any($1)`,
          [unitIds]
        );
        return Object.fromEntries(
          rows.map((row) => [
            row.id,
            {
              status: row.status,
              marked: row.cancel_requested_at !== null,
            },
          ])
        );
      };

      /** An active Monday schedule with an entering fire, runs and units. */
      const seedBusy = async () => {
        const active = await seedActive(mondayFlow);
        const { campaignId } = active;
        const versionId = requireValue(
          (await automationRow(campaignId)).active_version_id,
          "active version ID"
        );
        await pool.query(
          `insert into email_campaign_automation_schedule_fires
             (campaign_id, fire_at, version_id, status, chunks_total)
           values ($1, $2, $3, 'entering', 2)`,
          [campaignId, "2026-10-19T08:00:00Z", versionId]
        );
        const sendId = await seedAutomatedSend(db, {
          campaignId,
          versionId,
          purpose: "marketing",
          recipients: [
            {
              dotyposCustomerId: DotyposCustomerIdSchema.make(`send-${runId}`),
            },
          ],
        });
        const units = {
          plannedCondition: await seedUnit({
            campaignId,
            kind: "condition",
            status: "planned",
          }),
          enqueuedChunk: await seedUnit({
            campaignId,
            kind: "fire-chunk",
            status: "enqueued",
          }),
          claimedDeliver: await seedUnit({
            campaignId,
            kind: "deliver",
            status: "claimed",
          }),
          persistedDeliver: await seedUnit({
            campaignId,
            kind: "deliver",
            status: "claimed",
            sendId,
          }),
          plannedPreview: await seedUnit({
            campaignId,
            kind: "preview",
            status: "planned",
          }),
          enqueuedPreview: await seedUnit({
            campaignId,
            kind: "preview",
            status: "enqueued",
          }),
        };
        const runs = {
          planned: await seedRun({
            campaignId,
            versionId,
            customerId: `planned-${runId}`,
            workUnitId: units.plannedCondition,
          }),
          inFlight: await seedRun({
            campaignId,
            versionId,
            customerId: `in-flight-${runId}`,
            workUnitId: units.claimedDeliver,
          }),
          sending: await seedRun({
            campaignId,
            versionId,
            customerId: `send-${runId}`,
            status: "sending",
            sendId,
          }),
        };
        // Units name the runs they own in their subject, as planning does.
        for (const [unitId, runIds] of [
          [units.plannedCondition, [runs.planned]],
          [units.claimedDeliver, [runs.inFlight]],
        ] as const) {
          await pool.query(
            `update email_campaign_automation_work_units
                set subject = jsonb_build_object('runIds', $2::jsonb)
              where id = $1`,
            [unitId, JSON.stringify(runIds)]
          );
        }
        return { campaignId, versionId, units, runs };
      };

      const runStates = async (runIds: readonly string[]) => {
        const { rows } = await pool.query<{
          id: string;
          status: string;
          outcome: string | null;
          work_unit_id: string | null;
          last_kind: string | null;
        }>(
          `select r.id, r.status, r.outcome, r.work_unit_id,
                  (select kind from email_campaign_automation_run_events e
                    where e.run_id = r.id order by sequence desc limit 1) as last_kind
             from email_campaign_automation_runs r where r.id = any($1)`,
          [runIds]
        );
        return Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
      };

      const fireStatus = async (campaignId: CampaignId) => {
        const { rows } = await pool.query<{ status: string }>(
          "select status from email_campaign_automation_schedule_fires where campaign_id = $1",
          [campaignId]
        );
        return rows.map(({ status }) => status);
      };

      test("pause freezes the automation and stops its units", async () => {
        const { campaignId, units, runs } = await seedBusy();
        const pausedAt = now.add({ minutes: 10 });

        const detail = await run(
          lifecycle((l) => l.pause(campaignId)),
          pausedAt
        );

        expect(detail).toMatchObject({
          status: "paused",
          acceptingSince: null,
          nextFireAt: null,
          pausedAt: pausedAt.toString(),
        });
        expect(await fireStatus(campaignId)).toEqual(["dropped"]);
        expect(await unitStates(Object.values(units))).toEqual({
          [units.plannedCondition]: { status: "dropped", marked: false },
          [units.enqueuedChunk]: { status: "enqueued", marked: true },
          [units.claimedDeliver]: { status: "claimed", marked: true },
          // A persisted batch settles whatever the status.
          [units.persistedDeliver]: { status: "claimed", marked: false },
          // A dry run doesn't depend on the status.
          [units.plannedPreview]: { status: "planned", marked: false },
          [units.enqueuedPreview]: { status: "enqueued", marked: false },
        });
        // The dropped unit's run returns to the planner; the others stay
        // with their units until those settle.
        expect(await runStates(Object.values(runs))).toEqual({
          [runs.planned]: {
            status: "active",
            outcome: null,
            work_unit_id: null,
            last_kind: null,
          },
          [runs.inFlight]: {
            status: "active",
            outcome: null,
            work_unit_id: units.claimedDeliver,
            last_kind: null,
          },
          [runs.sending]: {
            status: "sending",
            outcome: null,
            work_unit_id: null,
            last_kind: null,
          },
        });

        // Pausing again returns the current state.
        expect(
          await run(
            lifecycle((l) => l.pause(campaignId)),
            now.add({ hours: 1 })
          )
        ).toEqual(detail);
      });

      test("resume accepts occurrences from now and schedules the next fire", async () => {
        const { campaignId } = await seedActive(mondayFlow);
        await run(lifecycle((l) => l.pause(campaignId)));
        // Monday 26 October, 11:00 in Prague: that day's fire passed while paused.
        const resumedAt = Temporal.Instant.from("2026-10-26T10:00:00Z");

        const detail = await run(
          lifecycle((l) => l.resume(campaignId)),
          resumedAt
        );

        expect(detail).toMatchObject({
          status: "active",
          acceptingSince: resumedAt.toString(),
          nextFireAt: "2026-11-02T09:00:00Z",
        });
        expect(iso((await automationRow(campaignId)).resumed_at)).toBe(
          "2026-10-26T10:00:00Z"
        );
        expect(
          await run(
            lifecycle((l) => l.resume(campaignId)),
            resumedAt.add({ hours: 1 })
          )
        ).toEqual(detail);
      });

      test("archive ends active runs and every unit but a persisted batch", async () => {
        const { campaignId, units, runs } = await seedBusy();
        const runningPreview = await seedPreview(campaignId, {
          status: "running",
        });
        const archivedAt = now.add({ minutes: 10 });

        const detail = await run(
          lifecycle((l) => l.archive(campaignId)),
          archivedAt
        );

        expect(detail).toMatchObject({
          status: "archived",
          acceptingSince: null,
          nextFireAt: null,
          archivedAt: archivedAt.toString(),
        });
        expect(await fireStatus(campaignId)).toEqual(["dropped"]);
        expect(await unitStates(Object.values(units))).toEqual({
          [units.plannedCondition]: { status: "dropped", marked: false },
          [units.enqueuedChunk]: { status: "enqueued", marked: true },
          [units.claimedDeliver]: { status: "claimed", marked: true },
          [units.persistedDeliver]: { status: "claimed", marked: false },
          [units.plannedPreview]: { status: "dropped", marked: false },
          [units.enqueuedPreview]: { status: "enqueued", marked: true },
        });
        const states = await runStates(Object.values(runs));
        expect(states[runs.planned]).toMatchObject({
          status: "ended",
          outcome: "archived",
          last_kind: "archived",
        });
        expect(states[runs.inFlight]).toMatchObject({
          status: "ended",
          outcome: "archived",
          last_kind: "archived",
        });
        // An archived automation can't activate, so its dry run ends.
        const { rows: previews } = await pool.query(
          "select status, error_code from email_campaign_automation_previews where id = $1",
          [runningPreview]
        );
        expect(previews).toEqual([
          { status: "failed", error_code: "automation-archived" },
        ]);
        // A queued batch's recipients are the only emails that still go out.
        expect(states[runs.sending]).toMatchObject({
          status: "sending",
          outcome: null,
        });

        expect(
          await run(
            lifecycle((l) => l.archive(campaignId)),
            now.add({ hours: 1 })
          )
        ).toEqual(detail);
      });

      test("refuses transitions the status doesn't allow", async () => {
        const draft = await seedDraft({ flow: bookedSendFlow });
        for (const transition of ["pause", "resume"] as const) {
          expect(
            await failure(lifecycle((l) => l[transition](draft.campaignId)))
          ).toMatchObject({
            _tag: "AutomationStatusConflict",
            operation: transition,
            status: "draft",
          });
        }

        // A draft that never ran can be archived; then it's over for good.
        await run(lifecycle((l) => l.archive(draft.campaignId)));
        for (const transition of ["pause", "resume"] as const) {
          expect(
            (await failure(lifecycle((l) => l[transition](draft.campaignId))))
              ._tag
          ).toBe("AutomationArchived");
        }
        expect(
          (
            await failure(
              lifecycle((l) =>
                l.updateFlow({ campaignId: draft.campaignId, flow: mondayFlow })
              )
            )
          )._tag
        ).toBe("AutomationArchived");
      });

      test("lifecycle operations refuse a one-off campaign", async () => {
        const { rows } = await pool.query<{ id: CampaignId }>(
          `insert into email_campaigns (title, purpose, template_key, content)
           values ('Once', 'marketing', 'workspace', $1) returning id`,
          [JSON.stringify(campaignContentFixture())]
        );
        const campaignId = requireValue(rows[0], "inserted campaign").id;
        campaignIds.push(campaignId);
        expect((await failure(lifecycle((l) => l.get(campaignId))))._tag).toBe(
          "CampaignDeliveryMismatch"
        );
        expect(
          (await failure(lifecycle((l) => l.pause(campaignId))))._tag
        ).toBe("CampaignDeliveryMismatch");
      });
    });

    test("updateFlow share-locks the saved audiences it names", async () => {
      const { campaignId } = await seedDraft();
      const referenced = await insertAudience();
      // An audience deletion that got there first holds the row.
      const deletion = await holdPostgresTransaction(
        pool,
        "delete from email_campaign_audiences where id = $1",
        [referenced]
      );

      const update = failure(
        lifecycle((l) =>
          l.updateFlow({ campaignId, flow: inAudienceFlow(referenced) })
        )
      );
      await waitForPostgresLockWaiter(pool, {
        condition: "$1 = any(pg_blocking_pids(pid))",
        values: [deletion.pid],
        description: "the flow write to wait on the audience deletion",
      });
      await deletion.commit();

      expect((await update)._tag).toBe("AutomationFlowInvalid");
      expect((await run(lifecycle((l) => l.get(campaignId)))).flow).toBeNull();
    });

    test("updateFlow stores the canonical flow and rejects invalid ones", async () => {
      const { campaignId } = await seedDraft();
      const unordered = automationFlowFixture({
        trigger: {
          _tag: "Schedule",
          calendar: { weekdays: ["wednesday", "monday"], hours: [10] },
        },
        steps: [{ _tag: "Send", id: "send" }],
      });
      const detail = await run(
        lifecycle((l) => l.updateFlow({ campaignId, flow: unordered }))
      );
      expect(detail.flow?.trigger).toEqual({
        _tag: "Schedule",
        calendar: { weekdays: ["monday", "wednesday"], hours: [10] },
      });
      expect(detail.trigger).toEqual({
        kind: "schedule",
        frequency: { maxFiresPerHour: 1, firesMoreThanHourly: false },
      });

      const never = automationFlowFixture({
        trigger: {
          _tag: "Schedule",
          calendar: { daysOfMonth: [31], months: [2] },
        },
        steps: [{ _tag: "Send", id: "send" }],
      });
      expect(
        (
          await failure(
            lifecycle((l) => l.updateFlow({ campaignId, flow: never }))
          )
        )._tag
      ).toBe("AutomationCalendarNeverOccurs");

      const missingAudience = inAudienceFlow(
        campaignAudienceIdSchema.make(crypto.randomUUID())
      );
      expect(
        (
          await failure(
            lifecycle((l) =>
              l.updateFlow({ campaignId, flow: missingAudience })
            )
          )
        )._tag
      ).toBe("AutomationFlowInvalid");
      expect((await run(lifecycle((l) => l.get(campaignId)))).flow).toEqual(
        detail.flow
      );
    });
  }
);
