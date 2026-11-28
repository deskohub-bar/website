import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  type FakeStoredObject,
  fakeCloudStorage,
  fakeStoredObject,
} from "./cloud-storage.test-utils";
import { readExportedUpdates, type UpdateFile } from "./exported-update";
import { MobileUpdatePublishConfig } from "./mobile-update-publish-config";
import { storeUpdateFiles } from "./store-update-files";
import { immutableAssetCacheControl } from "./stored-update-asset";
import { UpdateAssetStorage } from "./update-asset-storage.service";

const bucket = "synthetic-mobile-updates";
const accessToken = "synthetic-cloud-storage-access-token";
const publicBaseUrl = `https://storage.googleapis.com/${bucket}`;

const fixtureExport = fileURLToPath(
  new URL("./fixtures/export", import.meta.url)
);

/** The fixture export's Android bundle and image, as the publisher reads them. */
const exported = await Effect.runPromise(
  readExportedUpdates(fixtureExport, ["android"])
);
const [androidUpdate] = exported;
if (androidUpdate === undefined) throw new Error("No Android fixture update");
const bundle = androidUpdate.launchAsset;
const [image] = androidUpdate.assets;
if (image === undefined) throw new Error("No fixture image");

/** A file described the way `expo export` files are, by content address. */
const updateFile = (
  text: string,
  extension: string,
  contentType: string
): UpdateFile => {
  const bytes = new TextEncoder().encode(text);
  const sha256 = createHash("sha256").update(bytes);
  return {
    pathname: `mobile-updates/assets/${sha256.copy().digest("hex")}${extension}`,
    bytes,
    asset: {
      hash: sha256.digest("base64url"),
      key: createHash("md5").update(bytes).digest("hex"),
      contentType,
      fileExtension: extension,
    },
  };
};
const font = updateFile("synthetic font", ".ttf", "font/ttf");
const binary = updateFile("synthetic binary", "", "application/octet-stream");

const config = Layer.succeed(MobileUpdatePublishConfig, {
  target: new URL("https://workspace.test"),
  blobToken: Option.none(),
  publishToken: Redacted.make("synthetic-publish-token"),
  protectionBypass: Option.none(),
  cloudStorage: {
    bucket: Option.some(bucket),
    accessToken: Option.some(Redacted.make(accessToken)),
    assetOrigin: Option.none(),
  },
});

const run = <A, E>(
  storage: ReturnType<typeof fakeCloudStorage>,
  effect: Effect.Effect<A, E, UpdateAssetStorage>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        UpdateAssetStorage.CloudStorage.pipe(Layer.provide(config))
      ),
      Effect.provideService(FetchHttpClient.Fetch, storage.fetch)
    )
  );

const ensure = (file: UpdateFile) =>
  Effect.gen(function* () {
    const storage = yield* UpdateAssetStorage;
    return yield* storage.ensureAsset(file);
  });
const ensureFailure = (file: UpdateFile) => Effect.flip(ensure(file));

const publicUrl = (file: UpdateFile) => `${publicBaseUrl}/${file.pathname}`;

/** What an app gets downloading `url`, and the hash it checks. */
const download = async (
  storage: ReturnType<typeof fakeCloudStorage>,
  url: string
) => {
  const response = await storage.fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    hash: createHash("sha256").update(bytes).digest("base64url"),
  };
};

const storedAt = (
  file: UpdateFile,
  overrides: Partial<FakeStoredObject> = {}
) =>
  new Map([
    [
      file.pathname,
      fakeStoredObject(file.bytes, {
        contentType: file.asset.contentType,
        ...overrides,
      }),
    ],
  ]);

