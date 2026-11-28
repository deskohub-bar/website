import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stdio from "effect/Stdio";
import {
  exitCodeWithOutputOnStderr,
  runCommandLine,
} from "../src/command-line";
import type { WorkspaceStackConfig } from "../src/config/stack-config";
import {
  releaseApplyGenerationVariable,
  releaseWriterVariable,
} from "../src/release/alchemy-service-apply";
import {
  liveReleaseRuntime,
  ReleaseStack,
} from "../src/release/release-command";
import {
  HeldReleaseWriter,
  withReleaseWriter,
} from "../src/release/release-writer";
import {
  isLockedStackAction,
  type LockedStackAction,
  lockedStackActions,
  lockedStackInvocation,
} from "./sandbox-locked-stack-actions";

const lockedStackCommand = (
  config: WorkspaceStackConfig,
  action: LockedStackAction,
  writer: Redacted.Redacted<string>
) => {
  const { command, args, cwd } = lockedStackInvocation(action, config.stage);
  return ChildProcess.make(command, args, {
    cwd,
    env: {
      [releaseWriterVariable]: writer,
      [releaseApplyGenerationVariable]: undefined,
    },
    extendEnv: true,
    stdin: "ignore",
    // Forwarded to stderr, as the release command forwards its applies'.
    stdout: "pipe",
    stderr: "inherit",
  });
};

/**
 * Run one action as the lock holder. A mutating run whose exit is not an
 * accepted one leaves the lock in doubt, as an unknown apply outcome does.
 */
const runLocked = Effect.fn("SandboxLockedStack.runLocked")(function* (
  action: LockedStackAction
) {
  const config = yield* ReleaseStack;
  const spec = lockedStackActions[action];
  return yield* withReleaseWriter(
    config,
    spec.operation
  )(
    Effect.gen(function* () {
      const { writer, applyInFlight } = yield* HeldReleaseWriter;
      const spawner = yield* ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      yield* Ref.set(applyInFlight, spec.mutates);
      const exitCode = yield* spawner
        .spawn(lockedStackCommand(config, action, writer.token))
        .pipe(
          Effect.flatMap((handle) => exitCodeWithOutputOnStderr(handle, stdio)),
          Effect.scoped
        );
      if (spec.acceptedExitCodes.some((code) => code === exitCode)) {
        yield* Ref.set(applyInFlight, false);
      }
      return exitCode;
    })
  );
});

if (import.meta.main) {
  const action = process.argv[2];
  if (!isLockedStackAction(action)) {
    console.error(
      `usage: sandbox-locked-stack.ts <${Object.keys(lockedStackActions).join("|")}>`
    );
    process.exit(64);
  }
  runCommandLine(
    runLocked(action).pipe(
      Effect.tap((exitCode) =>
        Effect.sync(() => {
          process.exitCode = exitCode;
        })
      ),
      Effect.provide(
        liveReleaseRuntime.pipe(Layer.provideMerge(BunServices.layer))
      )
    )
  );
}
