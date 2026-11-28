import { createHash } from "node:crypto";
import { Schema } from "effect";
import { cloudStorageApiOrigin } from "./cloud-storage-update-asset-storage";

const decodeUploadMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.String,
    contentType: Schema.optionalKey(Schema.String),
    cacheControl: Schema.optionalKey(Schema.String),
    md5Hash: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  })
);

/** One object of the fake bucket. */
export interface FakeStoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly md5Hash: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** A request the fake bucket answered. */
export interface FakeCloudStorageRequest {
  readonly kind: "create" | "read" | "download" | "public-download";
  readonly pathname: string;
  readonly status: number;
  readonly authorization: string | null;
  /** For a create: the query and object metadata it sent, and its bytes' hex SHA-256. */
  readonly ifGenerationMatch?: string | null;
  readonly uploadType?: string | null;
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly md5Hash?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly sha256?: string;
}

const md5 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("base64");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Builds an object as Cloud Storage would record an upload of `bytes`. */
export const fakeStoredObject = (
  bytes: Uint8Array,
  overrides: Partial<FakeStoredObject> = {}
): FakeStoredObject => ({
  bytes,
  contentType: "application/octet-stream",
  cacheControl: "public, max-age=31536000, immutable",
  md5Hash: md5(bytes),
  metadata: { sha256: sha256(bytes) },
  ...overrides,
});

/** Splits a `multipart/related` upload into its JSON metadata and media. */
const readMultipartUpload = (contentType: string, body: Buffer) => {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (boundary === undefined) throw new Error("No multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    parts.push(body.subarray(start + delimiter.length + 2, next - 2));
    start = next;
  }
  const [metadataPart, mediaPart] = parts.map((part) => {
    const headersEnd = part.indexOf("\r\n\r\n");
    return part.subarray(headersEnd + 4);
  });
  if (metadataPart === undefined || mediaPart === undefined) {
    throw new Error("A multipart upload needs a metadata and a media part");
  }
  return {
    metadata: decodeUploadMetadata(JSON.parse(metadataPart.toString("utf8"))),
    media: new Uint8Array(mediaPart),
  };
};

/**
 * An in-memory Cloud Storage bucket behind `fetch`, for the JSON API calls
 * the update store makes and the public URLs apps download from:
 *
 * - creates honour `ifGenerationMatch=0` (HTTP 412 when the object exists)
 *   and, like Cloud Storage, reject an upload whose `md5Hash` doesn't match
 *   its bytes;
 * - `loseCreateResponse` pathnames are created and then the request fails
 *   in transport, as if the response was lost;
 * - `failCreate` pathnames answer HTTP 503 without creating anything;
 * - `beforeCreate` runs before a create is applied, so a test can store a
 *   competing object first;
 * - `onRequest` sees each request as it is answered.
 */
export const fakeCloudStorage = ({
  bucket,
  objects = new Map<string, FakeStoredObject>(),
  loseCreateResponse = [],
  failCreate = [],
  beforeCreate,
  onRequest,
}: {
  readonly bucket: string;
  readonly objects?: Map<string, FakeStoredObject>;
  readonly loseCreateResponse?: readonly string[];
  readonly failCreate?: readonly string[];
  readonly beforeCreate?: (
    pathname: string,
    objects: Map<string, FakeStoredObject>
  ) => void;
  readonly onRequest?: (request: FakeCloudStorageRequest) => void;
}) => {
  const requests: FakeCloudStorageRequest[] = [];
  const answered = (request: FakeCloudStorageRequest) => {
    requests.push(request);
    onRequest?.(request);
  };
  const objectPath = `/storage/v1/b/${bucket}/o/`;
  const publicPath = `/${bucket}/`;

  const resource = (pathname: string, object: FakeStoredObject) => ({
    kind: "storage#object",
    name: pathname,
    bucket,
    generation: "1",
    size: String(object.bytes.byteLength),
    contentType: object.contentType,
    cacheControl: object.cacheControl,
    md5Hash: object.md5Hash,
    metadata: object.metadata,
  });

  const create = async (request: Request, url: URL) => {
    const { metadata, media } = readMultipartUpload(
      request.headers.get("content-type") ?? "",
      Buffer.from(await request.arrayBuffer())
    );
    const pathname = metadata.name;
    const answer = (status: number) => {
      answered({
        kind: "create",
        pathname,
        status,
        authorization: request.headers.get("authorization"),
        ifGenerationMatch: url.searchParams.get("ifGenerationMatch"),
        uploadType: url.searchParams.get("uploadType"),
        contentType: metadata.contentType,
        cacheControl: metadata.cacheControl,
        md5Hash: metadata.md5Hash,
        metadata: metadata.metadata,
        sha256: sha256(media),
      });
      return status;
    };
    beforeCreate?.(pathname, objects);
    if (failCreate.includes(pathname)) {
      return new Response("Unavailable", { status: answer(503) });
    }
    if (metadata.md5Hash !== undefined && metadata.md5Hash !== md5(media)) {
      return new Response("MD5 mismatch", { status: answer(400) });
    }
    if (
      url.searchParams.get("ifGenerationMatch") === "0" &&
      objects.has(pathname)
    ) {
      return new Response("Precondition Failed", { status: answer(412) });
    }
    const object = fakeStoredObject(media, {
      contentType: metadata.contentType ?? "application/octet-stream",
      cacheControl: metadata.cacheControl ?? "",
      metadata: metadata.metadata ?? {},
    });
    objects.set(pathname, object);
    answer(200);
    if (loseCreateResponse.includes(pathname)) {
      throw new TypeError("fetch failed");
    }
    return Response.json(resource(pathname, object));
  };

  const read = (request: Request, url: URL) => {
    const pathname = decodeURIComponent(url.pathname.slice(objectPath.length));
    const object = objects.get(pathname);
    const download = url.searchParams.get("alt") === "media";
    const status = object === undefined ? 404 : 200;
    answered({
      kind: download ? "download" : "read",
      pathname,
      status,
      authorization: request.headers.get("authorization"),
    });
    if (object === undefined) return new Response("Not Found", { status });
    return download
      ? new Response(new Uint8Array(object.bytes), {
          headers: { "content-type": object.contentType },
        })
      : Response.json(resource(pathname, object));
  };

  /** What an app downloading a stored file's public URL gets. */
  const publicDownload = (request: Request, url: URL) => {
    const pathname = url.pathname.slice(publicPath.length);
    const object = objects.get(pathname);
    answered({
      kind: "public-download",
      pathname,
      status: object === undefined ? 404 : 200,
      authorization: request.headers.get("authorization"),
    });
    return object === undefined
      ? new Response("Not Found", { status: 404 })
      : new Response(new Uint8Array(object.bytes), {
          headers: {
            "content-type": object.contentType,
            "cache-control": object.cacheControl,
          },
        });
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== cloudStorageApiOrigin) {
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }
    if (
      request.method === "POST" &&
      url.pathname === `/upload/storage/v1/b/${bucket}/o`
    ) {
      return create(request, url);
    }
    if (request.method === "GET" && url.pathname.startsWith(objectPath)) {
      return read(request, url);
    }
    if (request.method === "GET" && url.pathname.startsWith(publicPath)) {
      return publicDownload(request, url);
    }
    return new Response("Unexpected Cloud Storage request", { status: 500 });
  };

  const fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(input, init)),
    { preconnect: globalThis.fetch.preconnect }
  );

  return { fetch, handle, objects, requests };
};
