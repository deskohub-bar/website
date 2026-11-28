import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
import * as Runtime from "effect/Runtime";
import type * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

/**
 * Every Effect log, Alchemy's included, goes to stderr, so a command's
 * stdout holds only what it prints on purpose, such as a JSON result.
 */
export const withLogsOnStderr = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.provideService(self, Logger.LogToStderr, true);

/**
 * Run a command-line program on Bun with its logs on stderr, the layers
 * it builds included. A failure is reported here, as `runMain` would
 * report it, but inside that scope: `runMain`'s own report runs outside
 * it and would reach stdout. The process still exits nonzero.
 */
export const runCommandLine = <A, E>(
  program: Effect.Effect<A, E, BunServices.BunServices>
) =>
  BunRuntime.runMain(
    program.pipe(
      Effect.provide(BunServices.layer),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) ||
        !Runtime.getErrorReported(Cause.squash(cause))
          ? Effect.void
          : Effect.logError(cause)
      ),
      withLogsOnStderr
    ),
    { disableErrorReporting: true }
  );

/**
 * A child's exit code, with everything it writes to a piped stdout
 * forwarded to this process's stderr: a child's progress never mixes into
 * the parent's own stdout result.
 */
export const exitCodeWithOutputOnStderr = (
  handle: ChildProcessHandle,
  stdio: Stdio.Stdio
) =>
  Effect.all([Stream.run(handle.stdout, stdio.stderr()), handle.exitCode], {
    concurrency: 2,
  }).pipe(Effect.map(([, exitCode]) => exitCode));
