import { describe, expect, test } from "bun:test";
import { reservationKindOf, selectionKey } from "./booking-selection";

describe("selectionKey", () => {
  test("tells apart selections that differ in any field", () => {
    const office = {
      family: "office",
      date: "2026-11-07",
      endDate: "2026-11-09",
      seats: 2,
    } as const;
    const keys = new Set([
      selectionKey(office),
      selectionKey({ ...office, seats: 3 }),
      selectionKey({ ...office, endDate: "2026-11-10" }),
      selectionKey({ ...office, family: "cowork" }),
      selectionKey({
        family: "cowork",
        date: "2026-11-07",
        tier: "open-space",
        coffee: false,
      }),
      selectionKey({
        family: "cowork",
        date: "2026-11-07",
        tier: "open-space",
      }),
    ]);

    expect(keys.size).toBe(6);
  });
});

describe("reservationKindOf", () => {
  test("maps API families to analytics reservation kinds", () => {
    expect(reservationKindOf("cowork")).toBe("cowork");
    expect(reservationKindOf("meeting-room")).toBe("meeting_room");
    expect(reservationKindOf("office")).toBe("office");
  });
});

describe("selectionKey for a cowork stay", () => {
  test("a day and an overnight stay on one date are quoted apart", () => {
    const day = {
      family: "cowork",
      date: "2026-11-17",
      tier: "reserved-desk",
    } as const;
    const overnight = { ...day, stay: "overnight" } as const;

    expect(selectionKey(overnight)).not.toBe(selectionKey(day));
    expect(selectionKey({ ...day, stay: "day" })).not.toBe(
      selectionKey(overnight)
    );
  });
});
