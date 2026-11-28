import { expect, test } from "bun:test";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  getPassReminderDueAt,
  getPassReminderEndDates,
} from "./pass-reminder-schedule";

const date = plainDateStringSchema.make;

test.each([
  ["2030-03-30", "2030-03-30T09:00:00Z"],
  ["2030-03-31", "2030-03-31T08:00:00Z"],
  ["2030-10-26", "2030-10-26T08:00:00Z"],
  ["2030-10-27", "2030-10-27T09:00:00Z"],
])("fires at 10:00 Prague on %s", (dueDate, expected) => {
  expect(getPassReminderDueAt(date(dueDate)).toString()).toBe(expected);
});

test("counts back from the last usable day shown in the reminder", () => {
  expect(getPassReminderEndDates("entry-pack", date("2027-01-07"))).toEqual({
    lastUsableDate: "2027-01-14",
    validUntil: "2027-01-15",
  });
  expect(getPassReminderEndDates("unlimited", date("2026-11-27"))).toEqual({
    lastUsableDate: "2026-12-02",
    validUntil: "2026-12-03",
  });
});
