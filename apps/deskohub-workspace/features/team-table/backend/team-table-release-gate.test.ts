import { expect, test } from "bun:test";
import { PostHogFeatureFlagEvaluationError } from "@deskohub/analytics-posthog/feature-flags/node";
import { Effect, Layer } from "effect";
import { WorkspaceFeatureFlagServiceMock } from "@/features/feature-flags/backend/workspace-feature-flag.service.mock";
import { TeamTableReleaseGate } from "./team-table-release-gate";

test("uses the Team Table flag for both live and stored output", async () => {
  const read = (key: string) => Effect.succeed(key === "team_table_page");
  const gate = TeamTableReleaseGate.Default.pipe(
    Layer.provide(
      WorkspaceFeatureFlagServiceMock({ isEnabled: read, decision: read })
    )
  );

  expect(
    await Effect.runPromise(
      Effect.all({
        isOpen: TeamTableReleaseGate.isOpen,
        decision: TeamTableReleaseGate.decision,
      }).pipe(Effect.provide(gate))
    )
  ).toEqual({ isOpen: true, decision: true });
});

test("closes live output and fails stored output when the flag is unavailable", async () => {
  const unavailable = () =>
    Effect.fail(
      new PostHogFeatureFlagEvaluationError({
        cause: undefined,
        message: "Could not evaluate the PostHog feature flag.",
      })
    );
  const gate = TeamTableReleaseGate.Default.pipe(
    Layer.provide(
      WorkspaceFeatureFlagServiceMock({
        isEnabled: unavailable,
        decision: unavailable,
      })
    )
  );

  expect(
    await Effect.runPromise(
      Effect.all({
        isOpen: TeamTableReleaseGate.isOpen,
        decision: TeamTableReleaseGate.decision.pipe(Effect.flip),
      }).pipe(Effect.provide(gate))
    )
  ).toMatchObject({
    isOpen: false,
    decision: {
      _tag: "ReleaseGateUnavailableError",
      flags: ["team_table_page"],
    },
  });
});
