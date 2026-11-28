import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import type {
  CustomerTeamTableCalendar,
  CustomerTeamTableSlots,
} from "@deskohub/workspace-customer-api";
import { youOnly } from "./office-people";
import {
  openingTeamTableDraft,
  type TeamTableDraft,
  teamTableSelection,
} from "./team-table-selection";

const date = "2026-11-28";
const beforeBooking = new Date("2026-11-28T10:00:00Z");
const calendar: CustomerTeamTableCalendar = {
  seats: 4,
  from: "2026-11-27",
  to: "2027-05-27",
  unavailableDates: ["2026-11-30"],
};
const slots: CustomerTeamTableSlots = {
  date,
  seats: 4,
  slotMinutes: 15,
  usableFrom: "00:00",
  usableUntil: null,
  availableStarts: ["23:30", "23:45"],
  availableEndsByStart: [
    { startTime: "23:30", endTimes: ["23:45", "00:00", "00:15"] },
    { startTime: "23:45", endTimes: ["00:00"] },
  ],
};
const draft: TeamTableDraft = {
  seats: 4,
  date,
  startTime: "23:30",
  endTime: "00:15",
  people: youOnly,
};

describe("teamTableSelection", () => {
  test("offers just the live starts and each start's ends, including tomorrow", () => {
    const model = teamTableSelection(draft, calendar, slots, beforeBooking);

    expect(model.starts).toEqual(["23:30", "23:45"]);
    expect(model.ends).toEqual(["23:45", "00:00", "00:15"]);
    expect(model.selection).toEqual({
      family: "table",
      seats: 4,
      date,
      startTime: "23:30",
      endTime: "00:15",
    });

    expect(
      teamTableSelection(
        { ...draft, startTime: "23:45" },
        calendar,
        slots,
        beforeBooking
      )
    ).toMatchObject({ ends: ["00:00"], selection: undefined });
  });

  test("drops elapsed ends as the Prague clock advances with the slot response cached", () => {
    const now = new Date("2026-11-28T22:45:00Z");
    const endingNow = { ...draft, endTime: "23:45" };
    expect(teamTableSelection(endingNow, calendar, slots, now)).toMatchObject({
      starts: ["23:30", "23:45"],
      ends: ["00:00", "00:15"],
      selection: undefined,
    });
  });

  test("uses the six-month calendar and rejects a blocked date or stale slots", () => {
    const blockedDate = "2026-11-30";
    const blocked = teamTableSelection(
      { ...draft, date: blockedDate },
      calendar,
      { ...slots, date: blockedDate },
      beforeBooking
    );
    expect(blocked.dates).toEqual({
      earliest: "2026-11-27",
      latest: "2027-05-27",
      unavailable: new Set([blockedDate]),
    });
    expect(blocked).toMatchObject({ dateAvailable: false, starts: [] });
    expect(
      teamTableSelection(draft, calendar, { ...slots, seats: 2 }, beforeBooking)
        .starts
    ).toEqual([]);
    expect(
      teamTableSelection(draft, { ...calendar, seats: 2 }, slots, beforeBooking)
        .dates
    ).toBeUndefined();
  });

  test("restores the selection and invitees, counting the booker when attending", () => {
    const people = {
      contactAttends: true,
      invitees: [
        testEmailAddress("one"),
        testEmailAddress("two"),
        testEmailAddress("three"),
        testEmailAddress("four"),
      ],
    };
    const restored = openingTeamTableDraft(
      2,
      {
        family: "table",
        date,
        startTime: "23:30",
        endTime: "00:15",
        seats: 4,
      },
      people
    );
    expect(restored).toEqual({ ...draft, people });
    expect(
      teamTableSelection(restored, calendar, slots, beforeBooking)
    ).toMatchObject({
      withinCapacity: false,
      selection: undefined,
    });
    const withoutBooker = {
      ...restored,
      people: { ...people, contactAttends: false },
    };
    expect(
      teamTableSelection(withoutBooker, calendar, slots, beforeBooking)
    ).toMatchObject({
      withinCapacity: true,
      selection: { family: "table", seats: 4 },
    });
  });
});
