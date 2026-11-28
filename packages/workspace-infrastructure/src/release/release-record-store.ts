import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { ReleaseRecord } from "./release-record";

/**
 * Another writer changed the record after this run read it. The run's
 * decision rests on a superseded record, so it must re-read and decide
 * again; it never overwrites.
 */
export class ReleaseRecordConflict extends Data.TaggedError(
  "ReleaseRecordConflict"
)<{
  readonly expectedVersion: string;
}> {}

/**
 * The stored record does not decode as a release record. Nothing is
 * written over it: an operator restores a known-good object version.
 */
export class ReleaseRecordCorrupt extends Data.TaggedError(
  "ReleaseRecordCorrupt"
)<{
  readonly version: string;
  readonly reason: string;
}> {}

/**
 * The store could not be reached, refused the credentials, or answered
 * outside its contract. For a write the outcome may be unknown; the next
 * read shows whether it landed.
 */
export class ReleaseStoreUnavailable extends Data.TaggedError(
  "ReleaseStoreUnavailable"
)<{
  readonly operation: "read" | "write";
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly reason: string;
}> {}

export type ReleaseStoreFailure =
  | ReleaseRecordCorrupt
  | ReleaseStoreUnavailable;

/**
 * The persisted record behind a compare-and-set. `version` is the store's
 * object generation, `"0"` while no record exists; a write with a stale
 * version fails.
 */
export interface StoredReleaseRecord {
  readonly record: ReleaseRecord;
  readonly version: string;
}

/**
 * The durable home of the release record, outside any CI run. A read of a
 * store that holds no record yet returns the empty record at version `"0"`.
 */
export class ReleaseRecordStore extends Context.Service<
  ReleaseRecordStore,
  {
    readonly read: Effect.Effect<StoredReleaseRecord, ReleaseStoreFailure>;
    readonly write: (
      record: ReleaseRecord,
      ifVersion: string
    ) => Effect.Effect<
      StoredReleaseRecord,
      ReleaseRecordConflict | ReleaseStoreFailure
    >;
  }
>()("@deskohub/workspace-infrastructure/ReleaseRecordStore") {}

/**
 * Run one release step as a serialized read, decide, compare-and-set.
 * Two runs that read the same version cannot both write.
 */
export const runReleaseStep = <A, E, R>(
  step: (
    record: ReleaseRecord
  ) => Effect.Effect<
    { readonly record: ReleaseRecord; readonly result: A },
    E,
    R
  >
) =>
  Effect.gen(function* () {
    const store = yield* ReleaseRecordStore;
    const current = yield* store.read;
    const { record, result } = yield* step(current.record);
    yield* store.write(record, current.version);
    return result;
  });

/** An in-process store for tests and local dry runs. */
export const makeInMemoryReleaseRecordStore = Effect.fn(
  "WorkspaceRelease.makeInMemoryReleaseRecordStore"
)(function* (initial: ReleaseRecord) {
  const state = yield* Ref.make<StoredReleaseRecord>({
    record: initial,
    version: "1",
  });
  return ReleaseRecordStore.of({
    read: Ref.get(state),
    write: (record, ifVersion) =>
      Ref.modify(
        state,
        (
          current
        ): readonly [
          Effect.Effect<StoredReleaseRecord, ReleaseRecordConflict>,
          StoredReleaseRecord,
        ] => {
          if (current.version !== ifVersion) {
            return [
              Effect.fail(
                new ReleaseRecordConflict({ expectedVersion: ifVersion })
              ),
              current,
            ];
          }
          const next: StoredReleaseRecord = {
            record,
            version: String(Number(current.version) + 1),
          };
          return [Effect.succeed(next), next];
        }
      ).pipe(Effect.flatten),
  });
});
