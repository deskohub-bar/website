import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Option, Schema } from "effect";
import type { E2EEnvironment } from "../e2e-env";
import {
  githubActionsRunIdSchema,
  workspaceE2ERunIdSchema,
} from "../run-identifiers";
import { workspaceDir, writeJsonAtomically } from "../runtime";
import { type E2ERunContext, makeE2ERunContext } from "../services/telemetry";

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const workspaceE2ERunContextSchema = Schema.Struct({
  allocation: Schema.Struct({
    fromOffsetDays: Schema.Int,
    shardCount: positiveInteger,
    shardIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    toOffsetDays: Schema.Int,
  }).check(
    Schema.makeFilter(
      ({ fromOffsetDays, shardCount, shardIndex, toOffsetDays }) =>
        shardIndex < shardCount && fromOffsetDays <= toOffsetDays
    )
  ),
  executionContext: Schema.Literals(["ci", "manual"]),
  githubRunAttempt: Schema.optionalKey(positiveInteger),
  githubRunId: Schema.optionalKey(githubActionsRunIdSchema),
  prNumber: Schema.optionalKey(positiveInteger),
  runId: workspaceE2ERunIdSchema,
  targetSha: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
  ),
});
const decodeRunContext = Schema.decodeOption(
  Schema.fromJsonString(workspaceE2ERunContextSchema)
);

const runContextPath = resolve(
  workspaceDir,
  "e2e-artifacts",
  "checkout",
  "run-context.json"
);

export const writeWorkspaceE2ERunContext = async (value: E2ERunContext) =>
  writeJsonAtomically(runContextPath, value);

export const readWorkspaceE2ERunContext = async (): Promise<E2ERunContext> =>
  parseRunContext(await readFile(runContextPath, "utf8"));

// Only a confirmed missing file counts as absent; any other access failure
// reports the context as present so its cleanup still runs.
export const hasWorkspaceE2ERunContext = (): Promise<boolean> =>
  access(runContextPath).then(
    () => true,
    (cause: unknown) =>
      !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
  );

/**
 * The run context the launcher passes every Playwright invocation, or a fresh
 * manual one when a config runs on its own.
 */
export const resolveWorkspaceE2ERunContext = (
  environment: E2EEnvironment
): E2ERunContext => {
  const serialized = environment.WORKSPACE_E2E_RUN_CONTEXT;
  return serialized
    ? parseRunContext(serialized)
    : makeE2ERunContext(environment);
};

const parseRunContext = (serialized: string): E2ERunContext => {
  return Option.getOrThrowWith(
    decodeRunContext(serialized),
    () => new Error("Invalid workspace E2E run context")
  );
};
