import { resolve } from "node:path";
import { workspaceDir } from "../runtime";

/** Minimum runs required to compare one task, harness, and locale. */
export const agentEvalMinimumRunsPerCell = 5;

/** The agent eval config's Playwright output directory. */
export const agentEvalOutputDirectory = resolve(
  workspaceDir,
  "e2e-artifacts",
  "agent-evals"
);
