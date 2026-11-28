import { describe, expect, test } from "bun:test";
import { Credentials } from "@alchemy.run/gcp";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { type GoogleApiCall, makeGoogleApi } from "./google-api";
import { refusedCredentials } from "./google-credentials.test-utils";

// Synthetic; the fake only checks that it is sent as the bearer token.
const accessToken = "synthetic-access-token";
const url = "https://example.googleapis.com/v1/things/one";

class CallFailed extends Data.TaggedError("CallFailed")<{
  readonly status: number | null;
  readonly reason: string;
}> {}

type Answer =
  | { readonly transport: "failed" | "stalled" }
  | { readonly status: number; readonly stallBody?: boolean };

/** A Google API stand-in that answers from a queue, the last answer repeating. */
const fakeGoogleApi = (answers: ReadonlyArray<Answer>) => {
  const queue = [...answers];
  const requests: Array<{
    readonly authorization: string | undefined;
    readonly quotaProject: string | undefined;
    readonly signal: AbortSignal;
  }> = [];
  const client = HttpClient.make((request, _url, signal) => {
    requests.push({
      authorization: request.headers.authorization,
      quotaProject: request.headers["x-goog-user-project"],
      signal,
    });
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? {
      status: 200,
    };
    if ("transport" in answer) {
      return answer.transport === "stalled"
        ? Effect.never
        : Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          );
    }
    const body = answer.stallBody
      ? new ReadableStream({
          start: (controller) => controller.enqueue(new Uint8Array([123])),
        })
      : "ok";
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status: answer.status })
      )
    );
  });
  return { client, requests };
};

const policy = {
  attemptTimeout: "10 seconds",
  backoff: "100 millis",
  retries: 3,
} as const;

/** A call that reads the body of a 200 and refuses any other answer. */
const readCall = (
  overrides: Partial<GoogleApiCall<string, CallFailed>> = {}
): GoogleApiCall<string, CallFailed> => ({
  request: HttpClientRequest.get(url),
  policy,
  handle: (response) =>
    response.status === 200
      ? response.text.pipe(
          Effect.mapError(
            () => new CallFailed({ status: null, reason: "body cut off" })
          )
        )
      : Effect.fail(
          new CallFailed({ status: response.status, reason: "refused" })
        ),
  transientStatus: (status) => new CallFailed({ status, reason: "transient" }),
  noAnswer: (cause) =>
    new CallFailed({
      status: null,
      reason: cause,
    }),
  credentialsUnavailable: () =>
    new CallFailed({ status: null, reason: "credentials unavailable" }),
  ...overrides,
});

const fixedCredentials: typeof Credentials.Service = Effect.succeed({
  accessToken: Redacted.make(accessToken),
});

/** Run one call against the fake, skipping every timeout and backoff. */
const run = (
  fake: ReturnType<typeof fakeGoogleApi>,
  call: GoogleApiCall<string, CallFailed>,
  credentials: typeof Credentials.Service = fixedCredentials
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const googleApi = yield* makeGoogleApi();
      const fiber = yield* Effect.forkChild(googleApi.call(call));
      yield* TestClock.adjust("10 minutes");
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, fake.client),
          Layer.succeed(Credentials, credentials),
          TestClock.layer()
        )
      )
    )
  );

