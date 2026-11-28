import { describe, expect, test } from "bun:test";
import { cn, toClassValue } from "./utils";

describe("class values", () => {
  test("keeps every class clsx reads", () => {
    expect(
      cn("shrink-0", toClassValue(["focus-ring", ["nested"], { active: true }]))
    ).toBe("shrink-0 focus-ring nested active");
  });

  test("drops only the entries clsx ignores", () => {
    expect(
      cn("shrink-0", toClassValue(["focus-ring", () => 0, [Symbol(), "x"]]))
    ).toBe("shrink-0 focus-ring x");
    expect(toClassValue(() => "focus-ring")).toBeUndefined();
  });
});
