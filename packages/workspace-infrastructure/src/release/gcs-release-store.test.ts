import { describe, expect, test } from "bun:test";
import { Credentials } from "@alchemy.run/gcp";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import { ImageDigest } from "../config/stack-config";
import { sandboxConfig } from "../config/stack-config.test-utils";
import { refusedCredentials } from "../google-credentials.test-utils";
import {
  type FakeCloudStorage,
  fakeAccessToken,
  fakeCredentialsLayer,
  type Interceptor,
  makeFakeCloudStorage,
  respondWith,
  transportFailure,
} from "./fake-cloud-storage.test-utils";
import {
  makeGcsReleaseRecordStore,
  releaseRecordLocation,
} from "./gcs-release-store";
import { workersServing } from "./release-readback.test-utils";
import { promote, settleApply, stage } from "./release-reconciler";
import {
  emptyReleaseRecord,
  GitSha,
  type ReleaseRecord,
} from "./release-record";
import {
  ReleaseRecordStore,
  ReleaseStoreUnavailable,
  runReleaseStep,
} from "./release-record-store";

const location = releaseRecordLocation(sandboxConfig);
const objectPath = `/storage/v1/b/${sandboxConfig.stateBucket}/o/workspace-release-record.sandbox.json`;
const uploadPath = `/upload/storage/v1/b/${sandboxConfig.stateBucket}/o`;
const shaA = GitSha.make("a".repeat(40));
const shaB = GitSha.make("b".repeat(40));
const digestA = ImageDigest.make(`sha256:${"1".repeat(64)}`);
const t0 = DateTime.makeUnsafe("2026-11-22T10:00:00Z");

const staged = (record: ReleaseRecord, sha: GitSha) =>
  Effect.runSync(
    stage(record, {
      expectedGeneration: record.generation,
      sha,
      imageDigest: digestA,
      origin: "cloud-run",
      liveTemplate: null,
      now: t0,
    })
  ).record;

/** A release step that stages `sha` on whatever record it reads. */
const stageStep = (sha: GitSha) =>
  runReleaseStep((record) =>
    // Yield after the read so concurrent runs hold the same version.
    Effect.andThen(
      Effect.yieldNow,
      stage(record, {
        expectedGeneration: record.generation,
        sha,
        imageDigest: digestA,
        origin: "cloud-run",
        liveTemplate: null,
        now: t0,
      })
    ).pipe(
      Effect.map(({ record: next, releaseId }) => ({
        record: next,
        result: releaseId,
      }))
    )
  );

/**
 * Run against a fresh store instance (a new process) on the fake bucket.
 * The test clock lets retry backoff and attempt timeouts elapse at once.
 */
const withStore = <A, E>(
  fake: FakeCloudStorage,
  use: Effect.Effect<A, E, ReleaseRecordStore>,
  credentials: Layer.Layer<Credentials> = fakeCredentialsLayer
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeGcsReleaseRecordStore(location);
      const fiber = yield* use.pipe(
        Effect.provideService(ReleaseRecordStore, store),
        Effect.result,
        Effect.forkChild
      );
      // Let real response-body promises settle before each tick, so a
      // tick never times out an attempt that has already answered.
      for (
        let tick = 0;
        tick < 600 && fiber.pollUnsafe() === undefined;
        tick += 1
      ) {
        yield* TestClock.withLive(Effect.sleep("1 millis"));
        yield* TestClock.adjust("1 second");
      }
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(Layer.mergeAll(fake.layer, credentials, TestClock.layer()))
    )
  );

const success = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isFailure(result)) {
    throw new Error(`expected success, got ${String(result.failure)}`);
  }
  return result.success;
};

const failure = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isSuccess(result)) {
    throw new Error("expected a failure");
  }
  return result.failure;
};

const read = Effect.flatMap(ReleaseRecordStore, (store) => store.read);
const write = (record: ReleaseRecord, ifVersion: string) =>
  Effect.flatMap(ReleaseRecordStore, (store) => store.write(record, ifVersion));

const storedObject = (fake: FakeCloudStorage) =>
  fake.get(location.bucket, location.object);

