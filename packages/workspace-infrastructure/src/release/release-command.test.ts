import { describe, expect, test } from "bun:test";
import { GcpEnvironment } from "@alchemy.run/gcp";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { GcpRegion, type WorkspaceStackConfig } from "../config/stack-config";
import { sandboxConfig } from "../config/stack-config.test-utils";
import {
  fakeCredentialsLayer,
  makeFakeCloudStorage,
} from "./fake-cloud-storage.test-utils";
import { releaseRecordLocation } from "./gcs-release-store";
import {
  ReleaseStack,
  releaseCommand,
  releaseRuntime,
} from "./release-command";
import {
  ReleaseServiceApply,
  ReleaseServiceReadback,
} from "./release-platform";
import { emptyReleaseRecord, type ReleaseRecord } from "./release-record";
import {
  makeInMemoryReleaseRecordStore,
  ReleaseRecordStore,
} from "./release-record-store";
import { describeStoredRecord, writerFingerprint } from "./release-writer";
import { heldBy } from "./release-writer.test-utils";

const decodeStoredRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

/**
 * Runs one command against an in-memory record and a project with no
 * services, whose apply and revision reads must stay untouched.
 */
const runRelease = (
  args: ReadonlyArray<string>,
  initial: ReleaseRecord = emptyReleaseRecord
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeInMemoryReleaseRecordStore(initial);
      const platformCalls: Array<string> = [];
      const untouched = (name: string) =>
        Effect.sync(() => {
          platformCalls.push(name);
        }).pipe(Effect.andThen(Effect.die(`unexpected ${name}`)));
      const exit = yield* Command.runWith(releaseCommand, {
        version: "0.0.0",
      })(args).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ReleaseStack, sandboxConfig),
            Layer.succeed(ReleaseRecordStore, store),
            Layer.succeed(
              ReleaseServiceApply,
              ReleaseServiceApply.of({ apply: () => untouched("apply") })
            ),
            Layer.succeed(
              ReleaseServiceReadback,
              ReleaseServiceReadback.of({
                service: () =>
                  Effect.sync(() => {
                    platformCalls.push("service readback");
                    return null;
                  }),
                revision: () => untouched("revision readback"),
              })
            ),
            BunServices.layer
          )
        ),
        Effect.exit
      );
      return { exit, stored: yield* store.read, platformCalls };
    })
  );

describe("workspace release command", () => {
  test("status reads the record without touching the platform", async () => {
    const result = await runRelease(["status"]);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.platformCalls).toEqual([]);
  });

  test("deliver refuses a tag in place of a digest before any write", async () => {
    const result = await runRelease([
      "deliver",
      "--sha",
      "a".repeat(40),
      "--image-digest",
      "latest",
    ]);
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.stored).toEqual({ record: emptyReleaseRecord, version: "1" });
    expect(result.platformCalls).toEqual([]);
  });

  test("restore refuses a malformed release id before any write", async () => {
    const result = await runRelease([
      "restore",
      "--release-id",
      "previous",
      "--expected-generation",
      "0",
    ]);
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.stored.version).toBe("1");
    expect(result.platformCalls).toEqual([]);
  });

  test("recover with nothing pending applies nothing", async () => {
    const result = await runRelease(["recover"]);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    // It only reads the services, to rule out a lost record.
    expect(result.platformCalls).not.toContain("apply");
  });

  test("unlock clears only the lock its fingerprint names", async () => {
    const locked = heldBy(emptyReleaseRecord, "deliver");
    const holder =
      locked.writer === null
        ? ""
        : writerFingerprint(locked.writer.holderDigest);
    const wrong = await runRelease(
      ["unlock", "--holder", "000000000000"],
      locked
    );
    expect(Exit.isFailure(wrong.exit)).toBe(true);
    expect(wrong.stored.record).toEqual(locked);
    const cleared = await runRelease(["unlock", "--holder", holder], locked);
    expect(Exit.isSuccess(cleared.exit)).toBe(true);
    expect(cleared.stored.record.writer).toBeNull();
  });

  test("status names the lock by fingerprint, never by digest", () => {
    const locked = heldBy(emptyReleaseRecord, "deploy");
    const printed = JSON.stringify(
      describeStoredRecord({ record: locked, version: "4" })
    );
    expect(printed).not.toContain(locked.writer?.holderDigest ?? "<none>");
    expect(printed).toContain(
      locked.writer === null
        ? "<none>"
        : writerFingerprint(locked.writer.holderDigest)
    );
  });
});

/**
 * Runs one command on the release runtime itself, over a fake Cloud
 * Storage whose state bucket sits in europe-west1 and a Cloud Run API that
 * has no service anywhere, so a config naming another region would see a
 * quiet stage.
 */
const runOnRuntime = async (
  args: ReadonlyArray<string>,
  config: WorkspaceStackConfig,
  initial: ReleaseRecord
) => {
  const storage = makeFakeCloudStorage();
  const location = releaseRecordLocation(config);
  storage.put(location.bucket, location.object, JSON.stringify(initial));
  const cloudRunReads: Array<string> = [];
  const client = HttpClient.make((request, url) => {
    if (url.hostname !== "run.googleapis.com") {
      return storage.client.execute(request);
    }
    cloudRunReads.push(url.pathname);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ error: { code: 404 } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      )
    );
  });
  const access = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    fakeCredentialsLayer,
    Layer.succeed(
      GcpEnvironment,
      Effect.succeed({
        project: config.projectId,
        region: config.region,
        // Never read by the runtime; synthetic.
        accessToken: Redacted.make("synthetic-access-token"),
      })
    )
  );
  const exit = await Effect.runPromiseExit(
    Command.runWith(releaseCommand, { version: "0.0.0" })(args).pipe(
      Effect.provide(
        Layer.mergeAll(releaseRuntime(config, access), BunServices.layer)
      )
    )
  );
  const stored = storage.get(location.bucket, location.object);
  return {
    exit,
    record: stored === undefined ? undefined : decodeStoredRecord(stored.body),
    writes: storage.requests.filter(({ method }) => method === "POST"),
    cloudRunReads,
  };
};

describe("workspace release runtime region", () => {
  const otherRegion: WorkspaceStackConfig = {
    ...sandboxConfig,
    region: GcpRegion.make("europe-west3"),
  };
  const locked = heldBy(emptyReleaseRecord, "deliver");
  const holder =
    locked.writer === null ? "" : writerFingerprint(locked.writer.holderDigest);

  test("unlock clears the lock in the stage's own region", async () => {
    const result = await runOnRuntime(
      ["unlock", "--holder", holder],
      sandboxConfig,
      locked
    );
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.record?.writer).toBeNull();
  });

  test("unlock refuses a config in another region before reading Cloud Run", async () => {
    const result = await runOnRuntime(
      ["unlock", "--holder", holder],
      otherRegion,
      locked
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(String(result.exit)).toContain("StageRegionMismatch");
    expect(result.record).toEqual(locked);
    expect(result.writes).toEqual([]);
    expect(result.cloudRunReads).toEqual([]);
  });

  test("recover refuses a config in another region before the lost-record guard", async () => {
    // A lost record: the stage's services may run in europe-west1 while
    // the record is empty. Another region would see none of them.
    const result = await runOnRuntime(
      ["recover"],
      otherRegion,
      emptyReleaseRecord
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(String(result.exit)).toContain("StageRegionMismatch");
    expect(result.writes).toEqual([]);
    expect(result.cloudRunReads).toEqual([]);
  });
});
