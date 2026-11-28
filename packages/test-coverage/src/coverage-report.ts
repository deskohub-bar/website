import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  type CoverageMapData,
  createCoverageMap,
  createFileCoverage,
} from "istanbul-lib-coverage";
import { readJsonFile } from "./json-file";
import type { SourceInstrumentation } from "./source-instrumentation";

export type CoverageReport = {
  readonly coverage: CoverageMapData;
  /** Source files at least one test process loaded. */
  readonly loadedFiles: number;
  /** Source files no test loaded, reported with zero counts. */
  readonly unloadedFiles: number;
};

/**
 * Merges the dumps of a run into one Istanbul coverage map that holds every
 * source file, so files no test imports count as unexecuted instead of
 * missing.
 */
export function buildCoverageReport({
  dumpFiles,
  sources,
  instrumentation,
}: {
  readonly dumpFiles: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<string>;
  readonly instrumentation: SourceInstrumentation;
}): CoverageReport {
  const coverage = createCoverageMap({});
  for (const dumpFile of dumpFiles) {
    coverage.merge(readCoverageDump(dumpFile));
  }
  const sourceSet = new Set(sources);
  const loaded = new Set(coverage.files());
  const strayFile = [...loaded].find((file) => !sourceSet.has(file));
  if (strayFile !== undefined) {
    throw new Error(
      `Coverage dump covers ${strayFile}, outside the run's sources`
    );
  }
  for (const source of sources) {
    if (loaded.has(source)) {
      continue;
    }
    coverage.addFileCoverage(
      createFileCoverage(
        instrumentation.unexecutedCoverage(source, readFileSync(source, "utf8"))
      )
    );
  }
  return {
    coverage: coverage.toJSON(),
    loadedFiles: loaded.size,
    unloadedFiles: sources.length - loaded.size,
  };
}

const Location = Schema.Struct({ line: Schema.Int, column: Schema.Int });

const Range = Schema.Struct({ start: Location, end: Location });

const EmptyLocation = Schema.Record(Schema.String, Schema.Never);

/**
 * A branch path's location. Istanbul's instrumenter clones a missing location
 * into `{ start: {}, end: {} }`, as it does for an `if` without an `else`.
 */
const BranchPathLocation = Schema.Union([
  Range,
  Schema.Struct({ start: EmptyLocation, end: EmptyLocation }),
]);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One file's Istanbul coverage. The rest record keeps the fields the merge
 * passes through unread, such as `hash` and `inputSourceMap`.
 */
const FileCoverageData = Schema.StructWithRest(
  Schema.Struct({
    path: Schema.String,
    statementMap: Schema.Record(Schema.String, Range),
    fnMap: Schema.Record(
      Schema.String,
      Schema.Struct({
        name: Schema.String,
        decl: Range,
        loc: Range,
        line: Schema.Int,
      })
    ),
    branchMap: Schema.Record(
      Schema.String,
      Schema.Struct({
        loc: Range,
        type: Schema.String,
        locations: Schema.mutable(Schema.Array(BranchPathLocation)),
        line: Schema.Int,
      })
    ),
    s: Schema.Record(Schema.String, Count),
    f: Schema.Record(Schema.String, Count),
    b: Schema.Record(Schema.String, Schema.mutable(Schema.Array(Count))),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

/** The coverage map a test process dumps, keyed by absolute source path. */
const CoverageDump = Schema.Record(Schema.String, FileCoverageData);

type CoverageDump = typeof CoverageDump.Type;

declare module "istanbul-lib-coverage" {
  interface CoverageMap {
    /**
     * `@types/istanbul-lib-coverage` declares every branch path location
     * complete, but the instrumenter writes empty ones that the merge keys
     * and copies like any other.
     */
    merge(data: CoverageDump): void;
  }
}

function readCoverageDump(dumpFile: string): CoverageDump {
  return readJsonFile(CoverageDump, dumpFile, "coverage dump");
}
