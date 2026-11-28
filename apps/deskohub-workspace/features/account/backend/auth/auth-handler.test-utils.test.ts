import { describe, expect, test } from "bun:test";
import { Predicate, Schema } from "effect";
import { testDatabase } from "./auth-handler.test-utils";

const decodeAddress = Schema.decodeUnknownSync(Schema.String);
const decodeUniqueIpModule = Schema.decodeUnknownSync(
  Schema.Struct({
    uniqueIp: Schema.declare((value): value is () => unknown =>
      Predicate.isFunction(value)
    ),
  })
);

/**
 * Loads a fresh instance of the helpers, as `bun test --parallel` gives each
 * test file, while every source of randomness returns the same value.
 */
const loadInstance = async (label: string) =>
  decodeUniqueIpModule(
    await import(
      `./auth-handler.test-utils.ts?instance=${label}-${crypto.randomUUID()}`
    )
  );

const takeAddresses = (
  utils: ReturnType<typeof decodeUniqueIpModule>,
  count: number
) => Array.from({ length: count }, () => decodeAddress(utils.uniqueIp()));

describe.skipIf(!testDatabase)("uniqueIp on the shared test database", () => {
  test("helper instances of separate test files never share an address", async () => {
    const random = Math.random;
    Math.random = () => 0.5;
    try {
      const first = await loadInstance("first");
      const second = await loadInstance("second");

      const firstAddresses = takeAddresses(first, 300);
      const secondAddresses = takeAddresses(second, 300);

      expect(new Set(firstAddresses).size).toBe(300);
      expect(
        secondAddresses.filter((address) => firstAddresses.includes(address))
          .length
      ).toBe(0);
    } finally {
      Math.random = random;
    }
  });
});
