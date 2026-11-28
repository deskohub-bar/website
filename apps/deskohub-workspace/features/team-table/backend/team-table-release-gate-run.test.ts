import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TeamTableReleaseGate } from "./team-table-release-gate";
import { TeamTableReleaseGateForRun } from "./team-table-release-gate-run";

test("a Team Table run reuses its request's supplied release decision", async () => {
  const { requestGate, runGate } = await Effect.runPromise(
    Effect.gen(function* () {
      const requestGate = yield* TeamTableReleaseGate;
      const runGate = yield* TeamTableReleaseGate.pipe(
        Effect.provide(TeamTableReleaseGateForRun)
      );
      return { requestGate, runGate };
    }).pipe(Effect.provide(TeamTableReleaseGate.fromDecision(false)))
  );

  expect(runGate).toBe(requestGate);
  expect(await Effect.runPromise(runGate.isOpen)).toBe(false);
});
