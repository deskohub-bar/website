import { GcpEnvironment } from "@alchemy.run/gcp";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";
import type { WorkspaceStackConfig } from "./config/stack-config";
import {
  type GoogleApiNoAnswer,
  type GoogleApiRetryPolicy,
  makeGoogleApi,
} from "./google-api";

/** The Alchemy stage or effective project is not the configured one. */
export class StackTargetMismatch extends Data.TaggedError(
  "StackTargetMismatch"
)<{
  readonly configuredStage: string;
  readonly stage: string;
  readonly projectMatches: boolean;
}> {}

/**
 * The config's region is not the stage's region. The state bucket's
 * location fixes it; a dual- or multi-region bucket fixes none, so every
 * region mismatches it.
 */
export class StageRegionMismatch extends Data.TaggedError(
  "StageRegionMismatch"
)<{
  readonly configuredRegion: string;
  readonly stateBucketLocation: string;
}> {}

/** The state bucket's location could not be read, so no region is known. */
export class StateBucketUnreadable extends Data.TaggedError(
  "StateBucketUnreadable"
)<{
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly reason: string;
}> {}

type StackTarget = Pick<
  WorkspaceStackConfig,
  "stage" | "projectId" | "region" | "stateBucket"
>;

/**
 * Refuse to touch state unless the Alchemy stage, the effective GCP
 * project (credentials, profile or environment, as the provider resolves
 * it) and the region all name the config's stage, project and region. It
 * runs while the state layer builds and before the release command's
 * record store and readback exist, so plan, deploy, drift, destroy and
 * every release command (lock acquire, unlock, recover included) pass
 * through it.
 *
 * The region is checked against the state bucket's location. The writer
 * lock and the release record live in that bucket, keyed by stage, while
 * every Cloud Run read and write names the config's region. A config with
 * another region would take the same lock but read and declare services
 * where none of the stage's run: an unlock would see no rollout while a
 * worker still reconciles, and the lost-record guard would miss live
 * services. The bucket's location outlives the release record, so one
 * region stays bound to the project and its stages.
 *
 * The bucket must stay in its stages' services' region for as long as they
 * run. Cloud Storage can relocate an eligible bucket in place; relocate or
 * recreate it only together with migrating or retiring the workloads.
 * Never clear a `StageRegionMismatch` by changing the config's region to
 * the bucket's unless the stage's services actually run there.
 */
export const verifyStackTarget = Effect.fn("WorkspaceStack.verifyStackTarget")(
  function* (config: StackTarget) {
    const stage = yield* Stage;
    const { project } = yield* GcpEnvironment.current;
    if (stage !== config.stage || project !== config.projectId) {
      return yield* new StackTargetMismatch({
        configuredStage: config.stage,
        stage,
        projectMatches: project === config.projectId,
      });
    }
    const location = yield* readStateBucketLocation(config);
    const stateBucketLocation =
      location.locationType === "region"
        ? location.location.toLowerCase()
        : `${location.locationType} ${location.location}`;
    if (stateBucketLocation !== config.region) {
      return yield* new StageRegionMismatch({
        configuredRegion: config.region,
        stateBucketLocation,
      });
    }
  }
);

const cloudStorageApi = "https://storage.googleapis.com";

/** A read on the operator's or CI's path: generous, like the record store. */
const bucketReadPolicy = {
  attemptTimeout: "30 seconds",
  backoff: "200 millis",
  retries: 4,
} as const satisfies GoogleApiRetryPolicy;

const BucketLocationJson = Schema.fromJsonString(
  Schema.Struct({ location: Schema.String, locationType: Schema.String })
);
const decodeBucketLocation = Schema.decodeUnknownEffect(BucketLocationJson);

const noAnswerReasons = {
  unreachable: "Cloud Storage could not be reached",
  "no-answer-in-time": "Cloud Storage did not answer in time",
  "credentials-stalled": "Google Cloud credentials did not resolve in time",
} satisfies Record<GoogleApiNoAnswer, string>;

const readStateBucketLocation = Effect.fnUntraced(function* (
  config: StackTarget
) {
  const googleApi = yield* makeGoogleApi();
  const request = HttpClientRequest.get(
    `${cloudStorageApi}/storage/v1/b/${encodeURIComponent(config.stateBucket)}`
  ).pipe(HttpClientRequest.setUrlParam("fields", "location,locationType"));
  return yield* googleApi.call({
    request,
    policy: bucketReadPolicy,
    handle: (response: HttpClientResponse.HttpClientResponse) =>
      response.status === 200
        ? response.text.pipe(
            Effect.flatMap(decodeBucketLocation),
            // The decode issue may quote the body; keep the reason fixed.
            Effect.mapError(
              () =>
                new StateBucketUnreadable({
                  status: 200,
                  reason: "Cloud Storage served unreadable bucket metadata",
                })
            )
          )
        : Effect.fail(
            new StateBucketUnreadable({
              status: response.status,
              reason:
                response.status === 404
                  ? "the state bucket does not exist"
                  : `Cloud Storage refused the bucket read (${response.status})`,
            })
          ),
    transientStatus: (status) =>
      new StateBucketUnreadable({
        status,
        reason: `Cloud Storage answered ${status}`,
      }),
    noAnswer: (cause) =>
      new StateBucketUnreadable({
        status: null,
        reason: noAnswerReasons[cause],
      }),
    credentialsUnavailable: () =>
      new StateBucketUnreadable({
        status: null,
        reason: "Google Cloud credentials are unavailable",
      }),
  });
});
