import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { readJsonFile } from "./json-file";
import { writeFileAtomically } from "./source-instrumentation";

/** Names the run directory of the coverage run a test process belongs to. */
export const coverageRunDirectoryVariable = "DESKOHUB_COVERAGE_RUN_DIR";

const CoverageRun = Schema.Struct({
  /** Absolute paths of every source file the report must include. */
  sources: Schema.Array(Schema.String),
  /** Instrumented-code cache shared across runs. */
  cacheDirectory: Schema.String,
});

export type CoverageRun = typeof CoverageRun.Type;

const runFile = (runDirectory: string) => join(runDirectory, "run.json");
export const coverageDumpDirectory = (runDirectory: string) =>
  join(runDirectory, "dumps");

export function writeCoverageRun(runDirectory: string, run: CoverageRun): void {
  writeFileAtomically(runFile(runDirectory), JSON.stringify(run));
}

export function readCoverageRun(runDirectory: string): CoverageRun {
  return readJsonFile(CoverageRun, runFile(runDirectory), "coverage run file");
}

/** Paths of the coverage dumps test processes wrote for the run. */
export function coverageDumpFiles(runDirectory: string): string[] {
  const directory = coverageDumpDirectory(runDirectory);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(directory, name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