describe("Cloud Storage update asset storage", () => {
  test("creates each file only where nothing is stored, with its content type, immutable cache policy and checksums", async () => {
    const storage = fakeCloudStorage({ bucket });

    const result = await run(
      storage,
      storeUpdateFiles([bundle, image, font, binary])
    );

    expect(result.uploaded).toBe(4);
    expect(result.reused).toBe(0);
    for (const file of [bundle, image, font, binary]) {
      expect(result.assetUrls.get(file.pathname)).toBe(publicUrl(file));
      expect(
        storage.requests.find(
          ({ kind, pathname }) =>
            kind === "create" && pathname === file.pathname
        )
      ).toEqual({
        kind: "create",
        pathname: file.pathname,
        status: 200,
        authorization: `Bearer ${accessToken}`,
        ifGenerationMatch: "0",
        uploadType: "multipart",
        contentType: file.asset.contentType,
        cacheControl: immutableAssetCacheControl,
        md5Hash: createHash("md5").update(file.bytes).digest("base64"),
        metadata: {
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        },
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      });
    }
    expect(bundle.asset.contentType).toBe("application/javascript");
    expect(image.asset.contentType).toBe("image/png");
  });

  test("serves each stored file with the bytes its Expo hash names and an immutable year-long cache", async () => {
    const storage = fakeCloudStorage({ bucket });
    const { assetUrls } = await run(
      storage,
      storeUpdateFiles([bundle, image, font, binary])
    );

    for (const file of [bundle, image, font, binary]) {
      expect(
        await download(storage, assetUrls.get(file.pathname) ?? "")
      ).toEqual({
        status: 200,
        contentType: file.asset.contentType,
        cacheControl: "public, max-age=31536000, immutable",
        hash: file.asset.hash,
      });
    }
  });

  test("reuses a file an earlier publish stored once its metadata and bytes match", async () => {
    const storage = fakeCloudStorage({ bucket, objects: storedAt(image) });

    const stored = await run(storage, ensure(image));

    expect(stored).toEqual({ url: publicUrl(image), reused: true });
    expect(storage.requests.map(({ kind, status }) => [kind, status])).toEqual([
      ["create", 412],
      ["read", 200],
      ["download", 200],
    ]);
  });

  test("lets one of two simultaneous publishes create a file and the other verify and reuse it", async () => {
    const storage = fakeCloudStorage({ bucket });

    const results = await run(
      storage,
      Effect.all([ensure(bundle), ensure(bundle)], { concurrency: "unbounded" })
    );

    expect(results.map(({ reused }) => reused).sort()).toEqual([false, true]);
    expect(results.map(({ url }) => url)).toEqual([
      publicUrl(bundle),
      publicUrl(bundle),
    ]);
    expect(
      storage.requests
        .filter(({ kind }) => kind === "create")
        .map(({ status }) => status)
        .sort()
    ).toEqual([200, 412]);
    expect(storage.objects.size).toBe(1);
  });

  test.each([
    {
      difference: "bytes",
      stored: () =>
        fakeStoredObject(
          new TextEncoder().encode("another file, same pathname"),
          {
            contentType: image.asset.contentType,
          }
        ),
      mismatched: ["size", "sha256", "md5", "recordedSha256"],
    },
    {
      difference: "bytes of the same size",
      stored: () =>
        fakeStoredObject(
          image.bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte)),
          {
            contentType: image.asset.contentType,
          }
        ),
      mismatched: ["sha256", "md5", "recordedSha256"],
    },
    {
      difference: "content type",
      stored: () =>
        fakeStoredObject(image.bytes, {
          contentType: "application/octet-stream",
        }),
      mismatched: ["contentType"],
    },
    {
      difference: "cache policy",
      stored: () =>
        fakeStoredObject(image.bytes, {
          contentType: image.asset.contentType,
          cacheControl: "public, max-age=60",
        }),
      mismatched: ["cacheControl"],
    },
    {
      difference: "recorded checksum",
      stored: () =>
        fakeStoredObject(image.bytes, {
          contentType: image.asset.contentType,
          metadata: {},
        }),
      mismatched: ["recordedSha256"],
    },
  ])(
    "refuses a stored file with different $difference and leaves it in place",
    async ({ stored, mismatched }) => {
      const existing = stored();
      const storage = fakeCloudStorage({
        bucket,
        objects: new Map([[image.pathname, existing]]),
      });

      const failure = await run(storage, ensureFailure(image));

      expect(failure).toMatchObject({
        _tag: "StoredUpdateAssetMismatch",
        pathname: image.pathname,
        mismatched,
      });
      expect(storage.objects.get(image.pathname)).toBe(existing);
    }
  );

  test("reuses its own file when the upload's response is lost after Cloud Storage stored it", async () => {
    const storage = fakeCloudStorage({
      bucket,
      loseCreateResponse: [bundle.pathname],
    });

    const stored = await run(storage, ensure(bundle));

    expect(stored).toEqual({ url: publicUrl(bundle), reused: true });
    expect(storage.requests.map(({ kind }) => kind)).toEqual([
      "create",
      "read",
      "download",
    ]);
  });

  test("refuses another file found after an upload whose outcome is unknown", async () => {
    const storage = fakeCloudStorage({
      bucket,
      failCreate: [bundle.pathname],
      beforeCreate: (pathname, objects) =>
        objects.set(
          pathname,
          fakeStoredObject(new TextEncoder().encode("a different bundle"), {
            contentType: bundle.asset.contentType,
          })
        ),
    });

    const failure = await run(storage, ensureFailure(bundle));

    expect(failure).toMatchObject({
      _tag: "StoredUpdateAssetMismatch",
      pathname: bundle.pathname,
    });
  });

  test("fails without the token in its message when an upload fails and nothing was stored", async () => {
    const storage = fakeCloudStorage({
      bucket,
      failCreate: [bundle.pathname],
    });

    const failure = await run(storage, ensureFailure(bundle));

    expect(failure).toMatchObject({
      _tag: "UpdateAssetStorageUnavailable",
      operation: "upload",
      pathname: bundle.pathname,
    });
    expect(JSON.stringify(failure)).not.toContain(accessToken);
    expect(storage.objects.size).toBe(0);
  });
});
