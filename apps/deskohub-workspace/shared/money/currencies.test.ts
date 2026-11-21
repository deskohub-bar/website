import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { unitOf } from "./currencies";

describe("workspace currency catalog", () => {
  test.each(["CZK", "EUR"])("uses two minor-unit decimals for %s", (code) => {
    expect(unitOf(code)).toEqual(Option.some({ currency: code, exponent: 2 }));
  });

  test("gives no unit for a code outside the catalog", () => {
    expect(Option.isNone(unitOf("ZZZ"))).toBe(true);
    expect(Option.isNone(unitOf("czk"))).toBe(true);
    expect(Option.isNone(unitOf(""))).toBe(true);
  });
});
