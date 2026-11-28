import { randomUUID } from "node:crypto";
import { Data, Effect, Match, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import type { UpdateFile } from "./exported-update";
import {
  MobileUpdatePublishConfig,
  readCloudStorageAssetStore,
} from "./mobile-update-publish-config";
import {
  downloadedSha256,
  ensureStoredObjectMatches,
  immutableAssetCacheControl,
  md5Base64,
  type StoredUpdateAsset,
  sha256Hex,
  UpdateAssetStorageUnavailable,
} from "./stored-update-asset";

/** The Cloud Storage JSON API. */
export const cloudStorageApiOrigin = "https://storage.googleapis.com";

const uploadTimeout = "2 minutes";
const readTimeout = "30 seconds";

/** The JSON API's object resource, as far as the comparison needs it. */
const StoredObjectResource = Schema.Struct({
  size: Schema.FiniteFromString,
  contentType: Schema.optionalKey(Schema.String),
  cacheControl: Schema.optionalKey(Schema.String),
  md5Hash: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
type StoredObjectResource = typeof StoredObjectResource.Type;

class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
  readonly status: number;
}> {
  override get message() {
    return `HTTP ${this.status}`;
  }
}

/** `ifGenerationMatch=0` refused the upload: the object already exists. */
class ObjectAlreadyStored extends Data.TaggedError("ObjectAlreadyStored") {}

const encoder = new TextEncoder();

/**
 * A `multipart/related` upload body: the object's metadata as JSON, then
 * its bytes. Cloud Storage rejects bytes whose MD5 differs from `md5Hash`.
 */
const multipartUpload = (boundary: string, file: UpdateFile) => {
  const metadata = {
    name: file.pathname,
    contentType: file.asset.contentType,
    cacheControl: immutableAssetCacheControl,
    md5Hash: md5Base64(file.bytes),
    metadata: { sha256: sha256Hex(file.bytes) },
  };
  return Buffer.concat([
    encoder.encode(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\ncontent-type: ${file.asset.contentType}\r\n\r\n`
    ),
    file.bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ]);
};

/** What a create's status says about the object. */
const createOutcome = (status: number) => {
  if (status === 200) return "created";
  if (status === 412) return "already-stored";
  return "failed";
};

/** What a metadata read's status says about the object. */
const readOutcome = (status: number) => {
  if (status === 200) return "found";
  if (status === 404) return "missing";
  return "failed";
};

/**
 * Stores update files in a Cloud Storage bucket. A file is created only
 * where no object exists yet (`ifGenerationMatch=0`), with its content type,
 * the one-year immutable cache policy, an MD5 Cloud Storage checks on
 * upload and its SHA-256 in the object metadata. When the object already
 * exists, or the upload's outcome is unknown, the stored object is read back
 * and reused only if its metadata and downloaded bytes match exactly.
 */
export const makeCloudStorageUpdateAssetStorage = Effect.gen(function* () {
  const { bucket, accessToken, publicBaseUrl } =
    yield* readCloudStorageAssetStore(
      (yield* MobileUpdatePublishConfig).cloudStorage
    );
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(accessToken))
  );

  const objectUrl = (pathname: string) =>
    `${cloudStorageApiOrigin}/storage/v1/b/${bucket}/o/${encodeURIComponent(pathname)}`;
  const publicUrl = (pathname: string) => `${publicBaseUrl}/${pathname}`;
  const unavailable = (
    operation: "read" | "upload",
    pathname: string,
    reason: string
  ) =>
    new UpdateAssetStorageUnavailable({
      operation,
      pathname,
      message: `Cloud Storage ${operation} of ${pathname} failed: ${reason}`,
    });

  const create = (file: UpdateFile) => {
    const boundary = `mobile-update-${randomUUID()}`;
    const body = multipartUpload(boundary, file);
    return client
      .execute(
        HttpClientRequest.post(
          `${cloudStorageApiOrigin}/upload/storage/v1/b/${bucket}/o`
        ).pipe(
          HttpClientRequest.setUrlParams({
            uploadType: "multipart",
            ifGenerationMatch: "0",
          }),
          HttpClientRequest.bodyUint8Array(
            body,
            `multipart/related; boundary=${boundary}`
          )
        )
      )
      .pipe(
        Effect.timeout(uploadTimeout),
        // The request carries the access token; keep only the message.
        Effect.mapError(({ message }) =>
          unavailable("upload", file.pathname, message)
        ),
        Effect.flatMap(({ status }) =>
          Match.value(createOutcome(status)).pipe(
            Match.when("created", () => Effect.void),
            Match.when("already-stored", () =>
              Effect.fail(new ObjectAlreadyStored())
            ),
            Match.when("failed", () =>
              Effect.fail(
                unavailable("upload", file.pathname, `HTTP ${status}`)
              )
            ),
            Match.exhaustive
          )
        )
      );
  };

  const decodeObject = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StoredObjectResource))
    );

  /** The object at `pathname`, if one exists. */
  const find = (pathname: string) =>
    client.execute(HttpClientRequest.get(objectUrl(pathname))).pipe(
      Effect.flatMap((response) =>
        Match.value(readOutcome(response.status)).pipe(
          Match.when("found", () => decodeObject(response).pipe(Effect.asSome)),
          Match.when("missing", () =>
            Effect.succeed(Option.none<StoredObjectResource>())
          ),
          Match.when("failed", () =>
            Effect.fail(new UnexpectedStatus({ status: response.status }))
          ),
          Match.exhaustive
        )
      ),
      Effect.timeout(readTimeout),
      // The request carries the access token; keep only the message.
      Effect.mapError(({ message }) => unavailable("read", pathname, message))
    );

  const reuse = (file: UpdateFile, stored: StoredObjectResource) =>
    downloadedSha256(
      client,
      HttpClientRequest.get(objectUrl(file.pathname)).pipe(
        HttpClientRequest.setUrlParam("alt", "media")
      ),
      file.pathname
    ).pipe(
      Effect.flatMap((sha256) =>
        ensureStoredObjectMatches(
          file,
          {
            size: stored.size,
            contentType: stored.contentType ?? "",
            cacheControl: stored.cacheControl ?? "",
            sha256,
            md5: stored.md5Hash ?? "",
            recordedSha256: stored.metadata?.sha256 ?? "",
          },
          (cacheControl) => cacheControl === immutableAssetCacheControl
        )
      ),
      Effect.as<StoredUpdateAsset>({
        url: publicUrl(file.pathname),
        reused: true,
      })
    );

  return {
    ensureAsset: (file: UpdateFile) =>
      create(file).pipe(
        Effect.as<StoredUpdateAsset>({
          url: publicUrl(file.pathname),
          reused: false,
        }),
        Effect.catchTags({
          ObjectAlreadyStored: () =>
            find(file.pathname).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: (stored) => reuse(file, stored),
                  onNone: () =>
                    Effect.fail(
                      unavailable(
                        "read",
                        file.pathname,
                        "the upload found an object that reading can't"
                      )
                    ),
                })
              )
            ),
          // The upload may have created the object before its response was
          // lost, or another publish may have created it.
          UpdateAssetStorageUnavailable: (failure) =>
            find(file.pathname).pipe(
              Effect.catchTag("UpdateAssetStorageUnavailable", () =>
                Effect.fail(failure)
              ),
              Effect.flatMap(
                Option.match({
                  onSome: (stored) => reuse(file, stored),
                  onNone: () => Effect.fail(failure),
                })
              )
            ),
        })
      ),
  };
});
