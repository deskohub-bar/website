import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stdio from "effect/Stdio";
import { exitCodeWithOutputOnStderr } from "../command-line";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  ReleaseServiceApply,
  ReleaseServiceApplyFailed,
  type StackApplyRequest,
} from "./release-platform";

/**
 * The variable that switches `alchemy.run.ts` to fenced service apply: the
 * stack declares the release-owned services only from a record at exactly
 * this generation.
 */
export const releaseApplyGenerationVariable = "WORKSPACE_RELEASE_GENERATION";

/**
 * The variable that carries the writer lock's secret token to the stack.
 * Every run of a stage that serves releases refuses without the token of
 * the lock the release record holds.
 */
export const releaseWriterVariable = "WORKSPACE_RELEASE_WRITER";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The Alchemy CLI this package installs, never one resolved at run time. */
const alchemyCli = join(packageRoot, "node_modules", ".bin", "alchemy");

/**
 * `alchemy deploy` or `alchemy plan` of this package's stack for the
 * config's stage. The child gets the writer token and exactly the fence the
 * request names: an inherited generation never turns a plain run fenced.
 * Output streams to the caller's console.
 */
export const alchemyStackCommand = (
  config: WorkspaceStackConfig,
  request: StackApplyRequest
) =>
  ChildProcess.make(
    alchemyCli,
    [
      request.action,
      "alchemy.run.ts",
      "--stage",
      config.stage,
      ...(request.action === "deploy" ? ["--yes"] : []),
      "--no-input",
    ],
    {
      cwd: packageRoot,
      env: {
        [releaseWriterVariable]: request.writer,
        [releaseApplyGenerationVariable]:
          request.generation === null ? undefined : String(request.generation),
      },
      extendEnv: true,
      stdin: "ignore",
      // Forwarded to stderr: the release command's stdout is its result.
      stdout: "pipe",
      stderr: "inherit",
    }
  );

/**
 * A stack apply that runs one command per request and checks its exit. A
 * command that never started changed nothing; once the process exists,
 * any failure leaves the outcome unknown.
 */
export const commandServiceApply = (
  command: (request: StackApplyRequest) => ChildProcess.Command
) =>
  Layer.effect(
    ReleaseServiceApply,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      return ReleaseServiceApply.of({
        apply: (request) => {
          const failed =
            (outcome: ReleaseServiceApplyFailed["outcome"]) =>
            (reason: string) =>
              new ReleaseServiceApplyFailed({
                generation: request.generation,
                outcome,
                reason,
              });
          return spawner.spawn(command(request)).pipe(
            Effect.mapError((error) => failed("not-started")(error.message)),
            Effect.flatMap((handle) =>
              exitCodeWithOutputOnStderr(handle, stdio).pipe(
                Effect.mapError((error) => failed("unknown")(error.message))
              )
            ),
            Effect.flatMap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Effect.fail(
                    failed("unknown")(`The apply exited with code ${exitCode}`)
                  )
            ),
            Effect.scoped
          );
        },
      });
    })
  );

/** The live apply: `alchemy` runs of the config's stage. */
export const alchemyServiceApply = (config: WorkspaceStackConfig) =>
  commandServiceApply((request) => alchemyStackCommand(config, request));
