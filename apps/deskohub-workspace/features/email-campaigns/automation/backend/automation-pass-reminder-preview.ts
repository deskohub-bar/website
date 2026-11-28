import type { AutomationTriggerType } from "@deskohub/workspace-admin-api";
import {
  getPassReminderDueAt,
  type PassReminderKind,
} from "@/features/passes/pass-reminder-schedule";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { plainDateStringSchema } from "@/shared/utils/temporal";

type PassReminderTrigger = Extract<
  AutomationTriggerType,
  { readonly _tag: "EntryPackExpiring" | "UnlimitedEnding" }
>;

const reminderKind = (trigger: PassReminderTrigger): PassReminderKind =>
  trigger._tag === "EntryPackExpiring" ? "entry-pack" : "unlimited";

export const nextPassReminderPreviewOccurrence = (
  trigger: PassReminderTrigger,
  now: Temporal.Instant
) => {
  const today = getWorkspaceDate(now);
  const todayAt = getPassReminderDueAt(
    plainDateStringSchema.make(today.toString())
  );
  const dueDate = plainDateStringSchema.make(
    (Temporal.Instant.compare(todayAt, now) > 0
      ? today
      : today.add({ days: 1 })
    ).toString()
  );
  return {
    kind: reminderKind(trigger),
    dueDate,
    fireAt: getPassReminderDueAt(dueDate),
  };
};
