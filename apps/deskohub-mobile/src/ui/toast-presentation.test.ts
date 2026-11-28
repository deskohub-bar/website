import { describe, expect, test } from "bun:test";
import { noToast, toastAfter, toastBottomOffset } from "./toast-presentation";
import { space } from "./tokens";

describe("toast state", () => {
  test("a dismissal clears only the toast it names", () => {
    const first = toastAfter(noToast, {
      kind: "show",
      request: { message: "first" },
    });
    const second = toastAfter(first, {
      kind: "show",
      request: { message: "second" },
    });
    const firstId = first.shown?.id ?? -1;
    const secondId = second.shown?.id ?? -1;
    // The replaced toast's timer fires late: the new toast stays.
    expect(
      toastAfter(second, { kind: "dismiss", id: firstId }).shown?.message
    ).toBe("second");
    expect(
      toastAfter(second, { kind: "dismiss", id: secondId }).shown
    ).toBeUndefined();
  });
});

describe("toast placement", () => {
  test("sits a gap above the bottom safe area", () => {
    expect(toastBottomOffset(24, [])).toBe(24 + space.md);
  });

  test("sits a gap above the tallest registered bottom chrome", () => {
    expect(toastBottomOffset(24, [80, 56])).toBe(80 + space.md);
  });

  test("chrome lower than the safe area doesn't pull it down", () => {
    expect(toastBottomOffset(24, [10])).toBe(24 + space.md);
  });
});
