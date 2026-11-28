import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { entriesAtBatchPositions } from "./batch-positions";

const entries = [10, 11, 12] as const;

describe("entriesAtBatchPositions", () => {
  test("returns the entries at the named positions, in their order", async () => {
    expect(
      await Effect.runPromise(entriesAtBatchPositions(entries, [2, 0]))
    ).toEqual([12, 10]);
  });

  for (const [name, position] of [
    ["past the end", 3],
    ["negative", -1],
    ["fractional", 0.5],
  ] as const) {
    test(`dies on a ${name} position`, async () => {
      const exit = await Effect.runPromiseExit(
        entriesAtBatchPositions(entries, [0, position])
      );
      expect(Exit.hasDies(exit)).toBe(true);
    });
  }
});
