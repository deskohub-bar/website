import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { readJsonFile } from "./json-file";
import { writeFileAtomically } from "./source-instrumentation";

/**
 * Which tests a coverage report counts. A complete report ran every package's
 * tests; a partial one ran a subset, so its counts are a lower bound.
 */
const CoverageScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("complete") }),
  Schema.Struct({
    kind: Schema.Literal("partial"),
    tests: Schema.Array(Schema.String),
  }),
]);

export type CoverageScope = typeof CoverageScope.Type;

/**
 * The source a coverage report measured: the SHA-256 of each source file,
 * keyed by repository-relative path. A file that changed while the tests ran
 * maps to null, because its counts may describe either version.
 */
const SourceManifest = Schema.Struct({
  revision: Schema.String,
  generatedAt: Schema.String,
  scope: CoverageScope,
  /** Exit code of the test command; non-zero means some tests failed. */
  testExitCode: Schema.Int,
  files: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
});

export type SourceManifest = typeof SourceManifest.Type;

const sourceManifestFileName = "coverage-sources.json";

function hashSourceFile(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Hashes each absolute source path, keyed by its repository-relative path. */
export function hashSources(
  repositoryRoot: string,
  sources: ReadonlyArray<string>
): Record<string, string | null> {
  return Object.fromEntries(
    sources.map((source) => [
      relative(repositoryRoot, source),
      hashSourceFile(source),
    ])
  );
}

/** Keeps the hashes both snapshots agree on; a changed file maps to null. */
export function stableHashes(
  before: Readonly<Record<string, string | null>>,
  after: Readonly<Record<string, string | null>>
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(before).map(([path, hash]) => [
      path,
      hash !== null && after[path] === hash ? hash : null,
    ])
  );
}

export function writeSourceManifest(
  outputDirectory: string,
  manifest: SourceManifest
): void {
  writeFileAtomically(
    join(outputDirectory, sourceManifestFileName),
    JSON.stringify(manifest)
  );
}

export function readSourceManifest(outputDirectory: string): SourceManifest {
  const path = join(outputDirectory, sourceManifestFileName);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing; rerun \`bun run coverage\` to record which source the report measured`
    );
  }
  return readJsonFile(SourceManifest, path, "source manifest");
}

/**
 * Whether the report's counts describe the file as it is now: the manifest
 * recorded a stable hash for it and the file still has that content.
 */
export function measuresCurrentSource(
  manifest: SourceManifest,
  repositoryRoot: string,
  relativePath: string
): boolean {
  const recorded = manifest.files[relativePath];
  return (
    recorded !== undefined &&
    recorded !== null &&
    recorded === hashSourceFile(join(repositoryRoot, relativePath))
  );
}
