import "server-only";

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  emailCampaignAutomations as automations,
  emailCampaigns as campaigns,
  emailCampaignAutomationVersions as versions,
} from "@/db/schema";
import { getPassReminderDueAt } from "@/features/passes/pass-reminder-schedule";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { planAutomationUnits } from "./automation-unit-planning";
import { plannedPassReminderPage } from "./pass-reminder-intake";
import { PassReminderWritesOpen } from "./pass-reminder-write-policy";

export const planPassReminderPages = Effect.fn("passReminderIntake.plan")(
  function* (at: Temporal.Instant) {
    const dueDate = plainDateStringSchema.make(getWorkspaceDate(at).toString());
    const dueAt = getPassReminderDueAt(dueDate);
    if (Temporal.Instant.compare(dueAt, at) > 0) return 0;

    const { db, transaction } = yield* WorkspaceDatabase;
    // Filter by kind only after selecting the version in force at 10:00.
    const publishedAtFire = db
      .selectDistinctOn([versions.campaignId], {
        campaignId: versions.campaignId,
        versionId: versions.id,
        purpose: versions.purpose,
        trigger: versions.triggerKind,
      })
      .from(versions)
      .innerJoin(automations, eq(automations.campaignId, versions.campaignId))
      .innerJoin(campaigns, eq(campaigns.id, versions.campaignId))
      .where(
        and(
          eq(campaigns.status, "active"),
          lte(automations.acceptingSince, dueAt),
          lte(versions.activatedAt, dueAt)
        )
      )
      .orderBy(versions.campaignId, desc(versions.activatedAt))
      .as("pass_reminder_versions_at_fire");

    const eligible = yield* db
      .select()
      .from(publishedAtFire)
      .where(
        and(
          eq(publishedAtFire.purpose, "marketing"),
          inArray(publishedAtFire.trigger, [
            "EntryPackExpiring",
            "UnlimitedEnding",
          ])
        )
      );
    if (eligible.length === 0) return 0;
    const open = yield* PassReminderWritesOpen;
    if (!(yield* open)) return 0;

    // The consumer verifies the version under the lifecycle lock.
    const result = yield* transaction(
      planAutomationUnits(
        eligible.map(({ campaignId, versionId, trigger }) =>
          plannedPassReminderPage({
            campaignId,
            versionId,
            kind: trigger === "EntryPackExpiring" ? "entry-pack" : "unlimited",
            dueDate,
          })
        ),
        at
      )
    );
    return result.written.length;
  }
);
