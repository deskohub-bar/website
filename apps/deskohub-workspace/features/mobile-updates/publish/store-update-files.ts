import { Effect } from "effect";
import type { UpdateFile } from "./exported-update";
import { UpdateAssetStorage } from "./update-asset-storage.service";

interface StoredUpdateFiles {
  /** The URL of every file, by its pathname. */
  readonly assetUrls: ReadonlyMap<string, string>;
  readonly uploaded: number;
  readonly reused: number;
}

/** Stores rate-limit writes, so a publish uploads a few files at a time. */
const uploadConcurrency = 4;

/**
 * Stores the files of one or more updates. Pathnames are content addresses,
 * so each distinct file is ensured once, and one already stored, by an
 * earlier publish or another platform's update, is reused once the store
 * confirms it holds exactly that file.
 */
export const storeUpdateFiles = Effect.fn("storeUpdateFiles")(function* (
  files: readonly UpdateFile[]
) {
  const storage = yield* UpdateAssetStorage;
  const unique = [
    ...new Map(files.map((file) => [file.pathname, file])).values(),
  ];

  const stored = yield* Effect.forEach(
    unique,
    (file) =>
      storage.ensureAsset(file).pipe(
        Effect.map(({ url, reused }) => ({
          pathname: file.pathname,
          url,
          reused,
        }))
      ),
    { concurrency: uploadConcurrency }
  );

  const reused = stored.filter((file) => file.reused).length;
  return {
    assetUrls: new Map(stored.map(({ pathname, url }) => [pathname, url])),
    uploaded: stored.length - reused,
    reused,
  } satisfies StoredUpdateFiles;
});
