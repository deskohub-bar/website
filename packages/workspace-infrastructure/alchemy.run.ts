import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  configuredWorkspaceStack,
  type WorkspaceStackConfig,
} from "./src/config/stack-config";
import { workspaceGoogleApiAccess } from "./src/gcp-access";
import {
  releaseApplyGenerationVariable,
  releaseWriterVariable,
} from "./src/release/alchemy-service-apply";
import { cloudRunServiceReadbackLayer } from "./src/release/cloud-run-readback";
import {
  gcsReleaseRecordStoreLayer,
  releaseRecordLocation,
} from "./src/release/gcs-release-store";
import { requireStackWriter } from "./src/release/release-writer";
import { retiredEdgeProviders } from "./src/resources/retired-edge-providers";
import { verifyStackTarget } from "./src/stack-target";
import {
  declareRecordedWorkspaceServices,
  declareWorkspaceFoundation,
} from "./src/workspace-stack";

const stackConfig = configuredWorkspaceStack.pipe(Effect.orDie);

/** Set only by the fenced release apply (`alchemyServiceApply`). */
const releaseGeneration = Config.option(
  Config.Int(releaseApplyGenerationVariable)
).pipe(Effect.map(Option.getOrNull), Effect.orDie);

/** The writer lock's token, set by the release command for its own runs. */
const releaseWriter = Config.option(
  Config.Redacted(releaseWriterVariable)
).pipe(Effect.orDie);

/** The release record store and live readback of one stage. */
const releasePlatform = (config: WorkspaceStackConfig) =>
  Layer.mergeAll(
    gcsReleaseRecordStoreLayer(releaseRecordLocation(config)),
    cloudRunServiceReadbackLayer(config)
  ).pipe(Layer.provide(workspaceGoogleApiAccess));

/**
 * The Workspace stack. State lives in the config's own state bucket,
 * reached only after `verifyStackTarget`, so credentials or state of one
 * stage never apply another, and a config naming another region than the
 * state bucket's never plans or declares anything.
 *
 * The release-owned Cloud Run services come from the authoritative release
 * record in that bucket, never from a CI snapshot. A fenced release apply
 * sets `WORKSPACE_RELEASE_GENERATION` and the deploy refuses a record at any
 * other generation; a plain deploy re-declares the current record so the
 * services are kept.
 *
 * Every Alchemy command on a stage that serves releases (plan, deploy,
 * drift, destroy) builds this state layer, which refuses unless
 * `WORKSPACE_RELEASE_WRITER` holds the token of the lock the record holds:
 * only the release command's own runs touch the stack. Preview declares no
 * release-owned services and stays lock-free (#1455).
 *
 * The services are IAM-private: no load balancer, CDN or Cloud Armor sits
 * in front of them, and only granted identities reach their `run.app` URLs.
 */
export default Alchemy.Stack(
  "DeskohubWorkspace",
  {
    // Deletion-only providers for pre-rename edge rows so locked cleanup-only
    // destroys can drain a stack deployed before the edge removal.
    providers: retiredEdgeProviders.pipe(Layer.provideMerge(GCP.providers())),
    state: Layer.unwrap(
      stackConfig.pipe(
        Effect.map((config) =>
          Layer.mergeAll(
            GCP.state({ bucketName: config.stateBucket }),
            Layer.effectDiscard(
              verifyStackTarget(config).pipe(
                // The same resolution the GCS state store uses.
                Effect.provide(workspaceGoogleApiAccess),
                Effect.andThen(releaseWriter),
                Effect.flatMap((writer) =>
                  requireStackWriter(config, writer).pipe(
                    Effect.provide(releasePlatform(config))
                  )
                )
              )
            ).pipe(Layer.orDie)
          )
        )
      )
    ),
  },
  Effect.gen(function* () {
    const config = yield* stackConfig;
    const foundation = yield* declareWorkspaceFoundation(config);
    const services = yield* declareRecordedWorkspaceServices(config, {
      writer: yield* releaseWriter,
      generation: yield* releaseGeneration,
    }).pipe(
      Effect.provide(releasePlatform(config)),
      // A missing lock, stale fence, lost or unreadable record or unprotected
      // preview stops the deploy before any service is planned.
      Effect.orDie
    );
    return { ...foundation, services };
  })
);
