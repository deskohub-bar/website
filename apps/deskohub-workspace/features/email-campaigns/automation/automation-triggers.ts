import type {
  AutomationTriggerType as AutomationTrigger,
  AutomationTriggerSummaryType as AutomationTriggerSummary,
} from "@deskohub/workspace-admin-api";
import { Match } from "effect";
import { calendarFrequency } from "@/shared/utils/calendar-expression";
import type { AutomationTriggerKind } from "./automation-states";

/** The kind runs, receipts and the run log record for a flow trigger. */
export const automationTriggerKind = (
  trigger: AutomationTrigger
): AutomationTriggerKind =>
  Match.value(trigger).pipe(
    Match.tagsExhaustive({
      Schedule: () => "schedule" as const,
      ReservationBooked: () => "reservation-booked" as const,
      ReservationCancelled: () => "reservation-cancelled" as const,
      ReservationStarted: () => "reservation-started" as const,
      ReservationFinished: () => "reservation-finished" as const,
      AccountCreated: () => "account-created" as const,
      EntryPackExpiring: () => "entry-pack-expiring" as const,
      UnlimitedEnding: () => "unlimited-ending" as const,
    })
  );

/** Only these triggers carry a pass rather than customer-scoped entry. */
export const isPassReminderTrigger = (
  trigger: AutomationTrigger
): trigger is Extract<
  AutomationTrigger,
  { _tag: "EntryPackExpiring" | "UnlimitedEnding" }
> => trigger._tag === "EntryPackExpiring" || trigger._tag === "UnlimitedEnding";

export const isPassReminderKind = (
  kind: AutomationTriggerKind
): kind is "entry-pack-expiring" | "unlimited-ending" =>
  kind === "entry-pack-expiring" || kind === "unlimited-ending";

/**
 * A trigger's kind with a schedule's frequency, so adapters can warn about
 * a schedule that fires more than hourly without computing it (D33).
 */
export const automationTriggerSummary = (
  trigger: AutomationTrigger
): AutomationTriggerSummary => ({
  kind: automationTriggerKind(trigger),
  frequency:
    trigger._tag === "Schedule" ? calendarFrequency(trigger.calendar) : null,
});
