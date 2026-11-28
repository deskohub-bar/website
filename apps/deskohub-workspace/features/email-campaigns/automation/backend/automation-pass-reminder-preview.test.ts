import { expect, test } from "bun:test";
import { sampleEmailTriggerValue } from "@/features/emails/body/pass-reminder-trigger-values";
import { nextPassReminderPreviewOccurrence } from "./automation-pass-reminder-preview";

test.each([
  ["2026-10-24T07:59:59Z", "2026-10-24T08:00:00Z"],
  ["2026-10-24T08:00:00Z", "2026-10-25T09:00:00Z"],
  ["2027-03-27T09:00:01Z", "2027-03-28T08:00:00Z"],
])("chooses the next 10:00 Prague occurrence from %s", (now, expected) => {
  expect(
    nextPassReminderPreviewOccurrence(
      { _tag: "EntryPackExpiring" },
      Temporal.Instant.from(now)
    ).fireAt.toString()
  ).toBe(expected);
});

test("anchors sample trigger dates to the previewed occurrence", () => {
  const occurrence = Temporal.Instant.from("2026-11-27T09:00:00Z");
  const sample = sampleEmailTriggerValue(
    "unlimited-ending",
    "en-US",
    occurrence
  );
  expect(sample._tag).toBe("Resolved");
  if (sample._tag === "Resolved") {
    expect(sample.value).toMatchObject({
      endsOn: "Wed 2 Dec",
      renewalStartsOn: "Thu 3 Dec",
      deskLabel: "Desk 14",
    });
  }
  const nextDay = sampleEmailTriggerValue(
    "unlimited-ending",
    "en-US",
    occurrence.add({ hours: 24 })
  );
  if (nextDay._tag === "Resolved") {
    expect(nextDay.value).toMatchObject({ endsOn: "Thu 3 Dec" });
  }
});

test("omits optional sample fields when requested", () => {
  const occurrence = Temporal.Instant.from("2026-11-27T09:00:00Z");
  const sample = sampleEmailTriggerValue(
    "unlimited-ending",
    "en-US",
    occurrence,
    new Set(["firstName", "deskLabel"])
  );
  expect(sample._tag).toBe("Resolved");
  if (sample._tag === "Resolved") {
    expect(sample.value).toMatchObject({
      firstName: null,
      deskLabel: null,
      tier: "Open Space",
    });
  }
});
