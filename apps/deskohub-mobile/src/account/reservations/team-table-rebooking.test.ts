import { expect, test } from "bun:test";
import { teamTableRebookingHref } from "./team-table-rebooking";

const product = { kind: "table", seats: 4, durationMinutes: 90 } as const;

test("Book again keeps the Prague date, size and a slot crossing midnight", () => {
  expect(
    teamTableRebookingHref({
      product,
      startsAt: "2026-11-30T22:30:00Z",
      endsAt: "2026-12-01T00:00:00Z",
    })
  ).toBe(
    "/book/table?date=2026-11-30&seats=4&startTime=23%3A30&endTime=01%3A00"
  );
});

test("Book again opens Team Table without preselecting an ambiguous Prague time", () => {
  expect(
    teamTableRebookingHref({
      product,
      startsAt: "2026-10-25T00:00:00Z",
      endsAt: "2026-10-25T01:30:00Z",
    })
  ).toBe("/book/table");
});
