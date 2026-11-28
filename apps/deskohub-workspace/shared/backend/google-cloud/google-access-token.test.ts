import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import {
  GoogleAccessToken,
  MetadataServerGoogleAccessToken,
} from "./google-access-token";

type TokenRequest = { readonly url: string; readonly headers: Headers };

const withMetadataServer = <A, E>(
  respond: (count: number) => Response,
  run: (accessToken: GoogleAccessToken["Service"]) => Effect.Effect<A, E>
) => {
  const requests: TokenRequest[] = [];
  const fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return respond(requests.length);
    },
    { preconnect: globalThis.fetch.preconnect }
  );
  return Effect.gen(function* () {
    return yield* run(yield* GoogleAccessToken);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(MetadataServerGoogleAccessToken, TestClock.layer())
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.result,
    Effect.runPromise,
    (result) => result.then((outcome) => ({ outcome, requests }))
  );
};

const tokenResponse = (count: number) =>
  Response.json({
    access_token: `token-${count}`,
    expires_in: 3600,
    token_type: "Bearer",
  });

describe("MetadataServerGoogleAccessToken", () => {
  test("asks the metadata server for the service account token", async () => {
    const { outcome, requests } = await withMetadataServer(
      tokenResponse,
      ({ get }) => get
    );

    expect(outcome).toMatchObject({ success: "token-1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
    );
    expect(requests[0]?.headers.get("metadata-flavor")).toBe("Google");
  });

  test("reuses the token until shortly before it expires", async () => {
    const { outcome, requests } = await withMetadataServer(
      tokenResponse,
      ({ get }) =>
        Effect.gen(function* () {
          const first = yield* get;
          yield* TestClock.adjust("58 minutes");
          const reused = yield* get;
          yield* TestClock.adjust("1 minute");
          const refreshed = yield* get;
          return [first, reused, refreshed];
        })
    );

    expect(outcome).toMatchObject({
      success: ["token-1", "token-1", "token-2"],
    });
    expect(requests).toHaveLength(2);
  });

  test("shares one refresh between concurrent callers", async () => {
    const { outcome, requests } = await withMetadataServer(
      tokenResponse,
      ({ get }) => Effect.all([get, get, get], { concurrency: "unbounded" })
    );

    expect(outcome).toMatchObject({
      success: ["token-1", "token-1", "token-1"],
    });
    expect(requests).toHaveLength(1);
  });

  test("retries an unavailable metadata server within one call", async () => {
    const { outcome, requests } = await withMetadataServer(
      (count) =>
        count === 1
          ? new Response(null, { status: 503 })
          : tokenResponse(count),
      ({ get }) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(get);
          yield* TestClock.adjust("1 second");
          return yield* Fiber.join(fiber);
        })
    );

    expect(outcome).toMatchObject({ success: "token-2" });
    expect(requests).toHaveLength(2);
  });

  test("retries a token response whose body breaks off", async () => {
    const { outcome, requests } = await withMetadataServer(
      (count) =>
        count === 1
          ? new Response(
              new ReadableStream({
                start: (controller) =>
                  controller.error(new Error("connection reset")),
              }),
              { status: 200 }
            )
          : tokenResponse(count),
      ({ get }) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(get);
          yield* TestClock.adjust("1 second");
          return yield* Fiber.join(fiber);
        })
    );

    expect(outcome).toMatchObject({ success: "token-2" });
    expect(requests).toHaveLength(2);
  });

  test("gives up a refresh at its deadline and lets a waiting caller refresh", async () => {
    const { outcome, requests } = await withMetadataServer(
      (count) =>
        count === 1
          ? new Response(null, {
              status: 503,
              headers: { "Retry-After": "120" },
            })
          : tokenResponse(count),
      ({ get }) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(Effect.flip(get));
          const waiting = yield* Effect.forkChild(get);
          yield* TestClock.adjust("31 seconds");
          return {
            first: yield* Fiber.join(first),
            waiting: yield* Fiber.join(waiting),
          };
        })
    );

    expect(outcome).toMatchObject({
      success: {
        first: { _tag: "GoogleAccessTokenError", reason: "timeout" },
        waiting: "token-2",
      },
    });
    expect(requests).toHaveLength(2);
  });

  test("fails on a rejected request without retrying it", async () => {
    const { outcome, requests } = await withMetadataServer(
      () => new Response(null, { status: 403 }),
      ({ get }) => get
    );

    expect(outcome).toMatchObject({
      failure: {
        _tag: "GoogleAccessTokenError",
        reason: "status",
        httpStatus: 403,
      },
    });
    expect(requests).toHaveLength(1);
  });

  test("times out a token response whose body never arrives", async () => {
    const { outcome, requests } = await withMetadataServer(
      (count) =>
        count <= 3
          ? new Response(new ReadableStream({ start: () => undefined }), {
              status: 200,
            })
          : tokenResponse(count),
      ({ get }) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.flip(get));
          for (let attempt = 0; attempt < 3; attempt += 1) {
            yield* TestClock.adjust("11 seconds");
          }
          const failure = yield* Fiber.join(fiber);
          return { failure, next: yield* get };
        })
    );

    expect(outcome).toMatchObject({
      success: {
        failure: { _tag: "GoogleAccessTokenError", reason: "timeout" },
        next: "token-4",
      },
    });
    expect(requests).toHaveLength(4);
  });

  test("fetches another token after the current one is invalidated", async () => {
    const { outcome, requests } = await withMetadataServer(
      tokenResponse,
      ({ get, invalidate }) =>
        Effect.gen(function* () {
          const first = yield* get;
          yield* invalidate("token-0");
          const kept = yield* get;
          yield* invalidate(first);
          const replaced = yield* get;
          return [first, kept, replaced];
        })
    );

    expect(outcome).toMatchObject({
      success: ["token-1", "token-1", "token-2"],
    });
    expect(requests).toHaveLength(2);
  });

  test("rejects an empty access token", async () => {
    const { outcome } = await withMetadataServer(
      () => Response.json({ access_token: "", expires_in: 3600 }),
      ({ get }) => get
    );

    expect(outcome).toMatchObject({
      failure: { _tag: "GoogleAccessTokenError", reason: "invalid-response" },
    });
  });

  test.each([
    ["a document without a token", JSON.stringify({ token_type: "Bearer" })],
    ["a body that is not JSON", "not json"],
  ])("fails on %s without retrying it", async (_, body) => {
    const { outcome, requests } = await withMetadataServer(
      () => new Response(body, { status: 200 }),
      ({ get }) => get
    );

    expect(outcome).toMatchObject({
      failure: { _tag: "GoogleAccessTokenError", reason: "invalid-response" },
    });
    expect(requests).toHaveLength(1);
  });
});
