import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";

export type PassReminderKind = "entry-pack" | "unlimited";

const reminderLeadDays = { "entry-pack": 7, unlimited: 5 } as const;

export const getPassReminderDueAt = (dueDate: PlainDate) =>
  Temporal.PlainDate.from(dueDate)
    .toZonedDateTime({
      timeZone: workspaceSiteConstants.location.timeZone,
      plainTime: "10:00",
    })
    .toInstant();

export const getPassReminderEndDates = (
  kind: PassReminderKind,
  dueDate: PlainDate
) => {
  const lastDay = Temporal.PlainDate.from(dueDate).add({
    days: reminderLeadDays[kind],
  });
  return {
    lastUsableDate: plainDateStringSchema.make(lastDay.toString()),
    validUntil: plainDateStringSchema.make(lastDay.add({ days: 1 }).toString()),
  };
};
