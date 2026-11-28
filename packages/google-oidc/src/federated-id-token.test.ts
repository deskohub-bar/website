import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { GoogleIdToken } from "./federated-id-token";

const googleProject = "synthetic-project";
const serviceAccount = `frontend@${googleProject}.iam.gserviceaccount.com`;
const audience = "https://workspace-api.example.test";
const workloadIdentityProvider =
  "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/test";
const subjectToken = "synthetic-external-token";
const accessToken = "synthetic-access-token";
const input = {
  serviceAccount,
  audience,
  workloadIdentityProvider,
  getSubjectToken: () => Promise.resolve(subjectToken),
};

const tokenExpiringAt = (exp: number) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.fake-signature`;
const expiresNextHour = () =>
  tokenExpiringAt(Math.floor(Date.now() / 1000) + 3600);
const stsSuccess = () => Response.json({ access_token: accessToken });
const iamSuccess = () => Response.json({ token: expiresNextHour() });

const fakeGoogle = (
  sts: () => Effect.Effect<Response> = () => Effect.sync(stsSuccess),
  iam: () => Effect.Effect<Response> = () => Effect.sync(iamSuccess)
) => {
  const calls: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request, url) => {
    calls.push(request);
    const answer = url.hostname === "sts.googleapis.com" ? sts : iam;
    return Effect.map(answer(), (response) =>
      HttpClientResponse.fromWeb(request, response)
    );
  });
  const layer = GoogleIdToken.Default.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
  );
  return { calls, layer };
};

test("exchanges a request's external token on cache miss and reuses the ID token", async () => {
  const google = fakeGoogle();
  const requestContext = new AsyncLocalStorage<string>();
  let subjectReads = 0;
  const request = {
    ...input,
    getSubjectToken: () => {
      subjectReads += 1;
      return Promise.resolve(requestContext.getStore() ?? "outside-request");
    },
  };
  const [initial, cached] = await requestContext.run(subjectToken, () =>
    Effect.gen(function* () {
      const tokens = yield* GoogleIdToken;
      return [yield* tokens.get(request), yield* tokens.get(request)] as const;
    }).pipe(
      Effect.withSpan("synthetic-request"),
      Effect.provide(google.layer),
      Effect.runPromise
    )
  );

  expect(initial).toBe(cached);
  expect(String(initial)).not.toContain(Redacted.value(initial));
  expect(subjectReads).toBe(1);
  const [sts, iam] = await Effect.forEach(google.calls, (call) =>
    HttpClientRequest.toWeb(call)
  ).pipe(Effect.runPromise);
  if (!sts || !iam) {
    throw new Error("Expected both STS and IAM requests");
  }
  expect(sts.url).toBe("https://sts.googleapis.com/v1/token");
  expect(sts.method).toBe("POST");
  expect(sts.headers.get("authorization")).toBeNull();
  expect(sts.headers.get("traceparent")).toBeNull();
  expect(Object.fromEntries(new URLSearchParams(await sts.text()))).toEqual({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: workloadIdentityProvider,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: subjectToken,
  });
  expect(iam.url).toBe(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateIdToken`
  );
  expect(iam.method).toBe("POST");
  expect(iam.headers.get("traceparent")).toBeNull();
  expect(iam.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(await iam.json()).toEqual({ audience, includeEmail: true });
  expect(google.calls).toHaveLength(2);
});

test("concurrent misses share a mint even if the first caller disconnects", async () => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const google = fakeGoogle(() =>
    Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.as(stsSuccess())
    )
  );
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    const first = yield* tokens.get(input).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const waiting = yield* Effect.all(
      [
        tokens.get({
          ...input,
          getSubjectToken: () =>
            Promise.reject(new Error("Unexpected subject token read")),
        }),
        tokens.get(input),
      ],
      { concurrency: "unbounded" }
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(release, undefined);
    const [second, third] = yield* Fiber.join(waiting);
    expect(second).toBe(third);
    expect(yield* tokens.get(input)).toBe(second);
  }).pipe(Effect.provide(google.layer), Effect.runPromise);
  expect(google.calls).toHaveLength(2);
});

