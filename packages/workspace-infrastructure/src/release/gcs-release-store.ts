import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type {
  GcsBucketName,
  WorkspaceStackConfig,
  WorkspaceStage,
} from "../config/stack-config";
import {
  type GoogleApiNoAnswer,
  type GoogleApiRetryPolicy,
  makeGoogleApi,
} from "../google-api";
import { emptyReleaseRecord, ReleaseRecord } from "./release-record";
import {
  ReleaseRecordConflict,
  ReleaseRecordCorrupt,
  ReleaseRecordStore,
  ReleaseStoreUnavailable,
  type StoredReleaseRecord,
} from "./release-record-store";

const cloudStorageApi = "https://storage.googleapis.com";

/**
 * Four retries after the first attempt for 429, 5xx, transport failures
 * and timeouts. The timeout is generous: the store is only called from CI
 * and operator runs.
 */
const storeRetryPolicy = {
  attemptTimeout: "30 seconds",
  backoff: "200 millis",
  retries: 4,
} as const satisfies GoogleApiRetryPolicy;

/** Where one stage's release record lives in Cloud Storage. */
export interface GcsReleaseRecordLocation {
  readonly bucket: GcsBucketName;
  readonly object: string;
}

/**
 * The stage's release record object. It sits at the bucket root, outside
 * Alchemy's `{stack}/{stage}/` state prefixes, so state listings never
 * see it.
 */
export const releaseRecordObjectName = (stage: WorkspaceStage) =>
  `workspace-release-record.${stage}.json`;

export const releaseRecordLocation = (
  config: WorkspaceStackConfig
): GcsReleaseRecordLocation => ({
  bucket: config.stateBucket,
  object: releaseRecordObjectName(config.stage),
});

/**
 * An attempt failed in a way a retry may fix. `outcomeUnknown` marks a
 * write that may have landed although no success answer arrived.
 */
class RetryableAttempt extends Data.TaggedError("RetryableAttempt")<{
  readonly status: number | null;
  readonly reason: string;
  readonly outcomeUnknown: boolean;
}> {}

/** The upload's `ifGenerationMatch` precondition no longer held. */
class PreconditionLost extends Data.TaggedError("PreconditionLost") {}

const isRetryable = (error: { readonly _tag: string }) =>
  error._tag === "RetryableAttempt";

const ObjectGeneration = Schema.String.check(Schema.isPattern(/^[0-9]+$/));
const UploadedObjectJson = Schema.fromJsonString(
  Schema.Struct({ generation: ObjectGeneration })
);
const isObjectGeneration = Schema.is(ObjectGeneration);
const StoredRecordJson = Schema.fromJsonString(ReleaseRecord);
const decodeStoredRecord = Schema.decodeUnknownEffect(StoredRecordJson);
const encodeStoredRecord = Schema.encodeEffect(StoredRecordJson);
const decodeUploadedObject = Schema.decodeUnknownEffect(UploadedObjectJson);
const sameRecord = Schema.toEquivalence(ReleaseRecord);

const noAnswerReasons = {
  unreachable: "Cloud Storage could not be reached",
  "no-answer-in-time": "Cloud Storage did not answer in time",
  "credentials-stalled": "Google Cloud credentials did not resolve in time",
} satisfies Record<GoogleApiNoAnswer, string>;

/** A refusal no retry can fix; 429 and 5xx never reach it. */
const refusal = (operation: "read" | "write", status: number) =>
  new ReleaseStoreUnavailable({
    operation,
    status,
    reason:
      status === 401 || status === 403
        ? `Cloud Storage refused the credentials (${status})`
        : `Cloud Storage refused the request (${status})`,
  });

const unavailableAfterRetries =
  (operation: "read" | "write") => (attempt: RetryableAttempt) =>
    new ReleaseStoreUnavailable({
      operation,
      status: attempt.status,
      reason: `${attempt.reason}; gave up after ${storeRetryPolicy.retries + 1} attempts`,
    });

/**
 * The release record store on one Cloud Storage object. The object
 * generation is the record version, and every write is a compare-and-set
 * on it (`ifGenerationMatch`), so two runs that read the same version can
 * never both write.
 */
