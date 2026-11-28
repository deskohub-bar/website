/**
 * Child-process preload for publish-mobile-update CLI tests.
 *
 * Vercel Blob: `@vercel/blob` sends its requests through undici, which a
 * `fetch` stub doesn't see, so this serves the Blob API on a local port and
 * points `VERCEL_BLOB_API_URL` at it. `PUBLISH_FIXTURE_STORED` lists
 * pathnames (comma-separated) the store already holds, with the fixture
 * export's bytes; `PUBLISH_FIXTURE_STORED_DIFFERENT` ones hold other bytes,
 * and `PUBLISH_FIXTURE_STORED_DURING_UPLOAD` ones get stored by "another
 * publish" while this one uploads them, so the upload fails
 * (`PUBLISH_FIXTURE_STORED_DIFFERENT_DURING_UPLOAD`: with other bytes). The store's
 * public URLs serve the stored bytes through the `fetch` stub.
 *
 * Cloud Storage (`fetch` stub on `https://storage.googleapis.com`): an
 * in-memory bucket (`fakeCloudStorage`); `PUBLISH_FIXTURE_GCS_LOSE_RESPONSE`
 * pathnames are created but their upload responses lost.
 *
 * Target deployment (`fetch` stub on `https://workspace.test`): the publish
 * route answers `PUBLISH_FIXTURE_PUBLISH_STATUS` (default 201) and records
 * the publication; the manifest route answers with the latest publication
 * for the platform, signed with the PEM key in `PUBLISH_FIXTURE_SIGNING_KEY`.
 * `PUBLISH_FIXTURE_MANIFEST=another-update` serves a different update id,
 * and `PUBLISH_FIXTURE_LOSE_FIRST_RESPONSE=1` records the first publication
 * but fails its request as if the response was lost. Blob uploads answer
 * HTTP 503 with `PUBLISH_FIXTURE_BLOB_UPLOADS=unavailable`, and every target
 * request fails in transport with `PUBLISH_FIXTURE_TARGET=unreachable`.
 *
 * Every request is appended as a JSON line to `PUBLISH_FIXTURE_RECORD`. Any
 * other request fails.
 */
import { createHash, createSign, randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { serializeDictionary } from "structured-headers";
import { MobileUpdatePublication } from "@/features/mobile-updates/mobile-update-publication";
import { fakeCloudStorage } from "@/features/mobile-updates/publish/cloud-storage.test-utils";
import { cloudStorageApiOrigin } from "@/features/mobile-updates/publish/cloud-storage-update-asset-storage";
import { encodeMultipartMixed } from "@/shared/utils/multipart-mixed";

const targetOrigin = "https://workspace.test";
const blobStoreOrigin = "https://fixture-store.public.blob.vercel-storage.com";

const recordFile = process.env.PUBLISH_FIXTURE_RECORD;
const signingKey = process.env.PUBLISH_FIXTURE_SIGNING_KEY;
if (!recordFile || !signingKey) {
  throw new Error(
    "The publish fixture needs PUBLISH_FIXTURE_RECORD and PUBLISH_FIXTURE_SIGNING_KEY"
  );
}

/** One recorded request; a publication is recorded as the route decoded it. */
interface FixtureRecord {
  readonly kind: string;
  readonly [field: string]:
    | string
    | number
    | boolean
    | null
    | undefined
    | Readonly<Record<string, string>>
    | MobileUpdatePublication;
}

const record = (entry: FixtureRecord) =>
  appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);

const listed = (name: string) =>
  (process.env[name] ?? "").split(",").filter(Boolean);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** The fixture export's files, by their content-addressed pathname. */
const exportedFiles = new Map<string, StoredBlob>(
  readdirSync(
    fileURLToPath(
      new URL(
        "../features/mobile-updates/publish/fixtures/export",
        import.meta.url
      )
    ),
    { recursive: true, withFileTypes: true }
  )
    .filter((entry) => entry.isFile() && entry.name !== "metadata.json")
    .map((entry) => {
      const bytes = new Uint8Array(
        readFileSync(join(entry.parentPath, entry.name))
      );
      const bundle = extname(entry.name) === ".hbc";
      return [
        `mobile-updates/assets/${sha256(bytes)}${bundle ? ".hbc" : ".png"}`,
        {
          bytes,
          contentType: bundle ? "application/javascript" : "image/png",
        },
      ] as const;
    })
);