const requestLines = (fake: FakeCloudStorage) =>
  fake.requests.map(
    ({ method, url }) =>
      `${method} ${url.pathname}${url.searchParams.has("ifGenerationMatch") ? ` if=${url.searchParams.get("ifGenerationMatch")}` : ""}`
  );

const unavailableReason = (error: { readonly _tag: string }) => {
  if (!(error instanceof ReleaseStoreUnavailable)) {
    throw new Error(`expected ReleaseStoreUnavailable, got ${error._tag}`);
  }
  return error.reason;
};

/**
 * What a write failure adds once an earlier attempt's outcome is unknown,
 * derived from the same refusal with and without a prior server error so
 * tests do not pin its wording.
 */
const uncertaintyNote = async () => {
  const certainFake = makeFakeCloudStorage();
  certainFake.intercept(respondWith(403));
  const certain = failure(
    await withStore(certainFake, write(emptyReleaseRecord, "0"))
  );
  const fake = makeFakeCloudStorage();
  fake.intercept(respondWith(503), respondWith(403));
  const uncertain = failure(
    await withStore(fake, write(emptyReleaseRecord, "0"))
  );
  expect([certain, uncertain]).toMatchObject([
    { _tag: "ReleaseStoreUnavailable", operation: "write", status: 403 },
    { _tag: "ReleaseStoreUnavailable", operation: "write", status: 403 },
  ]);
  expect(fake.requests).toHaveLength(2);
  const certainReason = unavailableReason(certain);
  const uncertainReason = unavailableReason(uncertain);
  expect(uncertainReason.startsWith(certainReason)).toBe(true);
  return uncertainReason.slice(certainReason.length);
};

