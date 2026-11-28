import { describe, expect, test } from "bun:test";
import { GcpEnvironment } from "@alchemy.run/gcp";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { GcpRegion, type WorkspaceStackConfig } from "./config/stack-config";
import { sandboxConfig } from "./config/stack-config.test-utils";
import {
  type FakeBucketLocation,
  fakeCredentialsLayer,
  makeFakeCloudStorage,
  respondWith,
  sandboxBucketLocation,
} from "./release/fake-cloud-storage.test-utils";
import { verifyStackTarget } from "./stack-target";

const check = async (
  stage: string,
  project: string,
  {
    config = sandboxConfig,
    bucket = sandboxBucketLocation,
    prepare = () => {},
  }: {
    readonly config?: WorkspaceStackConfig;
    readonly bucket?: FakeBucketLocation;
    readonly prepare?: (fake: ReturnType<typeof makeFakeCloudStorage>) => void;
  } = {}
) => {
  const fake = makeFakeCloudStorage(bucket);
  prepare(fake);
  const exit = await Effect.runPromiseExit(
    verifyStackTarget(config).pipe(
      Effect.provideService(Stage, stage),
      Effect.provide(
        Layer.mergeAll(
          fake.layer,
          fakeCredentialsLayer,
          Layer.succeed(
            GcpEnvironment,
            Effect.succeed({
              project,
              region: "europe-west1",
              // Never read by the check; synthetic.
              accessToken: Redacted.make("synthetic-access-token"),
            })
          )
        )
      )
    )
  );
  const failure = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined;
  return { exit, failure, requests: fake.requests };
};

describe("stack target", () => {
  test("accepts the configured stage, project and the state bucket's region", async () => {
    const { exit, requests } = await check("sandbox", "deskohub-ws-sandbox");
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(
      requests.map(({ method, url }) => `${method} ${url.pathname}`)
    ).toEqual([`GET /storage/v1/b/${sandboxConfig.stateBucket}`]);
  });

  test("refuses another stage or another effective project before any read", async () => {
    for (const [stage, project] of [
      ["production", "deskohub-ws-sandbox"],
      ["sandbox", "deskohub-ws-production"],
    ] as const) {
      const { failure, requests } = await check(stage, project);
      expect(failure).toMatchObject({ _tag: "StackTargetMismatch" });
      expect(requests).toEqual([]);
    }
  });

  test("refuses a config whose region is not the state bucket's", async () => {
    const { failure } = await check("sandbox", "deskohub-ws-sandbox", {
      config: { ...sandboxConfig, region: GcpRegion.make("europe-west3") },
    });
    expect(failure).toMatchObject({
      _tag: "StageRegionMismatch",
      configuredRegion: "europe-west3",
      stateBucketLocation: "europe-west1",
    });
  });

  test("a dual- or multi-region state bucket binds no region", async () => {
    for (const bucket of [
      { location: "EU", locationType: "multi-region" },
      { location: "EUR4", locationType: "dual-region" },
    ]) {
      const { failure } = await check("sandbox", "deskohub-ws-sandbox", {
        bucket,
      });
      expect(failure).toMatchObject({ _tag: "StageRegionMismatch" });
    }
  });

  test("an unreadable state bucket refuses without a region", async () => {
    for (const status of [403, 404]) {
      const { failure } = await check("sandbox", "deskohub-ws-sandbox", {
        prepare: (fake) => fake.intercept(respondWith(status)),
      });
      expect(failure).toMatchObject({ _tag: "StateBucketUnreadable", status });
    }
  });
});