test("shares a sanitized subject-token failure and lets a later caller mint", async () => {
  const google = fakeGoogle();
  const started = Promise.withResolvers<void>();
  const subject = Promise.withResolvers<string>();
  let followerReads = 0;
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    const first = yield* Effect.flip(
      tokens.get({
        ...input,
        getSubjectToken: () => {
          started.resolve();
          return subject.promise;
        },
      })
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.promise(() => started.promise);
    const follower = yield* Effect.flip(
      tokens.get({
        ...input,
        getSubjectToken: () => {
          followerReads += 1;
          return Promise.resolve(subjectToken);
        },
      })
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.sync(() => subject.reject(new Error(subjectToken)));
    const unavailable = yield* Fiber.join(first);
    expect(yield* Fiber.join(follower)).toBe(unavailable);
    expect(unavailable).toMatchObject({
      _tag: "GoogleIdTokenMintError",
      phase: "subject-token",
      reason: "subject-token-unavailable",
    });
    expect(String(unavailable)).not.toContain(subjectToken);
    expect(JSON.stringify(unavailable)).not.toContain(subjectToken);
    expect(followerReads).toBe(0);
    expect(google.calls).toHaveLength(0);
    expect(Redacted.value(yield* tokens.get(input))).toEndWith(
      ".fake-signature"
    );
  }).pipe(Effect.provide(google.layer), Effect.runPromise);
  expect(google.calls).toHaveLength(2);
});

test("refreshes below the five-minute skew and isolates each account and audience", async () => {
  let mint = 0;
  const google = fakeGoogle(undefined, () =>
    Effect.sync(() => Response.json({ token: tokenExpiringAt(++mint * 3600) }))
  );
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    const initial = yield* tokens.get(input);
    yield* TestClock.adjust("55 minutes");
    expect(yield* tokens.get(input)).toBe(initial);
    yield* TestClock.adjust("1 millis");
    const renewed = yield* tokens.get(input);
    expect(Redacted.value(renewed)).toBe(tokenExpiringAt(7200));
    expect(
      yield* tokens.get({ ...input, audience: "https://other.example.test" })
    ).not.toBe(renewed);
    expect(
      yield* tokens.get({
        ...input,
        serviceAccount: `other@${googleProject}.iam.gserviceaccount.com`,
      })
    ).not.toBe(renewed);
    expect(yield* tokens.get(input)).toBe(renewed);
  }).pipe(
    Effect.provide(Layer.merge(google.layer, TestClock.layer())),
    Effect.runPromise
  );
  expect(google.calls).toHaveLength(8);
});

test("evicts only the credential rejected by Cloud Run", async () => {
  const token = expiresNextHour();
  const google = fakeGoogle(undefined, () =>
    Effect.sync(() => Response.json({ token }))
  );
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    const rejected = yield* tokens.get(input);
    yield* tokens.evict(input, rejected);
    const replacement = yield* tokens.get(input);
    expect(replacement).not.toBe(rejected);
    expect(Redacted.value(replacement)).toBe(Redacted.value(rejected));
    yield* tokens.evict(input, rejected);
    expect(yield* tokens.get(input)).toBe(replacement);
  }).pipe(Effect.provide(google.layer), Effect.runPromise);
  expect(google.calls).toHaveLength(4);
});

test("isolates tokens for different workload identity providers", async () => {
  const google = fakeGoogle();
  const otherProvider = {
    ...input,
    workloadIdentityProvider: `${workloadIdentityProvider}-other`,
  };
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    const original = yield* tokens.get(input);
    const other = yield* tokens.get(otherProvider);
    expect(other).not.toBe(original);
    yield* tokens.evict(otherProvider, original);
    expect(yield* tokens.get(input)).toBe(original);
    expect(yield* tokens.get(otherProvider)).toBe(other);
  }).pipe(Effect.provide(google.layer), Effect.runPromise);
  expect(google.calls).toHaveLength(4);
});

test("bounds retry of transient failures and clears a failed mint", async () => {
  let attempts = 0;
  let subjectReads = 0;
  const google = fakeGoogle(() =>
    Effect.sync(() =>
      ++attempts <= 3 ? new Response(null, { status: 503 }) : stsSuccess()
    )
  );
  const request = {
    ...input,
    getSubjectToken: () => {
      subjectReads += 1;
      return Promise.resolve(subjectToken);
    },
  };
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    expect(yield* Effect.flip(tokens.get(request))).toMatchObject({
      _tag: "GoogleIdTokenMintError",
      phase: "sts",
      reason: "http-status",
      status: 503,
    });
    expect(attempts).toBe(3);
    expect(subjectReads).toBe(1);
    expect(Redacted.value(yield* tokens.get(request))).toEndWith(
      ".fake-signature"
    );
    expect(subjectReads).toBe(2);
  }).pipe(Effect.provide(google.layer), Effect.runPromise);
  expect(google.calls).toHaveLength(5);
});

