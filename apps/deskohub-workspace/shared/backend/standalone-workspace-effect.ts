import { NextEffect } from "@deskohub/next-effect";
import { Effect, Layer } from "effect";
import { WorkspaceLoggerLive } from "./logging/censorship";
import { WorkspaceClockLive } from "./observability/workspace-clock";

/**
 * The process's observability for standalone runs, kept on `globalThis`
 * under this key so every module instance Next.js loads uses it. Scripts
 * that use the runner read no Workspace configuration, so the runner never
 * does either: `instrumentation.ts` sets the container's Cloud Logging
 * observability here before the server takes its first request
 * (`setStandaloneWorkspaceObservability`), and the censoring logfmt logger
 * serves everywhere else.
 */
const standaloneObservabilityKey = Symbol.for(
  "@deskohub-workspace/standalone-observability"
);

// Only this module writes the slot, so the annotation checks those writes;
// it trusts, rather than verifies, a value another module instance stored.
type GlobalWithStandaloneObservability = typeof globalThis & {
  [standaloneObservabilityKey]?: Layer.Layer<never>;
};

/** Makes later standalone runs of the process log and trace through `layer`. */
export const setStandaloneWorkspaceObservability = (
  layer: Layer.Layer<never>
): void => {
  const processGlobals: GlobalWithStandaloneObservability = globalThis;
  processGlobals[standaloneObservabilityKey] = layer;
};

const StandaloneObservabilityLive: Layer.Layer<never> = Layer.unwrap(
  Effect.sync(() => {
    const processGlobals: GlobalWithStandaloneObservability = globalThis;
    return (
      processGlobals[standaloneObservabilityKey] ??
      Layer.merge(WorkspaceLoggerLive, WorkspaceClockLive)
    );
  })
);

const runtime = NextEffect.make({ layer: StandaloneObservabilityLive });

export const runStandaloneWorkspaceEffect = (operation: string) =>
  function runEffect<A, E>(effect: Effect.Effect<A, E, never>) {
    return runtime.run(
      effect.pipe(
        Effect.annotateLogs({
          boundary: "run",
          operation,
        })
      )
    );
  };
