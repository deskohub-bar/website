import "./temporal";
import {
  CallerContextLive,
  WorkspaceBackendLive,
  WorkspaceRpcHandlers,
} from "@deskohub/workspace-backend";
import {
  WorkspaceSandboxFixture,
  WorkspaceSandboxFixtureLive,
} from "@deskohub/workspace-backend/sandbox";
import {
  ProbeIdentity,
  ProbeLog,
  probeHandlers,
  probeServerWith,
} from "@deskohub/workspace-cloud-run/sandbox-probe";
import { SandboxEmailPreferencesRpcs } from "@deskohub/workspace-cloud-run/sandbox-probe/email-preferences";
import {
  ProbeRejected,
  SandboxProbeRpcs,
} from "@deskohub/workspace-cloud-run/sandbox-probe/rpcs";
import {
  EmailPreferencesRpcs,
  WorkspaceRpcSerialization,
} from "@deskohub/workspace-rpc";
import { WorkspaceContainerTelemetryLive } from "@deskohub/workspace-telemetry";
import { Config, Effect, Layer, Schema } from "effect";
import { RpcServer } from "effect/rpc";
import { runWorkspaceServer, WorkspaceHttpServer } from "./http-server";
import { workspaceRpcOptions } from "./rpc-options";

const fixtureHandlers = SandboxEmailPreferencesRpcs.toLayer(
  Effect.gen(function* () {
    const fixture = yield* WorkspaceSandboxFixture;
    return SandboxEmailPreferencesRpcs.of({
      "Probe.issueUnsubscribeToken": () =>
        fixture
          .issue()
          .pipe(
            Effect.catchDefect(() =>
              Effect.fail(
                new ProbeRejected({ reason: "fixture issuance failed" })
              )
            )
          ),
    });
  })
).pipe(Layer.provide(WorkspaceSandboxFixtureLive));

const rpcRoutes = RpcServer.layerHttp({
  ...workspaceRpcOptions,
  group: EmailPreferencesRpcs.merge(
    SandboxProbeRpcs,
    SandboxEmailPreferencesRpcs
  ),
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspaceRpcHandlers,
      CallerContextLive,
      WorkspaceRpcSerialization,
      probeHandlers,
      fixtureHandlers
    )
  ),
  Layer.provide(WorkspaceBackendLive)
);

const sandbox = Layer.unwrap(
  Effect.gen(function* () {
    yield* Config.schema(
      Schema.Literal("sandbox"),
      "WORKSPACE_DEPLOYMENT_STAGE"
    );
    return probeServerWith(rpcRoutes);
  })
);

runWorkspaceServer(
  sandbox.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceHttpServer,
        ProbeIdentity.Default,
        ProbeLog.Default,
        WorkspaceContainerTelemetryLive
      )
    )
  )
);
