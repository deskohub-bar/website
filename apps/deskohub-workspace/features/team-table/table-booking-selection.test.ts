import { describe, expect, test } from "bun:test";
import { getTableBookingPriceRequest } from "./table-booking-form-values";
import {
  getTableBookingSelection,
  getTableBookingTimes,
} from "./table-booking-selection";

const bookingWindow = {
  today: "2026-11-27",
  now: Temporal.Instant.from("2026-11-27T14:00:00Z"),
  capacities: [4, 6],
};

describe("Team Table booking selection", () => {
  test("opens a size from live inventory and keeps a valid linked date and slot", () => {
    expect(
      getTableBookingSelection(
        { seats: 6, date: "2026-12-01", startTime: "09:15", endTime: "10:00" },
        bookingWindow
      )
    ).toEqual({
      seats: 6,
      date: "2026-12-01",
      startTime: "09:15",
      endTime: "10:00",
    });
  });

  test("does not take a time from an unsupported size or out-of-range date", () => {
    expect(
      getTableBookingSelection(
        { seats: 3, date: "2027-05-28", startTime: "09:15", endTime: "10:00" },
        bookingWindow
      )
    ).toEqual({ seats: 4, date: "2026-11-27", startTime: "", endTime: "" });
  });

  test("drops a linked start outside the 15-minute grid and a slot at its exclusive end", () => {
    const date = bookingWindow.today;
    for (const [startTime, endTime] of [
      ["15:07", "16:00"],
      ["14:45", "15:00"],
    ]) {
      expect(
        getTableBookingSelection(
          { date, seats: 4, startTime, endTime },
          bookingWindow
        )
      ).toEqual({ date, seats: 4, startTime: "", endTime: "" });
    }
  });

  test("does not advertise an expired interval", () => {
    expect(
      getTableBookingPriceRequest(
        { date: "2025-11-27", seats: 4, startTime: "09:00", endTime: "09:15" },
        { locale: "en-US" }
      )
    ).toBeUndefined();
  });

  test("uses only the selected start's ends for the current size and date", () => {
    const available = {
      date: "2026-12-01",
      seats: 4,
      availableStarts: ["09:00", "09:15"],
      availableEndsByStart: [
        { startTime: "09:00", endTimes: ["09:15", "09:30"] },
        { startTime: "09:15", endTimes: ["09:30"] },
      ],
    };
    const selection = {
      date: "2026-12-01",
      seats: 4,
      startTime: "09:15",
      endTime: "09:30",
    };

    expect(getTableBookingTimes(available, selection)).toEqual({
      startTimes: ["09:00", "09:15"],
      endTimes: ["09:30"],
    });
    expect(getTableBookingTimes(available, { ...selection, seats: 6 })).toEqual(
      {
        startTimes: [],
        endTimes: [],
      }
    );
    expect(
      getTableBookingTimes(available, { ...selection, date: "2026-12-02" })
    ).toEqual({ startTimes: [], endTimes: [] });
  });
});
