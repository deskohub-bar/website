import { expect, test } from "bun:test";
import {
  getOpenSpaceServiceDay,
  isOpenSpaceDayCutoffReached,
} from "./open-space-hours";

test("uses the full Prague service date when the daily cutoff is absent", () => {
  const serviceDate = Temporal.PlainDate.from("2026-03-29");

  for (const hours of [{}, { openSpaceUsableUntil: null }]) {
    expect(getOpenSpaceServiceDay(serviceDate, hours)).toEqual({
      startsAt: "2026-03-29T00:00",
      endsAt: "2026-03-30T00:00",
    });
    expect(
      isOpenSpaceDayCutoffReached(
        serviceDate.toString(),
        Temporal.Instant.from("2026-03-29T20:00:00Z"),
        hours
      )
    ).toBe(false);
  }
});

test("honors the exact configured Prague-local minute", () => {
  const date = Temporal.PlainDate.from("2026-03-29");
  const hours = { openSpaceUsableUntil: "16:30" };

  expect(getOpenSpaceServiceDay(date, hours).endsAt).toBe("2026-03-29T16:30");
  expect(
    isOpenSpaceDayCutoffReached(
      date.toString(),
      Temporal.Instant.from("2026-03-29T14:29:59.999999Z"),
      hours
    )
  ).toBe(false);
  expect(
    isOpenSpaceDayCutoffReached(
      date.toString(),
      Temporal.Instant.from("2026-03-29T14:30Z"),
      hours
    )
  ).toBe(true);
});
