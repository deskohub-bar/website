import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { accessWindowStates, secondClock } from "./access-clock";

// The test clock starts at the epoch.
const window = {
  startsAt: DateTime.makeUnsafe(2_000),
  endsAt: DateTime.makeUnsafe(4_000),
};

const runWithTestClock = <A>(effect: Effect.Effect<A>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

describe("secondClock", () => {
  test("reads the time at once, then once a second", async () => {
    await runWithTestClock(
      Effect.gen(function* () {
        const ticks: Array<number> = [];
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(Stream.take(secondClock, 3), (tick) =>
            Effect.sync(() => void ticks.push(DateTime.toEpochMillis(tick)))
          )
        );
        yield* TestClock.adjust("0 seconds");
        expect(ticks).toEqual([0]);
        yield* TestClock.adjust("1 second");
        expect(ticks).toEqual([0, 1_000]);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        expect(ticks).toEqual([0, 1_000, 2_000]);
      })
    );
  });
});

describe("accessWindowStates", () => {
  test("crosses the start and the end, then stops ticking", async () => {
    const states = await runWithTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(accessWindowStates(window))
        );
        // Far past the end: a clock that kept ticking would never finish.
        yield* TestClock.adjust("1 minute");
        return yield* Fiber.join(fiber);
      })
    );

    // Ticks at 0, 1, 2 (exactly the start), 3 and 4 s (exactly the end).
    expect(states.map((state) => state._tag)).toEqual([
      "Upcoming",
      "Upcoming",
      "Open",
      "Open",
      "Ended",
    ]);
  });

  test("ends at once for a window already over", async () => {
    const states = await runWithTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust("5 seconds");
        return yield* Stream.runCollect(accessWindowStates(window));
      })
    );

    expect(states.map((state) => state._tag)).toEqual(["Ended"]);
  });
});
