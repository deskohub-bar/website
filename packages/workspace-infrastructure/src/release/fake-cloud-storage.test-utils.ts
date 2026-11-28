import { Credentials } from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** A synthetic access token; the fake refuses any other bearer. */
export const fakeAccessToken = "fake-gcs-access-token";

export const fakeCredentialsLayer = Layer.succeed(
  Credentials,
  Effect.succeed({ accessToken: Redacted.make(fakeAccessToken) })
);

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

type Response = Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError
>;

/**
 * Answers one request in place of the fake. `forward` runs the fake's own
 * handling, so an interceptor can apply a request and then lose its answer.
 */
export type Interceptor = (input: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly forward: Response;
}) => Response;

interface StoredObject {
  readonly body: string;
  readonly generation: number;
}

const respond = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: string | null = null,
  headers: Record<string, string> = {}
) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(body, { status, headers })
    )
  );

export const respondWith =
  (status: number, body: string | null = null, headers = {}): Interceptor =>
  ({ request }) =>
    respond(request, status, body, headers);

/** The request may or may not have arrived; no answer came back. */
export const transportFailure = (
  request: HttpClientRequest.HttpClientRequest
): Response =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "connection reset",
      }),
    })
  );

const requestBody = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? new TextDecoder().decode(request.body.body)
    : "";

/** Where the fake's buckets live, as the bucket metadata reports it. */
export interface FakeBucketLocation {
  readonly location: string;
  readonly locationType: string;
}

/** A single-region bucket in the test configs' default region. */
export const sandboxBucketLocation: FakeBucketLocation = {
  location: "EUROPE-WEST1",
  locationType: "region",
};

/**
 * An in-memory Cloud Storage JSON API for the two media endpoints the
 * release store uses and the bucket metadata the stack target reads. It
 * serves `x-goog-generation`, honors `ifGenerationMatch` atomically, and
 * records every request.
 */
export const makeFakeCloudStorage = (
  bucketLocation: FakeBucketLocation = sandboxBucketLocation
) => {
  const objects = new Map<string, StoredObject>();
  const requests: Array<RecordedRequest> = [];
  const interceptors: Array<Interceptor> = [];
  // Real generations are microsecond timestamps; any increasing value works.
  let lastGeneration = 1_763_900_000_000_000;

  const keyOf = (bucket: string, object: string) => `${bucket}/${object}`;

  const put = (bucket: string, object: string, body: string) => {
    lastGeneration += 1;
    const stored = { body, generation: lastGeneration };
    objects.set(keyOf(bucket, object), stored);
    return stored;
  };

  const handle = (request: HttpClientRequest.HttpClientRequest, url: URL) => {
    if (request.headers.authorization !== `Bearer ${fakeAccessToken}`) {
      return respond(request, 401);
    }
    if (
      request.method === "GET" &&
      /^\/storage\/v1\/b\/[^/]+$/.test(url.pathname)
    ) {
      return respond(request, 200, JSON.stringify(bucketLocation), {
        "content-type": "application/json",
      });
    }
    const download = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
    if (
      request.method === "GET" &&
      download !== null &&
      url.searchParams.get("alt") === "media"
    ) {
      const stored = objects.get(
        keyOf(
          decodeURIComponent(download[1] ?? ""),
          decodeURIComponent(download[2] ?? "")
        )
      );
      return stored === undefined
        ? respond(request, 404)
        : respond(request, 200, stored.body, {
            "content-type": "application/json",
            "x-goog-generation": String(stored.generation),
          });
    }
    const upload = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/);
    const name = url.searchParams.get("name");
    const ifGenerationMatch = url.searchParams.get("ifGenerationMatch");
    if (
      request.method === "POST" &&
      upload !== null &&
      url.searchParams.get("uploadType") === "media" &&
      name !== null
    ) {
      const bucket = decodeURIComponent(upload[1] ?? "");
      const current = objects.get(keyOf(bucket, name))?.generation ?? 0;
      if (ifGenerationMatch !== null && Number(ifGenerationMatch) !== current) {
        return respond(request, 412);
      }
      const stored = put(bucket, name, requestBody(request));
      return respond(
        request,
        200,
        JSON.stringify({ bucket, name, generation: String(stored.generation) }),
        { "content-type": "application/json" }
      );
    }
    return respond(request, 400);
  };

  const client = HttpClient.make((request, url) => {
    requests.push({
      method: request.method,
      url,
      authorization: request.headers.authorization,
      contentType:
        request.body._tag === "Empty" ? undefined : request.body.contentType,
      body: requestBody(request),
    });
    const forward = Effect.suspend(() => handle(request, url));
    const interceptor = interceptors.shift();
    return interceptor === undefined
      ? forward
      : interceptor({ request, forward });
  });

  return {
    client,
    layer: Layer.succeed(HttpClient.HttpClient, client),
    requests,
    /** Answer the next requests with these interceptors, in order. */
    intercept: (...next: ReadonlyArray<Interceptor>) => {
      interceptors.push(...next);
    },
    /** Another writer, outside any store instance. */
    put,
    get: (bucket: string, object: string) => objects.get(keyOf(bucket, object)),
  };
};

export type FakeCloudStorage = ReturnType<typeof makeFakeCloudStorage>;
