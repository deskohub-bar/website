import { Effect, Layer } from "effect";
import {
  StoredUpdateAssetMismatch,
  UpdateAssetStorageUnavailable,
} from "./stored-update-asset";
import { UpdateAssetStorage } from "./update-asset-storage.service";

/**
 * An in-memory update store. `stored` files exist from the start and are
 * reused, `mismatched` pathnames hold another file, and `failedUploads`
 * never upload.
 */
export const memoryUpdateAssetStorage = ({
  stored = [],
  mismatched = [],
  failedUploads = [],
}: {
  readonly stored?: readonly string[];
  readonly mismatched?: readonly string[];
  readonly failedUploads?: readonly string[];
}) => {
  const urlOf = (pathname: string) => `https://blob.test/${pathname}`;
  const files = new Set(stored);
  const uploads: string[] = [];
  const uploadedContentTypes = new Map<string, string>();

  const layer = Layer.succeed(UpdateAssetStorage, {
    ensureAsset: ({ pathname, asset }) => {
      if (mismatched.includes(pathname)) {
        return Effect.fail(
          new StoredUpdateAssetMismatch({
            pathname,
            mismatched: ["sha256"],
            message: `${pathname} is already stored with a different sha256`,
          })
        );
      }
      if (failedUploads.includes(pathname)) {
        return Effect.fail(
          new UpdateAssetStorageUnavailable({
            operation: "upload",
            pathname,
            message: `Upload of ${pathname} failed`,
          })
        );
      }
      return Effect.sync(() => {
        const reused = files.has(pathname);
        if (!reused) {
          files.add(pathname);
          uploads.push(pathname);
          uploadedContentTypes.set(pathname, asset.contentType);
        }
        return { url: urlOf(pathname), reused };
      });
    },
  });

  return { layer, uploads, uploadedContentTypes, urlOf };
};
