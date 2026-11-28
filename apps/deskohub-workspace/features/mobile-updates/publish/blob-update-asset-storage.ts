import {
  BlobNotFoundError,
  type HeadBlobResult,
  head,
  put,
} from "@vercel/blob";
import { Data, Effect, Option, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { UpdateFile } from "./exported-update";
import {
  MobileUpdatePublishConfig,
  MobileUpdatePublishConfigInvalid,
  refuseCloudStorageWithoutBucket,
} from "./mobile-update-publish-config";
import {
  downloadedSha256,
  ensureStoredObjectMatches,
  type StoredUpdateAsset,
  storedAssetMaxAgeSeconds,
  UpdateAssetStorageUnavailable,
} from "./stored-update-asset";

const findTimeout = "30 seconds";
const uploadTimeout = "2 minutes";

class StoredFileMissing extends Data.TaggedError("StoredFileMissing") {}

/**
 * Blob renders `cacheControlMaxAge` as its own `public, max-age=…` header,
 * so the year-long max age is what identifies the immutable policy.
 */
const blobCacheControlMatches = (cacheControl: string) =>
  cacheControl
    .split(",")
    .map((directive) => directive.trim())
    .includes(`max-age=${storedAssetMaxAgeSeconds}`);

/**
 * Stores update files in the public Vercel Blob store installed apps
 * download them from. An object already at a file's pathname is reused only
 * once its size, content type, cache policy and downloaded bytes match.
 */
export const makeBlobUpdateAssetStorage = Effect.gen(function* () {
  const { blobToken, cloudStorage } = yield* MobileUpdatePublishConfig;
  yield* refuseCloudStorageWithoutBucket(cloudStorage);
  if (Option.isNone(blobToken)) {
    return yield* new MobileUpdatePublishConfigInvalid({
      message: "Set BLOB_READ_WRITE_TOKEN to store update files",
    });
  }
  const token = Redacted.value(blobToken.value);
  const client = yield* HttpClient.HttpClient;

  const unavailable =
    (operation: "read" | "upload", pathname: string) => (cause: unknown) =>
      new UpdateAssetStorageUnavailable({
        operation,
        pathname,
        message: `Blob ${operation} of ${pathname} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });

  const find = (pathname: string) =>
    Effect.tryPromise({
      try: (abortSignal) => head(pathname, { token, abortSignal }),
      catch: (cause) =>
        cause instanceof BlobNotFoundError
          ? new StoredFileMissing()
          : unavailable("read", pathname)(cause),
    }).pipe(
      Effect.asSome,
      Effect.catchTag("StoredFileMissing", () =>
        Effect.succeed(Option.none<HeadBlobResult>())
      ),
      Effect.timeoutOrElse({
        duration: findTimeout,
        orElse: () => Effect.fail(unavailable("read", pathname)("timeout")),
      })
    );

  const upload = ({ pathname, bytes, asset }: UpdateFile) =>
    Effect.tryPromise({
      try: (abortSignal) =>
        put(pathname, Buffer.from(bytes), {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: storedAssetMaxAgeSeconds,
          contentType: asset.contentType,
          token,
          abortSignal,
        }),
      catch: unavailable("upload", pathname),
    }).pipe(
      Effect.map(({ url }): StoredUpdateAsset => ({ url, reused: false })),
      Effect.timeoutOrElse({
        duration: uploadTimeout,
        orElse: () => Effect.fail(unavailable("upload", pathname)("timeout")),
      })
    );

  const reuse = (file: UpdateFile, found: HeadBlobResult) =>
    downloadedSha256(
      client,
      HttpClientRequest.get(found.url),
      file.pathname
    ).pipe(
      Effect.flatMap((sha256) =>
        ensureStoredObjectMatches(
          file,
          {
            size: found.size,
            contentType: found.contentType,
            cacheControl: found.cacheControl,
            sha256,
          },
          blobCacheControlMatches
        )
      ),
      Effect.as<StoredUpdateAsset>({ url: found.url, reused: true })
    );

  return {
    /**
     * A failed upload may still have stored the file, or lost to another
     * publish storing it, so the store is asked again before failing.
     */
    ensureAsset: (file: UpdateFile) =>
      find(file.pathname).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (found) => reuse(file, found),
            onNone: () =>
              upload(file).pipe(
                Effect.catchTag("UpdateAssetStorageUnavailable", (failure) =>
                  find(file.pathname).pipe(
                    Effect.flatMap(
                      Option.match({
                        onSome: (found) => reuse(file, found),
                        onNone: () => Effect.fail(failure),
                      })
                    )
                  )
                )
              ),
          })
        )
      ),
  };
});
