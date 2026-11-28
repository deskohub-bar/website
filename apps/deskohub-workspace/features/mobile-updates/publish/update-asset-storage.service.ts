import { Context, type Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeBlobUpdateAssetStorage } from "./blob-update-asset-storage";
import { makeCloudStorageUpdateAssetStorage } from "./cloud-storage-update-asset-storage";
import type { UpdateFile } from "./exported-update";
import type {
  StoredUpdateAsset,
  StoredUpdateAssetMismatch,
  UpdateAssetStorageUnavailable,
} from "./stored-update-asset";

interface IUpdateAssetStorage {
  /**
   * Stores a file at its content-addressed pathname, with its content type
   * and the one-year immutable cache policy, and gives its URL. A file
   * already stored there, by an earlier or concurrent publish, is reused
   * only when it is exactly this file; nothing stored is ever replaced.
   */
  readonly ensureAsset: (
    file: UpdateFile
  ) => Effect.Effect<
    StoredUpdateAsset,
    UpdateAssetStorageUnavailable | StoredUpdateAssetMismatch
  >;
}

/** The public store that serves update files to installed apps. */
export class UpdateAssetStorage extends Context.Service<
  UpdateAssetStorage,
  IUpdateAssetStorage
>()("UpdateAssetStorage") {
  /** The Vercel Blob store current releases publish to. */
  static Default = Layer.effect(this, makeBlobUpdateAssetStorage).pipe(
    Layer.provide(FetchHttpClient.layer)
  );

  /** A Cloud Storage bucket, selected by `MOBILE_UPDATES_GCS_BUCKET`. */
  static CloudStorage = Layer.effect(
    this,
    makeCloudStorageUpdateAssetStorage
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