const exportedFile = (pathname: string) => {
  const file = exportedFiles.get(pathname);
  if (file === undefined) throw new Error(`No fixture file ${pathname}`);
  return file;
};

/** The fixture file at `pathname` with its first byte flipped. */
const differentFile = (pathname: string): StoredBlob => ({
  ...exportedFile(pathname),
  bytes: exportedFile(pathname).bytes.map((byte, index) =>
    index === 0 ? byte ^ 1 : byte
  ),
});

const storedBlobs = new Map<string, StoredBlob>([
  ...listed("PUBLISH_FIXTURE_STORED").map(
    (pathname) => [pathname, exportedFile(pathname)] as const
  ),
  ...listed("PUBLISH_FIXTURE_STORED_DIFFERENT").map(
    (pathname) => [pathname, differentFile(pathname)] as const
  ),
]);
const storedDuringUpload = listed("PUBLISH_FIXTURE_STORED_DURING_UPLOAD");
const storedDifferentDuringUpload = listed(
  "PUBLISH_FIXTURE_STORED_DIFFERENT_DURING_UPLOAD"
);
const blobUrl = (pathname: string) => `${blobStoreOrigin}/${pathname}`;
const blobResult = (pathname: string, { bytes, contentType }: StoredBlob) => ({
  url: blobUrl(pathname),
  downloadUrl: `${blobUrl(pathname)}?download=1`,
  pathname,
  contentType,
  contentDisposition: "inline",
  cacheControl: "public, max-age=31536000",
  size: bytes.byteLength,
  uploadedAt: new Date(0).toISOString(),
  etag: "fixture",
});

const blobApi = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const query = new URL(request.url).searchParams;
    const headUrl = query.get("url");
    if (request.method === "GET" && headUrl !== null) {
      const pathname = headUrl.replace(`${blobStoreOrigin}/`, "");
      record({ kind: "blob-head", pathname });
      const stored = storedBlobs.get(pathname);
      return stored !== undefined
        ? Response.json(blobResult(pathname, stored))
        : Response.json(
            { error: { code: "not_found", message: "Not found" } },
            { status: 404 }
          );
    }
    const pathname = query.get("pathname");
    if (request.method === "PUT" && pathname !== null) {
      const body = new Uint8Array(await request.arrayBuffer());
      record({
        kind: "blob-put",
        pathname,
        contentType: request.headers.get("x-content-type"),
        addRandomSuffix: request.headers.get("x-add-random-suffix"),
        allowOverwrite: request.headers.get("x-allow-overwrite"),
        cacheControlMaxAge: request.headers.get("x-cache-control-max-age"),
        sha256: sha256(body),
      });
      if (storedDuringUpload.includes(pathname)) {
        storedBlobs.set(pathname, exportedFile(pathname));
      }
      if (storedDifferentDuringUpload.includes(pathname)) {
        storedBlobs.set(pathname, differentFile(pathname));
      }
      if (process.env.PUBLISH_FIXTURE_BLOB_UPLOADS === "unavailable") {
        return Response.json(
          { error: { code: "service_unavailable", message: "Unavailable" } },
          { status: 503 }
        );
      }
      if (storedBlobs.has(pathname)) {
        return Response.json(
          {
            error: { code: "bad_request", message: "This blob already exists" },
          },
          { status: 400 }
        );
      }
      const stored = {
        bytes: body,
        contentType: request.headers.get("x-content-type") ?? "",
      };
      storedBlobs.set(pathname, stored);
      return Response.json(blobResult(pathname, stored));
    }
    return new Response("Unexpected Blob API request", { status: 500 });
  },
});
blobApi.unref();
process.env.VERCEL_BLOB_API_URL = blobApi.url.origin;

const cloudStorage = fakeCloudStorage({
  bucket: process.env.MOBILE_UPDATES_GCS_BUCKET ?? "fixture-mobile-updates",
  loseCreateResponse: listed("PUBLISH_FIXTURE_GCS_LOSE_RESPONSE"),
  onRequest: ({ kind, ...answer }) =>
    record({ kind: `gcs-${kind}`, ...answer }),
});