const failure = (exit: Exit.Exit<string, CallFailed>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected a failure, got ${exit.value}`);
  }
  const reason = exit.cause.reasons[0];
  return reason?._tag === "Fail" ? reason.error : reason;
};

const success = (exit: Exit.Exit<string, CallFailed>) => {
  if (Exit.isFailure(exit)) {
    throw new Error(`expected a success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

describe("Google API calls", () => {
  test("sends the bearer token and bills user credentials to their quota project", async () => {
    const fake = fakeGoogleApi([{ status: 200 }]);
    expect(success(await run(fake, readCall()))).toBe("ok");
    const billed = fakeGoogleApi([{ status: 200 }]);
    success(
      await run(
        billed,
        readCall(),
        Effect.succeed({
          accessToken: Redacted.make(accessToken),
          quotaProject: "quota-project",
        })
      )
    );
    expect(
      [...fake.requests, ...billed.requests].map(
        ({ authorization, quotaProject }) => ({ authorization, quotaProject })
      )
    ).toEqual([
      { authorization: `Bearer ${accessToken}`, quotaProject: undefined },
      { authorization: `Bearer ${accessToken}`, quotaProject: "quota-project" },
    ]);
  });

  test("retries transport failures, 429 and 5xx, then answers", async () => {
    const fake = fakeGoogleApi([
      { transport: "failed" },
      { status: 429 },
      { status: 503 },
      { status: 200 },
    ]);
    expect(success(await run(fake, readCall()))).toBe("ok");
    expect(fake.requests).toHaveLength(4);
  });

  test("fails with the last transient failure once the retries are spent", async () => {
    const fake = fakeGoogleApi([{ status: 429 }, { status: 500 }]);
    const seen: Array<string> = [];
    expect(
      failure(
        await run(
          fake,
          readCall({
            onAttemptFailure: (error) =>
              Effect.sync(() => seen.push(`${error.status}`)),
          })
        )
      )
    ).toMatchObject({ _tag: "CallFailed", status: 500, reason: "transient" });
    expect(fake.requests).toHaveLength(policy.retries + 1);
    expect(seen).toEqual(["429", "500", "500", "500"]);
  });

  test("hands any other 4xx to the caller without retrying", async () => {
    for (const status of [400, 401, 403, 404, 412]) {
      const fake = fakeGoogleApi([{ status }, { status: 200 }]);
      expect(failure(await run(fake, readCall()))).toMatchObject({
        status,
        reason: "refused",
      });
      expect(fake.requests).toHaveLength(1);
    }
  });

  test("retries a handled failure only when the caller says it may pass", async () => {
    const answers: ReadonlyArray<Answer> = [{ status: 409 }, { status: 200 }];
    const retried = fakeGoogleApi(answers);
    expect(
      success(
        await run(
          retried,
          readCall({ retryHandledFailure: ({ status }) => status === 409 })
        )
      )
    ).toBe("ok");
    expect(retried.requests).toHaveLength(2);
  });

  test("times out an attempt whose body is still streaming, and releases it", async () => {
    const fake = fakeGoogleApi([
      { status: 200, stallBody: true },
      { status: 200 },
    ]);
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const googleApi = yield* makeGoogleApi();
        const fiber = yield* Effect.forkChild(googleApi.call(readCall()));
        const seen: Array<number> = [];
        for (const step of ["9999 millis", "1 millis", "100 millis"] as const) {
          yield* TestClock.adjust(step);
          seen.push(fake.requests.length);
        }
        expect(yield* Fiber.join(fiber)).toBe("ok");
        return seen;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, fake.client),
            Layer.succeed(Credentials, fixedCredentials),
            TestClock.layer()
          )
        )
      )
    );
    expect(attempts).toEqual([1, 1, 2]);
    expect(fake.requests[0]?.signal.aborted).toBe(true);

    const stalled = fakeGoogleApi([{ status: 200, stallBody: true }]);
    expect(failure(await run(stalled, readCall()))).toMatchObject({
      reason: "no-answer-in-time",
    });
    expect(stalled.requests).toHaveLength(policy.retries + 1);
  });

  test("ends on a failed token lookup without a request, a retry or its text", async () => {
    let lookups = 0;
    const lookupsOf = (
      lookup: typeof Credentials.Service
    ): typeof Credentials.Service =>
      Effect.suspend(() => {
        lookups += 1;
        return lookup;
      });
    // Any failure or defect of the lookup must surface the same way.
    for (const credentials of [
      lookupsOf(refusedCredentials(`refused ${accessToken}`)),
      lookupsOf(Effect.die(new Error(`crashed on ${accessToken}`))),
    ]) {
      const fake = fakeGoogleApi([{ status: 200 }]);
      const error = failure(await run(fake, readCall(), credentials));
      expect(error).toMatchObject({ reason: "credentials unavailable" });
      expect(JSON.stringify(error)).not.toContain(accessToken);
      expect(String(error)).not.toContain(accessToken);
      expect(fake.requests).toHaveLength(0);
    }
    expect(lookups).toBe(2);
  });

  test("retries a token lookup that outlasts the deadline, sending nothing", async () => {
    const fake = fakeGoogleApi([{ status: 200 }]);
    expect(failure(await run(fake, readCall(), Effect.never))).toMatchObject({
      reason: "credentials-stalled",
    });
    expect(fake.requests).toHaveLength(0);
  });

  test("looks a token up once per call when asked, ending on a stalled lookup", async () => {
    let lookups = 0;
    const counted = (
      lookup: typeof Credentials.Service
    ): typeof Credentials.Service =>
      Effect.suspend(() => {
        lookups += 1;
        return lookup;
      });
    const fake = fakeGoogleApi([{ status: 503 }, { status: 200 }]);
    expect(
      success(
        await run(
          fake,
          readCall({ tokenLookup: "once" }),
          counted(fixedCredentials)
        )
      )
    ).toBe("ok");
    expect(fake.requests).toHaveLength(2);
    expect(lookups).toBe(1);

    lookups = 0;
    const stalled = fakeGoogleApi([{ status: 200 }]);
    expect(
      failure(
        await run(
          stalled,
          readCall({ tokenLookup: "once" }),
          counted(Effect.never)
        )
      )
    ).toMatchObject({ reason: "credentials unavailable" });
    expect(lookups).toBe(1);
    expect(stalled.requests).toHaveLength(0);
  });
});
