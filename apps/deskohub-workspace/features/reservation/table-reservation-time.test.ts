import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import "@/shared/polyfills/temporal";
import {
  getTableReservationInterval,
  isTableReservationBookable,
} from "./table-reservation-time";

describe("Team Table intervals", () => {
  test("only accepts quarter-hour boundaries within the Open Space day", () => {
    const date = "2026-11-27";
    expect(getTableReservationInterval(date, "16:45", "17:00")).toEqual({
      startsAt: "2026-11-27T15:45:00Z",
      endsAt: "2026-11-27T16:00:00Z",
    });
    expect(getTableReservationInterval(date, "16:45", "17:15")).toBeNull();
    expect(getTableReservationInterval(date, "15:01", "16:00")).toBeNull();
    expect(getTableReservationInterval(date, "16:45", "00:00")).toBeNull();
  });

  test("uses elapsed time across midnight and DST when Open Space is always open", () => {
    const hours = { openSpaceUsableUntil: null };
    expect(
      getTableReservationInterval("2026-03-28", "23:45", "00:15", hours)
    ).toEqual({
      startsAt: "2026-03-28T22:45:00Z",
      endsAt: "2026-03-28T23:15:00Z",
    });
    expect(
      getTableReservationInterval("2026-03-29", "00:00", "00:00", hours)
    ).not.toBeNull();
    expect(
      getTableReservationInterval("2026-10-25", "00:00", "00:00", hours)
    ).toBeNull();
    expect(
      getTableReservationInterval("2026-10-25", "02:00", "03:00", hours)
    ).toBeNull();
  });

  test("can sell a slot after it starts up to its exclusive end", () => {
    const interval = getTableReservationInterval(
      "2026-11-27",
      "16:45",
      "17:00"
    );
    assert(interval);
    expect(
      isTableReservationBookable(
        interval,
        Temporal.Instant.from("2026-11-27T15:55Z")
      )
    ).toBe(true);
    expect(
      isTableReservationBookable(
        interval,
        Temporal.Instant.from("2026-11-27T16:00Z")
      )
    ).toBe(false);
    expect(
      isTableReservationBookable(
        interval,
        Temporal.Instant.from("2026-05-26T12:00Z")
      )
    ).toBe(false);
  });
});