export const makeGcsReleaseRecordStore = Effect.fn(
  "WorkspaceRelease.makeGcsReleaseRecordStore"
)(function* (location: GcsReleaseRecordLocation) {
  const googleApi = yield* makeGoogleApi();
  const bucketPath = encodeURIComponent(location.bucket);
  const objectUrl = `${cloudStorageApi}/storage/v1/b/${bucketPath}/o/${encodeURIComponent(location.object)}`;
  const uploadUrl = `${cloudStorageApi}/upload/storage/v1/b/${bucketPath}/o`;

  /**
   * One authorized call: each attempt resolves a token, dispatches and
   * handles the response under one deadline. Only once the request is
   * dispatched can a lost answer leave a write's outcome unknown; a token
   * exchange that stalls sends nothing, and one that fails is final.
   */
  const call = <A, E extends PreconditionLost | ReleaseStoreUnavailable>(
    operation: "read" | "write",
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: HttpClientResponse.HttpClientResponse
    ) => Effect.Effect<A, E | RetryableAttempt>,
    onAttemptFailure?: (
      error: E | RetryableAttempt | ReleaseStoreUnavailable
    ) => Effect.Effect<void>
  ) =>
    googleApi.call<A, E | RetryableAttempt | ReleaseStoreUnavailable>({
      request,
      policy: storeRetryPolicy,
      handle,
      retryHandledFailure: isRetryable,
      transientStatus: (status) =>
        new RetryableAttempt({
          status,
          reason: `Cloud Storage answered ${status}`,
          // A rate-limited request was not applied; a server error may have been.
          outcomeUnknown: status >= 500,
        }),
      noAnswer: (cause) =>
        new RetryableAttempt({
          status: null,
          reason: noAnswerReasons[cause],
          // Only a stalled token lookup is known to have sent nothing.
          outcomeUnknown: cause !== "credentials-stalled",
        }),
      credentialsUnavailable: () =>
        new ReleaseStoreUnavailable({
          operation,
          status: null,
          reason: "Google Cloud credentials are unavailable",
        }),
      onAttemptFailure,
    });

  const bodyText = (response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.mapError(
        () =>
          new RetryableAttempt({
            status: response.status,
            reason: "Cloud Storage response body could not be read",
            outcomeUnknown: true,
          })
      )
    );

  const storedObject = (
    response: HttpClientResponse.HttpClientResponse
  ): Effect.Effect<
    { readonly body: string; readonly version: string } | null,
    RetryableAttempt | ReleaseStoreUnavailable
  > => {
    if (response.status === 404) {
      return Effect.succeed(null);
    }
    if (response.status !== 200) {
      return Effect.fail(refusal("read", response.status));
    }
    const generation = response.headers["x-goog-generation"];
    return isObjectGeneration(generation)
      ? Effect.map(bodyText(response), (body) => ({
          body,
          version: generation,
        }))
      : Effect.fail(
          new ReleaseStoreUnavailable({
            operation: "read",
            status: response.status,
            reason:
              "Cloud Storage served the record without an object generation",
          })
        );
  };

  const decodeStored = (stored: {
    readonly body: string;
    readonly version: string;
  }) =>
    decodeStoredRecord(stored.body).pipe(
      Effect.map(
        (record): StoredReleaseRecord => ({ record, version: stored.version })
      ),
      // The schema issue may quote stored values; keep the reason fixed.
      Effect.mapError(
        () =>
          new ReleaseRecordCorrupt({
            version: stored.version,
            reason: "the stored object does not decode as a release record",
          })
      )
    );

  /** The stored record, or null while no object exists. */
  const readPresent = call(
    "read",
    HttpClientRequest.get(objectUrl).pipe(
      HttpClientRequest.setUrlParam("alt", "media")
    ),
    storedObject
  ).pipe(
    Effect.catchTag("RetryableAttempt", (last) =>
      Effect.fail(unavailableAfterRetries("read")(last))
    ),
    Effect.flatMap((stored) =>
      stored === null ? Effect.succeed(null) : decodeStored(stored)
    )
  );

  const read: Effect.Effect<
    StoredReleaseRecord,
    ReleaseRecordCorrupt | ReleaseStoreUnavailable
  > = readPresent.pipe(
    Effect.map(
      (stored): StoredReleaseRecord =>
        stored ?? { record: emptyReleaseRecord, version: "0" }
    ),
    Effect.withSpan("WorkspaceRelease.readReleaseRecord")
  );

  const uploadedGeneration = (
    response: HttpClientResponse.HttpClientResponse
  ): Effect.Effect<
    string,
    PreconditionLost | RetryableAttempt | ReleaseStoreUnavailable
  > => {
    if (response.status === 412) {
      return Effect.fail(new PreconditionLost());
    }
    if (response.status !== 200) {
      return Effect.fail(refusal("write", response.status));
    }
    // The write landed, but without its generation the version is
    // unknown; the retry's precondition check settles it.
    return bodyText(response).pipe(
      Effect.flatMap(decodeUploadedObject),
      Effect.map((uploaded) => uploaded.generation),
      Effect.mapError(
        () =>
          new RetryableAttempt({
            status: response.status,
            reason: "Cloud Storage did not report the new object generation",
            outcomeUnknown: true,
          })
      )
    );
  };

  /** Upload with retries, noting any attempt whose outcome is unknown. */
  const upload = (input: {
    readonly body: string;
    readonly ifVersion: string;
    readonly outcomeUnknown: Ref.Ref<boolean>;
  }) =>
    call(
      "write",
      HttpClientRequest.post(uploadUrl).pipe(
        HttpClientRequest.setUrlParams({
          uploadType: "media",
          name: location.object,
          ifGenerationMatch: input.ifVersion,
        }),
        HttpClientRequest.bodyText(input.body, "application/json")
      ),
      uploadedGeneration,
      (error) =>
        error._tag === "RetryableAttempt" && error.outcomeUnknown
          ? Ref.set(input.outcomeUnknown, true)
          : Effect.void
    ).pipe(
      Effect.catchTag("RetryableAttempt", (last) =>
        Effect.fail(unavailableAfterRetries("write")(last))
      )
    );

  /**
   * A retry lost its precondition after an attempt whose outcome is
   * unknown. That attempt landed only if the object now exists at a newer
   * generation holding this call's record; anything else is another
   * writer's.
   */
  const confirmEarlierAttempt = (input: {
    readonly record: ReleaseRecord;
    readonly ifVersion: string;
  }) =>
    readPresent.pipe(
      Effect.filterOrFail(
        (stored): stored is StoredReleaseRecord =>
          stored !== null &&
          stored.version !== input.ifVersion &&
          sameRecord(stored.record, input.record),
        () => new ReleaseRecordConflict({ expectedVersion: input.ifVersion })
      )
    );

  const settleLostPrecondition = (input: {
    readonly record: ReleaseRecord;
    readonly ifVersion: string;
    readonly outcomeUnknown: Ref.Ref<boolean>;
  }) =>
    Ref.get(input.outcomeUnknown).pipe(
      Effect.flatMap((unknown) =>
        unknown
          ? confirmEarlierAttempt(input)
          : Effect.fail(
              new ReleaseRecordConflict({ expectedVersion: input.ifVersion })
            )
      )
    );

  /**
   * Once any attempt's outcome is unknown, every later refusal says so:
   * the write may have landed, and only a re-read shows it.
   */
  const keepUncertainty =
    (outcomeUnknown: Ref.Ref<boolean>) => (failure: ReleaseStoreUnavailable) =>
      Ref.get(outcomeUnknown).pipe(
        Effect.flatMap((unknown) =>
          Effect.fail(
            unknown
              ? new ReleaseStoreUnavailable({
                  operation: "write",
                  status: failure.status,
                  reason: `${failure.reason}; an earlier attempt may have landed`,
                })
              : failure
          )
        )
      );

  /**
   * Compare-and-set on the object generation. After an attempt whose
   * outcome is unknown, success means a read found this record at a newer
   * generation: an equal record from another writer counts as this one,
   * which is harmless because the stored decision is the same. A conflict
   * may follow a write that landed and was then superseded; either way the
   * caller re-reads and decides again.
   */
  const write = (
    record: ReleaseRecord,
    ifVersion: string
  ): Effect.Effect<
    StoredReleaseRecord,
    ReleaseRecordConflict | ReleaseRecordCorrupt | ReleaseStoreUnavailable
  > =>
    Effect.Do.pipe(
      Effect.let("record", () => record),
      Effect.let("ifVersion", () => ifVersion),
      // The record type guarantees a valid encoding, so a failure is a
      // defect; its message stays fixed so no record value leaks.
      Effect.bind("body", () =>
        encodeStoredRecord(record).pipe(
          Effect.mapError(
            () => new Error("the release record to write does not encode")
          ),
          Effect.orDie
        )
      ),
      Effect.bind("outcomeUnknown", () => Ref.make(false)),
      Effect.flatMap((input) =>
        upload(input).pipe(
          Effect.map((version): StoredReleaseRecord => ({ record, version })),
          Effect.catchTag("PreconditionLost", () =>
            settleLostPrecondition(input)
          ),
          Effect.catchTag(
            "ReleaseStoreUnavailable",
            keepUncertainty(input.outcomeUnknown)
          )
        )
      ),
      Effect.withSpan("WorkspaceRelease.writeReleaseRecord")
    );

  return ReleaseRecordStore.of({ read, write });
});

/** The Cloud Storage release record store for one location. */
export const gcsReleaseRecordStoreLayer = (
  location: GcsReleaseRecordLocation
) => Layer.effect(ReleaseRecordStore, makeGcsReleaseRecordStore(location));
