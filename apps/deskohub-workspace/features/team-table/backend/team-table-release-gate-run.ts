import { Effect, Layer, Option } from "effect";
import { releaseGateForRun } from "@/features/feature-flags/backend/release-gate-run";
import { TeamTableReleaseGate } from "./team-table-release-gate";

const decideTeamTableReleaseForRun = releaseGateForRun(TeamTableReleaseGate, {
  whenRunFails: "reject",
});

/** Standalone availability decides the release once. Nested work reuses it. */
export const TeamTableReleaseGateForRun = Layer.unwrap(
  Effect.serviceOption(TeamTableReleaseGate).pipe(
    Effect.map(
      Option.match({
        onNone: () => decideTeamTableReleaseForRun,
        onSome: (gate) => Layer.succeed(TeamTableReleaseGate, gate),
      })
    )
  )
);
