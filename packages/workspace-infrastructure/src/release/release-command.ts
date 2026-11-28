import type { Credentials, GcpEnvironment } from "@alchemy.run/gcp";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Stage } from "alchemy/Stage";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  configuredWorkspaceStack,
  ImageDigest,
  type WorkspaceStackConfig,
} from "../config/stack-config";
import { standaloneAlchemyAuth, workspaceGoogleApiAccess } from "../gcp-access";
import { verifyStackTarget } from "../stack-target";
import { alchemyServiceApply } from "./alchemy-service-apply";
import { cloudRunServiceReadbackLayer } from "./cloud-run-readback";
import {
  gcsReleaseRecordStoreLayer,
  releaseRecordLocation,
} from "./gcs-release-store";
import {
  deliverRelease,
  recoverRelease,
  restoreRelease,
  runStack,
} from "./release-delivery";
import { GitSha, ReleaseId } from "./release-record";
import { ReleaseRecordStore } from "./release-record-store";
import { describeStoredRecord, unlockReleaseWriter } from "./release-writer";

/** The verified stack every release command acts on. */
export class ReleaseStack extends Context.Service<
  ReleaseStack,
  WorkspaceStackConfig
>()("@deskohub/workspace-infrastructure/ReleaseStack") {}

/** What a release command prints: its delivery, recovery or record readout. */
type ReleaseCommandOutput =
  | Effect.Success<ReturnType<typeof deliverRelease>>
  | Effect.Success<ReturnType<typeof restoreRelease>>
  | Effect.Success<ReturnType<typeof recoverRelease>>
  | { readonly cleared: Effect.Success<ReturnType<typeof unlockReleaseWriter>> }
  | ReturnType<typeof describeStoredRecord>;

const printJson = (value: ReleaseCommandOutput) =>
  Console.log(JSON.stringify(value, null, 2));

const deliverCommand = Command.make(
  "deliver",
  {
    sha: Flag.String("sha").pipe(
      Flag.withDescription("Full commit SHA the image was built from")
    ),
    imageDigest: Flag.String("image-digest").pipe(
      Flag.withDescription("The image's sha256 digest in Artifact Registry")
    ),
  },
  Effect.fn("WorkspaceReleaseCommand.deliver")(function* ({
    sha,
    imageDigest,
  }) {
    const input = {
      sha: yield* Schema.decodeEffect(GitSha)(sha),
      imageDigest: yield* Schema.decodeEffect(ImageDigest)(imageDigest),
    };
    const config = yield* ReleaseStack;
    yield* printJson(yield* deliverRelease(config, input));
  })
).pipe(
  Command.withDescription(
    "Stage a digest-pinned build, verify its zero-traffic revision, promote and settle it"
  )
);

const restoreCommand = Command.make(
  "restore",
  {
    releaseId: Flag.String("release-id").pipe(
      Flag.withDescription("The previous or still-compatible release to serve")
    ),
    expectedGeneration: Flag.Int("expected-generation").pipe(
      Flag.withDescription(
        "The record generation `status` showed; a newer decision refuses the restore"
      )
    ),
  },
  Effect.fn("WorkspaceReleaseCommand.restore")(function* ({
    releaseId,
    expectedGeneration,
  }) {
    const input = {
      releaseId: yield* Schema.decodeEffect(ReleaseId)(releaseId),
      expectedGeneration,
    };
    const config = yield* ReleaseStack;
    yield* printJson(yield* restoreRelease(config, input));
  })
).pipe(
  Command.withDescription(
    "Move traffic back to an earlier verified release and settle it"
  )
);

const recoverCommand = Command.make(
  "recover",
  {},
  Effect.fn("WorkspaceReleaseCommand.recover")(function* () {
    const config = yield* ReleaseStack;
    yield* printJson(yield* recoverRelease(config));
  })
).pipe(
  Command.withDescription(
    "Re-apply and settle a traffic change an interrupted run left pending"
  )
);

const stackCommand = (action: "deploy" | "plan", description: string) =>
  Command.make(
    action,
    {},
    Effect.fn(`WorkspaceReleaseCommand.${action}`)(function* () {
      yield* runStack(yield* ReleaseStack, action);
    })
  ).pipe(Command.withDescription(description));

const unlockCommand = Command.make(
  "unlock",
  {
    holder: Flag.String("holder").pipe(
      Flag.withDescription(
        "The fingerprint `status` shows for the lock. Confirm first that its CI run or process has ended: a Cloud Run, Alchemy state or foundation resource write it already sent may still land after the unlock."
      )
    ),
  },
  Effect.fn("WorkspaceReleaseCommand.unlock")(function* ({ holder }) {
    const cleared = yield* unlockReleaseWriter(yield* ReleaseStack, holder);
    yield* printJson({ cleared });
  })
).pipe(
  Command.withDescription(
    "Break-glass: clear the writer lock of a run you confirmed has stopped. Writes that run already sent (Cloud Run services carry no etag; its Alchemy state and foundation resource writes are not fenced) can still land after the unlock, over a newer release decision. Hosted workflows must run each stage under a concurrency group that never cancels a run in progress."
  )
);

const statusCommand = Command.make(
  "status",
  {},
  Effect.fn("WorkspaceReleaseCommand.status")(function* () {
    const store = yield* ReleaseRecordStore;
    yield* printJson(describeStoredRecord(yield* store.read));
  })
).pipe(
  Command.withDescription(
    "Print the release record, its writer lock and its store version"
  )
);

export const releaseCommand = Command.make("workspace-release").pipe(
  Command.withDescription(
    "Operate Workspace releases and stack runs through the release record and its writer lock"
  ),
  Command.withSubcommands([
    deliverCommand,
    restoreCommand,
    recoverCommand,
    stackCommand(
      "deploy",
      "Apply the whole stack, such as an infrastructure change, as the stage's only writer"
    ),
    stackCommand("plan", "Preview the whole stack as the stage's only writer"),
    unlockCommand,
    statusCommand,
  ])
);

/** What the release runtime reads Google Cloud with. */
export type ReleaseCloudAccess =
  | Credentials
  | GcpEnvironment
  | HttpClient.HttpClient;

/**
 * The release runtime for one stack over the given Google Cloud access. It
 * refuses to start unless the effective GCP project and the state bucket's
 * region are the config's (`verifyStackTarget`), so one stage's
 * credentials never touch another stage's record, and a lock is never
 * taken, cleared or recovered while Cloud Run is read in another region.
 */
export const releaseRuntime = <E, R>(
  config: WorkspaceStackConfig,
  access: Layer.Layer<ReleaseCloudAccess, E, R>
) => {
  const verified = Layer.effectDiscard(
    verifyStackTarget(config).pipe(Effect.provideService(Stage, config.stage))
  );
  const platform = Layer.mergeAll(
    gcsReleaseRecordStoreLayer(releaseRecordLocation(config)),
    cloudRunServiceReadbackLayer(config)
  );
  return Layer.mergeAll(
    Layer.succeed(ReleaseStack, config),
    platform,
    alchemyServiceApply(config).pipe(Layer.provide(BunServices.layer))
  ).pipe(Layer.provideMerge(verified), Layer.provide(access));
};

/** The live release runtime for the configured stack. */
export const liveReleaseRuntime = Layer.unwrap(
  Effect.map(configuredWorkspaceStack, (config) =>
    releaseRuntime(config, workspaceGoogleApiAccess)
  )
).pipe(Layer.provide(standaloneAlchemyAuth));
