import { Command } from "effect/cli";
import packageJson from "./package.json";
import { runCommandLine } from "./src/command-line";
import {
  liveReleaseRuntime,
  releaseCommand,
} from "./src/release/release-command";

/**
 * The fenced Workspace release entry: `bun run release <command>`. It reads
 * `WORKSPACE_STACK_CONFIG` like `alchemy.run.ts` and applies services
 * through a generation-fenced `alchemy deploy`. Its stdout is only the
 * command's JSON result: logs and Alchemy's own output go to stderr.
 */
runCommandLine(
  Command.run(releaseCommand.pipe(Command.provide(liveReleaseRuntime)), {
    version: packageJson.version,
  })
);