describe("Cloud Storage release record store", () => {
  test("keeps the record at the state bucket root, outside Alchemy's stage prefixes", () => {
    expect(location).toEqual({
      bucket: sandboxConfig.stateBucket,
      object: "workspace-release-record.sandbox.json",
    });
    expect(location.object).not.toContain("/");
  });

  test("reads a missing object as the empty record at version 0", async () => {
    const fake = makeFakeCloudStorage();
    expect(success(await withStore(fake, read))).toEqual({
      record: emptyReleaseRecord,
      version: "0",
    });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.method).toBe("GET");
    expect(request?.url.origin).toBe("https://storage.googleapis.com");
    expect(request?.url.pathname).toBe(objectPath);
    expect(request?.url.searchParams.get("alt")).toBe("media");
    expect(request?.authorization).toBe(`Bearer ${fakeAccessToken}`);
  });

  test("creates the record only if absent, then compare-and-sets on its generation", async () => {
    const fake = makeFakeCloudStorage();
    const first = staged(emptyReleaseRecord, shaA);
    const created = success(await withStore(fake, write(first, "0")));
    expect(created.record).toEqual(first);
    expect(created.version).toBe(String(storedObject(fake)?.generation));

    const [upload] = fake.requests;
    expect(upload?.method).toBe("POST");
    expect(upload?.url.pathname).toBe(uploadPath);
    expect(Object.fromEntries(upload?.url.searchParams ?? [])).toEqual({
      uploadType: "media",
      name: location.object,
      ifGenerationMatch: "0",
    });
    expect(upload?.contentType).toBe("application/json");
    expect(upload?.authorization).toBe(`Bearer ${fakeAccessToken}`);
    expect(JSON.parse(upload?.body ?? "")).toEqual(first);

    const second = staged(first, shaB);
    const updated = success(
      await withStore(fake, write(second, created.version))
    );
    // Each write is one upload: the answer carries the new generation.
    expect(requestLines(fake)).toEqual([
      `POST ${uploadPath} if=0`,
      `POST ${uploadPath} if=${created.version}`,
    ]);
    expect(Number(updated.version)).toBeGreaterThan(Number(created.version));
    expect(updated.version).toBe(String(storedObject(fake)?.generation));
    expect(success(await withStore(fake, read))).toEqual(updated);
  });

  test("refuses a write whose version lost the race, without retrying or re-reading", async () => {
    const fake = makeFakeCloudStorage();
    const first = staged(emptyReleaseRecord, shaA);
    const created = success(await withStore(fake, write(first, "0")));
    fake.requests.length = 0;

    expect(
      failure(
        await withStore(fake, write(staged(emptyReleaseRecord, shaB), "0"))
      )
    ).toMatchObject({ _tag: "ReleaseRecordConflict", expectedVersion: "0" });
    expect(requestLines(fake)).toEqual([`POST ${uploadPath} if=0`]);
    expect(success(await withStore(fake, read))).toEqual(created);
  });

  test("lets exactly one of two concurrent release steps from the same version win", async () => {
    const fake = makeFakeCloudStorage();
    const outcomes = await withStore(
      fake,
      Effect.all(
        [Effect.result(stageStep(shaA)), Effect.result(stageStep(shaB))],
        {
          concurrency: "unbounded",
        }
      )
    ).then(success);
    expect(outcomes.map((outcome) => outcome._tag).toSorted()).toEqual([
      "Failure",
      "Success",
    ]);
    const lost = outcomes.find(Result.isFailure);
    expect(lost?.failure).toMatchObject({
      _tag: "ReleaseRecordConflict",
      expectedVersion: "0",
    });
    const winner = outcomes.find(Result.isSuccess)?.success;
    const after = success(await withStore(fake, read));
    expect(after.record.generation).toBe(1);
    expect(after.record.candidate?.releaseId).toBe(winner);
    expect(after.record.candidate?.sha).toBe(
      winner?.endsWith(shaA.slice(0, 7)) ? shaA : shaB
    );
  });

  test("refuses a corrupt record and never writes over it", async () => {
    for (const body of ["{not json", JSON.stringify({ generation: "one" })]) {
      const fake = makeFakeCloudStorage();
      const corrupt = fake.put(location.bucket, location.object, body);
      const error = failure(await withStore(fake, stageStep(shaA)));
      expect(error).toMatchObject({
        _tag: "ReleaseRecordCorrupt",
        version: String(corrupt.generation),
      });
      expect(JSON.stringify(error)).not.toContain(body);
      expect(fake.requests.map((request) => request.method)).toEqual(["GET"]);
      expect(storedObject(fake)).toEqual(corrupt);
    }
  });

  test("refuses a record served without a numeric object generation", async () => {
    const fake = makeFakeCloudStorage();
    fake.intercept(
      respondWith(200, JSON.stringify(emptyReleaseRecord)),
      respondWith(200, JSON.stringify(emptyReleaseRecord), {
        "x-goog-generation": "latest",
      })
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(failure(await withStore(fake, read))).toMatchObject({
        _tag: "ReleaseStoreUnavailable",
        operation: "read",
        status: 200,
      });
    }
  });

  test("reads a record written before the writer lock existed as unlocked", async () => {
    const fake = makeFakeCloudStorage();
    const { writer: _writer, ...beforeLock } = emptyReleaseRecord;
    fake.intercept(
      respondWith(200, JSON.stringify({ ...beforeLock, generation: 3 }), {
        "x-goog-generation": "1763900000000001",
      })
    );
    const stored = success(await withStore(fake, read));
    expect(stored.record).toEqual({
      ...emptyReleaseRecord,
      generation: 3,
      writer: null,
    });
  });

  test("fails refused credentials without retrying or exposing the token", async () => {
    for (const status of [401, 403]) {
      const fake = makeFakeCloudStorage();
      fake.intercept(respondWith(status), respondWith(status));
      const readError = failure(await withStore(fake, read));
      const writeError = failure(
        await withStore(fake, write(emptyReleaseRecord, "0"))
      );
      expect([readError, writeError]).toMatchObject([
        { _tag: "ReleaseStoreUnavailable", operation: "read", status },
        { _tag: "ReleaseStoreUnavailable", operation: "write", status },
      ]);
      expect(fake.requests).toHaveLength(2);
      expect(JSON.stringify([readError, writeError])).not.toContain(
        fakeAccessToken
      );
    }
  });

  test("retries throttling, server errors and lost connections, then succeeds", async () => {
    const fake = makeFakeCloudStorage();
    fake.intercept(
      respondWith(503),
      ({ request }) => transportFailure(request),
      respondWith(429)
    );
    expect(success(await withStore(fake, read)).version).toBe("0");
    expect(fake.requests).toHaveLength(4);

    fake.intercept(respondWith(500), respondWith(429));
    const record = staged(emptyReleaseRecord, shaA);
    const written = success(await withStore(fake, write(record, "0")));
    expect(written.version).toBe(String(storedObject(fake)?.generation));
    expect(requestLines(fake).slice(4)).toEqual([
      `POST ${uploadPath} if=0`,
      `POST ${uploadPath} if=0`,
      `POST ${uploadPath} if=0`,
    ]);
  });

  test("gives up after bounded retries with the last status", async () => {
    const fake = makeFakeCloudStorage();
    fake.intercept(...Array.from({ length: 5 }, () => respondWith(503)));
    expect(failure(await withStore(fake, read))).toMatchObject({
      _tag: "ReleaseStoreUnavailable",
      operation: "read",
      status: 503,
    });
    expect(fake.requests).toHaveLength(5);
  });

  test("treats an attempt that never answers as a timeout and retries it", async () => {
    const fake = makeFakeCloudStorage();
    fake.intercept(() => Effect.never);
    expect(success(await withStore(fake, read)).version).toBe("0");
    expect(fake.requests).toHaveLength(2);
  });

  test("confirms a write whose first attempt landed but whose answer was lost", async () => {
    const lostAnswers: ReadonlyArray<Interceptor> = [
      ({ request, forward }) =>
        Effect.andThen(forward, transportFailure(request)),
      // Applied, but the answer never arrives before the attempt timeout.
      ({ forward }) => Effect.andThen(forward, Effect.never),
      (input) => Effect.andThen(input.forward, respondWith(503)(input)),
      // Applied, but the answer does not name the new generation.
      (input) => Effect.andThen(input.forward, respondWith(200, "{}")(input)),
    ];
    for (const lostAnswer of lostAnswers) {
      const fake = makeFakeCloudStorage();
      const record = staged(emptyReleaseRecord, shaA);
      fake.intercept(lostAnswer);
      const written = success(await withStore(fake, write(record, "0")));
      expect(written).toEqual({
        record,
        version: String(storedObject(fake)?.generation),
      });
      expect(requestLines(fake)).toEqual([
        `POST ${uploadPath} if=0`,
        `POST ${uploadPath} if=0`,
        `GET ${objectPath}`,
      ]);
    }
  });

  test("treats a first dispatched attempt's lost precondition as a conflict after a credential stall", async () => {
    const fake = makeFakeCloudStorage();
    const theirs = staged(emptyReleaseRecord, shaA);
    fake.put(location.bucket, location.object, JSON.stringify(theirs));
    let tokenRequests = 0;
    // The first token exchange stalls past the timeout; nothing was sent.
    const stallingCredentials = Layer.succeed(
      Credentials,
      Effect.suspend(() => {
        tokenRequests += 1;
        return tokenRequests === 1
          ? Effect.never
          : Effect.succeed({ accessToken: Redacted.make(fakeAccessToken) });
      })
    );
    expect(
      failure(await withStore(fake, write(theirs, "0"), stallingCredentials))
    ).toMatchObject({ _tag: "ReleaseRecordConflict", expectedVersion: "0" });
    expect(tokenRequests).toBe(2);
    expect(requestLines(fake)).toEqual([`POST ${uploadPath} if=0`]);
  });

  test("never confirms an unanswered write against a missing object", async () => {
    const fake = makeFakeCloudStorage();
    fake.intercept(({ request }) => transportFailure(request));
    expect(
      failure(await withStore(fake, write(emptyReleaseRecord, "123")))
    ).toMatchObject({ _tag: "ReleaseRecordConflict", expectedVersion: "123" });
    expect(requestLines(fake)).toEqual([
      `POST ${uploadPath} if=123`,
      `POST ${uploadPath} if=123`,
      `GET ${objectPath}`,
    ]);
    expect(storedObject(fake)).toBeUndefined();
  });

  test("bounds each attempt at 30 seconds", async () => {
    const delayed =
      (seconds: number): Interceptor =>
      ({ forward }) =>
        Effect.andThen(Effect.sleep(`${seconds} seconds`), forward);
    const fake = makeFakeCloudStorage();
    fake.intercept(delayed(29));
    expect(success(await withStore(fake, read)).version).toBe("0");
    expect(fake.requests).toHaveLength(1);
    fake.intercept(delayed(31));
    expect(success(await withStore(fake, read)).version).toBe("0");
    expect(fake.requests).toHaveLength(3);

    // The token exchange counts against the same deadline.
    const slowTokens = Layer.succeed(
      Credentials,
      Effect.as(Effect.sleep("20 seconds"), {
        accessToken: Redacted.make(fakeAccessToken),
      })
    );
    const slow = makeFakeCloudStorage();
    slow.intercept(delayed(20));
    expect(success(await withStore(slow, read, slowTokens)).version).toBe("0");
    expect(requestLines(slow)).toEqual([
      `GET ${objectPath}`,
      `GET ${objectPath}`,
    ]);
  });

  test("gives up on a write that never answers, saying it may have landed", async () => {
    const note = await uncertaintyNote();
    const throttled = makeFakeCloudStorage();
    throttled.intercept(...Array.from({ length: 5 }, () => respondWith(429)));
    const notApplied = failure(
      await withStore(throttled, write(emptyReleaseRecord, "0"))
    );
    expect(notApplied).toMatchObject({ status: 429 });
    expect(unavailableReason(notApplied).endsWith(note)).toBe(false);

    const fake = makeFakeCloudStorage();
    fake.intercept(...Array.from({ length: 5 }, () => () => Effect.never));
    expect(
      failure(
        await withStore(fake, write(staged(emptyReleaseRecord, shaA), "0"))
      )
    ).toMatchObject({
      _tag: "ReleaseStoreUnavailable",
      operation: "write",
      status: null,
      reason: expect.stringMatching(new RegExp(`${RegExp.escape(note)}$`)),
    });
    expect(fake.requests).toHaveLength(5);
  });

  test("keeps an earlier unknown outcome in a later refusal", async () => {
    expect(await uncertaintyNote()).not.toBe("");
  });

  test("reports a failed confirmation read as an uncertain write", async () => {
    const fake = makeFakeCloudStorage();
    fake.intercept(
      ({ request, forward }) =>
        Effect.andThen(forward, transportFailure(request)),
      ({ forward }) => forward,
      respondWith(401)
    );
    const note = await uncertaintyNote();
    expect(
      failure(
        await withStore(fake, write(staged(emptyReleaseRecord, shaA), "0"))
      )
    ).toMatchObject({
      _tag: "ReleaseStoreUnavailable",
      operation: "write",
      status: 401,
      reason: expect.stringMatching(new RegExp(`${RegExp.escape(note)}$`)),
    });
    expect(requestLines(fake)).toEqual([
      `POST ${uploadPath} if=0`,
      `POST ${uploadPath} if=0`,
      `GET ${objectPath}`,
    ]);
  });

  test("counts an equal record from another writer as this write, and a superseded one as a conflict", async () => {
    const ours = staged(emptyReleaseRecord, shaA);
    const theirs = JSON.stringify(staged(emptyReleaseRecord, shaB));

    const coalesced = makeFakeCloudStorage();
    coalesced.intercept(({ request }) => {
      coalesced.put(location.bucket, location.object, JSON.stringify(ours));
      return transportFailure(request);
    });
    expect(success(await withStore(coalesced, write(ours, "0")))).toEqual({
      record: ours,
      version: String(
        coalesced.get(location.bucket, location.object)?.generation
      ),
    });

    const superseded = makeFakeCloudStorage();
    superseded.intercept(({ request, forward }) =>
      Effect.andThen(
        forward,
        Effect.suspend(() => {
          superseded.put(location.bucket, location.object, theirs);
          return transportFailure(request);
        })
      )
    );
    expect(
      failure(await withStore(superseded, write(ours, "0")))
    ).toMatchObject({ _tag: "ReleaseRecordConflict", expectedVersion: "0" });
    expect(superseded.get(location.bucket, location.object)?.body).toBe(theirs);
  });

  test("sends nothing when credentials fail or never resolve", async () => {
    let tokenRequests = 0;
    const refused = Layer.succeed(
      Credentials,
      Effect.suspend(() => {
        tokenRequests += 1;
        return refusedCredentials("token exchange refused");
      })
    );
    const stalled = Layer.succeed(Credentials, Effect.never);
    for (const credentials of [refused, stalled]) {
      const fake = makeFakeCloudStorage();
      expect(
        failure(
          await withStore(fake, write(emptyReleaseRecord, "0"), credentials)
        )
      ).toMatchObject({
        _tag: "ReleaseStoreUnavailable",
        operation: "write",
        status: null,
      });
      expect(fake.requests).toHaveLength(0);
    }
    // A refused token exchange is not retried.
    expect(tokenRequests).toBe(1);
  });

  test("dies with a fixed message, without the record, when a record does not encode", async () => {
    const fake = makeFakeCloudStorage();
    const invalid = { ...emptyReleaseRecord, generation: -987_654 };
    const exit = await withStore(fake, Effect.exit(write(invalid, "0"))).then(
      success
    );
    if (exit._tag !== "Failure") {
      throw new Error("expected the write to die");
    }
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.pretty(exit.cause)).not.toContain("987654");
    expect(fake.requests).toHaveLength(0);
  });

  test("treats a lost precondition after a throttled attempt as a conflict", async () => {
    const fake = makeFakeCloudStorage();
    const theirs = staged(emptyReleaseRecord, shaA);
    fake.put(location.bucket, location.object, JSON.stringify(theirs));
    fake.intercept(respondWith(429));
    // Throttling proves nothing was applied, so no re-read can rescue the
    // write, even when the stored record happens to equal it.
    expect(failure(await withStore(fake, write(theirs, "0")))).toMatchObject({
      _tag: "ReleaseRecordConflict",
      expectedVersion: "0",
    });
    expect(requestLines(fake)).toEqual([
      `POST ${uploadPath} if=0`,
      `POST ${uploadPath} if=0`,
    ]);
  });

  test("reports a conflict when another writer won during an unanswered attempt", async () => {
    const fake = makeFakeCloudStorage();
    const ours = staged(emptyReleaseRecord, shaA);
    const theirs = JSON.stringify(staged(emptyReleaseRecord, shaB));
    fake.intercept(({ request }) => {
      fake.put(location.bucket, location.object, theirs);
      return transportFailure(request);
    });
    expect(failure(await withStore(fake, write(ours, "0")))).toMatchObject({
      _tag: "ReleaseRecordConflict",
      expectedVersion: "0",
    });
    expect(storedObject(fake)?.body).toBe(theirs);
  });

  test("lets a new process settle an apply that an interrupted run left pending", async () => {
    const fake = makeFakeCloudStorage();
    // The interrupted run staged, persisted the promotion intent, and died
    // before settling it.
    const releaseId = success(await withStore(fake, stageStep(shaA)));
    const pending = success(
      await withStore(
        fake,
        runReleaseStep((record) =>
          promote(record, {
            expectedGeneration: record.generation,
            releaseId,
            now: t0,
            candidateReadback: null,
          }).pipe(Effect.map((next) => ({ record: next, result: next })))
        )
      )
    );
    const target = pending.pendingApply?.target;
    expect(target).toBeDefined();

    const settled = success(
      await withStore(
        fake,
        Effect.andThen(
          runReleaseStep((record) =>
            settleApply(record, {
              expectedGeneration: record.generation,
              readback: {
                servingRevision: target?.revision ?? null,
                servingImageDigest: target?.imageDigest ?? null,
                trafficGeneration:
                  record.pendingApply?.trafficGeneration ?? null,
              },
              workers: workersServing(target?.imageDigest ?? null),
              now: t0,
            }).pipe(Effect.map((next) => ({ record: next, result: next })))
          ),
          read
        )
      )
    );
    expect(settled.record.pendingApply).toBeNull();
    expect(settled.record.active?.releaseId).toBe(target?.releaseId);
  });
});
