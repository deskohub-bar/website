import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";
import type { UpdateFile } from "./exported-update";

/** Where an update file is stored, and whether it was already stored. */
export interface StoredUpdateAsset {
  readonly url: string;
  /** An earlier or concurrent publish stored the same file. */
  readonly reused: boolean;
}

export class UpdateAssetStorageUnavailable extends Data.TaggedError(
  "UpdateAssetStorageUnavailable"
)<{
  readonly operation: "read" | "upload";
  readonly pathname: string;
  readonly message: string;
}> {}

/** A property of a stored object that has to equal the update file's. */
export type StoredAssetProperty =
  | "size"
  | "contentType"
  | "cacheControl"
  | "sha256"
  | "md5"
  | "recordedSha256";

/**
 * Something other than the update file sits at its content address. Apps
 * check every downloaded file's hash, so reusing it would break the update.
 */
export class StoredUpdateAssetMismatch extends Data.TaggedError(
  "StoredUpdateAssetMismatch"
)<{
  readonly pathname: string;
  readonly mismatched: readonly StoredAssetProperty[];
  readonly message: string;
}> {}

/** Stored files never change, so apps and CDNs may cache them for a year. */
export const storedAssetMaxAgeSeconds = 31_536_000;
export const immutableAssetCacheControl = `public, max-age=${storedAssetMaxAgeSeconds}, immutable`;

/** What a store holds at an update file's pathname. */
export interface StoredObject {
  readonly size: number;
  readonly contentType: string;
  readonly cacheControl: string;
  /** Hex SHA-256 of the bytes the store served. */
  readonly sha256: string;
  /** Base64 MD5 the store computed on upload, when it reports one. */
  readonly md5?: string;
  /** Hex SHA-256 the uploader recorded in the object's metadata, if any. */
  readonly recordedSha256?: string;
}

export const sha256Hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const md5Base64 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("base64");

/**
 * Succeeds only when the stored object is exactly the update file: same
 * bytes, size, content type and cache policy. `cacheControlMatches` judges
 * the store's own rendering of the one-year immutable policy. A store that
 * reports `md5` or `recordedSha256` has it compared too, so a key that is
 * present but empty never passes.
 */
export const ensureStoredObjectMatches = (
  file: UpdateFile,
  stored: StoredObject,
  cacheControlMatches: (cacheControl: string) => boolean
) => {
  const expectedSha256 = sha256Hex(file.bytes);
  const checks: readonly (readonly [StoredAssetProperty, boolean])[] = [
    ["size", stored.size === file.bytes.byteLength],
    ["contentType", stored.contentType === file.asset.contentType],
    ["cacheControl", cacheControlMatches(stored.cacheControl)],
    ["sha256", stored.sha256 === expectedSha256],
    ...("md5" in stored
      ? [["md5", stored.md5 === md5Base64(file.bytes)] as const]
      : []),
    ...("recordedSha256" in stored
      ? [["recordedSha256", stored.recordedSha256 === expectedSha256] as const]
      : []),
  ];
  const mismatched = checks
    .filter(([, matches]) => !matches)
    .map(([property]) => property);
  return mismatched.length === 0
    ? Effect.void
    : Effect.fail(
        new StoredUpdateAssetMismatch({
          pathname: file.pathname,
          mismatched,
          message: `${file.pathname} is already stored with a different ${mismatched.join(", ")}`,
        })
      );
};

const downloadTimeout = "2 minutes";

/**
 * Hex SHA-256 of the bytes `request` downloads from the store, read the way
 * an app downloads the file.
 */
export const downloadedSha256 = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  pathname: string
) =>
  client
    .pipe(HttpClient.filterStatusOk)
    .execute(request)
    .pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((body) => sha256Hex(new Uint8Array(body))),
      Effect.timeout(downloadTimeout),
      // The request may carry the store's token; keep only the message.
      Effect.mapError(
        ({ message }) =>
          new UpdateAssetStorageUnavailable({
            operation: "read",
            pathname,
            message: `Downloading the stored ${pathname} failed: ${message}`,
          })
      )
    );