test.each(["sts", "iam"] as const)(
  "retries an interrupted %s response body",
  async (phase) => {
    const interrupted = () =>
      new Response(
        new ReadableStream({
          start: (body) => body.error(new Error("Synthetic disconnect")),
        })
      );
    let failed = false;
    const answer = (endpoint: typeof phase, success: () => Response) =>
      Effect.sync(() => {
        if (endpoint === phase && !failed) {
          failed = true;
          return interrupted();
        }
        return success();
      });
    const google = fakeGoogle(
      () => answer("sts", stsSuccess),
      () => answer("iam", iamSuccess)
    );
    await Effect.gen(function* () {
      const tokens = yield* GoogleIdToken;
      expect(Redacted.value(yield* tokens.get(input))).toEndWith(
        ".fake-signature"
      );
    }).pipe(Effect.provide(google.layer), Effect.runPromise);
    expect(google.calls).toHaveLength(3);
  }
);

test("shares a single retry budget across STS and IAM attempts", async () => {
  let stsAttempts = 0;
  let iamAttempts = 0;
  const google = fakeGoogle(
    () =>
      Effect.sync(() =>
        ++stsAttempts === 1 ? new Response(null, { status: 503 }) : stsSuccess()
      ),
    () =>
      Effect.sync(() => {
        iamAttempts += 1;
        return new Response(null, { status: 503 });
      })
  );
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    expect(yield* Effect.flip(tokens.get(input))).toMatchObject({
      _tag: "GoogleIdTokenMintError",
      phase: "iam",
      reason: "http-status",
      status: 503,
    });
  }).pipe(Effect.provide(google.layer), Effect.runPromise);
  expect(stsAttempts).toBe(2);
  expect(iamAttempts).toBe(2);
});

test("rejects malformed JSON without retry", async () => {
  const google = fakeGoogle(() => Effect.sync(() => new Response("{broken")));
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    expect(yield* Effect.flip(tokens.get(input))).toMatchObject({
      _tag: "GoogleIdTokenMintError",
      phase: "sts",
      reason: "invalid-response",
    });
  }).pipe(Effect.provide(google.layer), Effect.runPromise);
  expect(google.calls).toHaveLength(1);
});

test.each([
  { status: 403, phase: "sts", reason: "http-status" },
  { status: 200, phase: "sts", reason: "invalid-response" },
  { status: 200, phase: "iam", reason: "invalid-response" },
] as const)(
  "rejects permanent $phase errors ($status) without retry",
  async ({ status, phase, reason }) => {
    const invalid = () => Response.json({ token: subjectToken }, { status });
    const google = fakeGoogle(
      () => Effect.sync(phase === "sts" ? invalid : stsSuccess),
      () => Effect.sync(invalid)
    );
    const error = await Effect.gen(function* () {
      const tokens = yield* GoogleIdToken;
      return yield* Effect.flip(tokens.get(input));
    }).pipe(Effect.provide(google.layer), Effect.runPromise);
    expect(error).toMatchObject({
      _tag: "GoogleIdTokenMintError",
      phase,
      reason,
    });
    expect(String(error)).not.toContain(subjectToken);
    expect(JSON.stringify(error)).not.toContain(subjectToken);
    expect(google.calls).toHaveLength(phase === "sts" ? 1 : 2);
  }
);

test("rejects expired ID tokens and payloads missing exp", async () => {
  const withoutExpiry = "eyJhbGciOiJSUzI1NiJ9.e30.fake-signature";
  const answers = [tokenExpiringAt(10), withoutExpiry];
  const google = fakeGoogle(undefined, () =>
    Effect.sync(() => Response.json({ token: answers.shift() }))
  );
  await Effect.gen(function* () {
    yield* TestClock.adjust("11 seconds");
    const tokens = yield* GoogleIdToken;
    for (const _ of answers.slice()) {
      expect(yield* Effect.flip(tokens.get(input))).toMatchObject({
        _tag: "GoogleIdTokenMintError",
        phase: "iam",
        reason: "invalid-response",
      });
    }
  }).pipe(
    Effect.provide(Layer.merge(google.layer, TestClock.layer())),
    Effect.runPromise
  );
  expect(google.calls).toHaveLength(4);
});

test("times out and aborts each stalled Google request", async () => {
  const signals: AbortSignal[] = [];
  const client = HttpClient.make((_request, _url, signal) => {
    signals.push(signal);
    return Effect.never;
  });
  const layer = GoogleIdToken.Default.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
  );
  await Effect.gen(function* () {
    const tokens = yield* GoogleIdToken;
    const pending = yield* Effect.flip(tokens.get(input)).pipe(
      Effect.forkChild({ startImmediately: true })
    );
    yield* TestClock.adjust("16 seconds");
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "GoogleIdTokenMintError",
      phase: "sts",
      reason: "timeout",
    });
  }).pipe(
    Effect.provide(Layer.merge(layer, TestClock.layer())),
    Effect.runPromise
  );
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
