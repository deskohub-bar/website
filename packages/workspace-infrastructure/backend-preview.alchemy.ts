import { providers, state } from "@alchemy.run/gcp";
import { Service } from "@alchemy.run/gcp/Run/Service";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GcpProjectId,
  GcpRegion,
  GcsBucketName,
} from "./src/config/stack-config";
import { workspaceGoogleApiAccess } from "./src/gcp-access";
import {
  PreviewTarget,
  previewProject,
  previewRegion,
  previewRoles,
  previewServiceProps,
  previewStage,
  previewStateBucket,
} from "./src/preview/preview-services";
import { verifyStackTarget } from "./src/stack-target";

const verifyTarget = verifyStackTarget({
  stage: previewStage,
  projectId: Schema.decodeSync(GcpProjectId)(previewProject),
  region: Schema.decodeSync(GcpRegion)(previewRegion),
  stateBucket: Schema.decodeSync(GcsBucketName)(previewStateBucket),
}).pipe(Effect.provide(workspaceGoogleApiAccess), Effect.orDie);

export default Alchemy.Stack(
  "DeskohubWorkspaceBackendPreview",
  {
    providers: providers(),
    state: Layer.mergeAll(
      state({ bucketName: previewStateBucket }),
      Layer.effectDiscard(verifyTarget)
    ),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (stage !== previewStage) {
      return yield* Effect.die(
        "Backend preview requires its dedicated pilot stage"
      );
    }
    const target = yield* Config.option(
      Config.schema(
        Schema.fromJsonString(PreviewTarget),
        "WORKSPACE_PREVIEW_TARGET"
      )
    ).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);
    for (const role of previewRoles) {
      const service = previewServiceProps(role, target);
      yield* Service(service.serviceId, service);
    }
    return {};
  })
);