const latest = new Map<string, MobileUpdatePublication>();
let responseLost = false;

/** A reply whose single part is `text`, signed with the deployed key. */
const signedReply = (part: "manifest" | "directive", text: string) => {
  const sig = createSign("RSA-SHA256")
    .update(text, "utf8")
    .sign(signingKey, "base64");
  const { contentType, body: multipart } = encodeMultipartMixed([
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `form-data; name="${part}"`,
        "expo-signature": serializeDictionary({
          sig,
          keyid: "main",
          alg: "rsa-v1_5-sha256",
        }),
      },
      body: text,
    },
  ]);
  return new Response(multipart, {
    headers: { "content-type": contentType, "expo-protocol-version": "1" },
  });
};

const answerUpdateCheck = (request: Request) => {
  const platform = request.headers.get("expo-platform") ?? "";
  record({
    kind: "update-check",
    platform,
    runtimeVersion: request.headers.get("expo-runtime-version"),
    protocolVersion: request.headers.get("expo-protocol-version"),
    expectsSignature: request.headers.has("expo-expect-signature"),
    bypass: request.headers.get("x-vercel-protection-bypass"),
  });
  const publication = latest.get(platform);
  if (publication === undefined) {
    return signedReply(
      "directive",
      JSON.stringify({ type: "noUpdateAvailable" })
    );
  }
  if (publication.type === "rollBackToEmbedded") {
    return signedReply(
      "directive",
      JSON.stringify({
        type: "rollBackToEmbedded",
        parameters: { commitTime: new Date(0).toISOString() },
      })
    );
  }
  const { type: _type, platform: _platform, ...manifest } = publication;
  return signedReply(
    "manifest",
    JSON.stringify({
      ...manifest,
      id:
        process.env.PUBLISH_FIXTURE_MANIFEST === "another-update"
          ? randomUUID()
          : publication.id,
      createdAt: new Date(0).toISOString(),
    })
  );
};

const fixtureFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === blobStoreOrigin && request.method === "GET") {
    const pathname = url.pathname.slice(1);
    record({ kind: "blob-download", pathname });
    const stored = storedBlobs.get(pathname);
    return stored === undefined
      ? new Response("Not found", { status: 404 })
      : new Response(new Uint8Array(stored.bytes), {
          headers: { "content-type": stored.contentType },
        });
  }
  if (url.origin === cloudStorageApiOrigin) {
    return cloudStorage.handle(request);
  }
  if (
    url.origin === targetOrigin &&
    process.env.PUBLISH_FIXTURE_TARGET === "unreachable"
  ) {
    record({ kind: "unreachable", path: url.pathname });
    throw new TypeError("fetch failed");
  }
  if (url.origin === targetOrigin && url.pathname === "/api/mobile/updates") {
    // Decoding with the route's schema checks the script sends what it takes.
    const publication = Schema.decodeUnknownSync(MobileUpdatePublication)(
      await request.json()
    );
    const status = Number(process.env.PUBLISH_FIXTURE_PUBLISH_STATUS ?? "201");
    record({
      kind: "publish",
      method: request.method,
      authorization: request.headers.get("authorization"),
      bypass: request.headers.get("x-vercel-protection-bypass"),
      publication,
    });
    const recorded = latest.get(publication.platform)?.id === publication.id;
    if (status < 300) latest.set(publication.platform, publication);
    if (process.env.PUBLISH_FIXTURE_LOSE_FIRST_RESPONSE && !responseLost) {
      responseLost = true;
      throw new TypeError("fetch failed");
    }
    return recorded
      ? Response.json({ status: "already-published" }, { status: 200 })
      : Response.json({ status: "published" }, { status });
  }
  if (
    url.origin === targetOrigin &&
    url.pathname === "/api/mobile/updates/manifest" &&
    request.method === "GET"
  ) {
    return answerUpdateCheck(request);
  }
  throw new Error(
    `Unexpected request in the publish fixture: ${request.method} ${request.url}`
  );
};

globalThis.fetch = Object.assign(fixtureFetch, {
  preconnect: globalThis.fetch.preconnect,
});
