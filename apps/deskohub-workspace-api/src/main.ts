import "./temporal";
import {
  CallerContextLive,
  WorkspaceBackendLive,
  WorkspaceRpcHandlers,
} from "@deskohub/workspace-backend";
import { WorkspaceServiceRole } from "@deskohub/workspace-cloud-run/service-role";
import {
  EmailPreferencesRpcs,
  WorkspaceRpcSerialization,
} from "@deskohub/workspace-rpc";
import { WorkspaceContainerTelemetryLive } from "@deskohub/workspace-telemetry";
import { Config, Effect, Layer, Match } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcServer } from "effect/rpc";
import {
  runWorkspaceServer,
  WorkspaceHttpServer,
  workspaceHttpRouterOptions,
} from "./http-server";
import { workspaceRpcOptions } from "./rpc-options";

const apiRoutes = RpcServer.layerHttp({
  ...workspaceRpcOptions,
  group: EmailPreferencesRpcs,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspaceRpcHandlers,
      CallerContextLive,
      WorkspaceRpcSerialization
    )
  ),
  Layer.provide(WorkspaceBackendLive)
);

const health = HttpServerResponse.text("ok");
const routes = Layer.unwrap(
  Effect.gen(function* () {
    const role = yield* Config.schema(
      WorkspaceServiceRole,
      "WORKSPACE_SERVICE_ROLE"
    );
    const roleRoutes = Match.value(role).pipe(
      Match.when("api", () => apiRoutes),
      // The worker handlers move to Cloud Run in their own cutovers.
      Match.whenOr("tasks-worker", "scheduler-worker", () => Layer.empty),
      Match.exhaustive
    );
    return Layer.mergeAll(
      HttpRouter.add("GET", "/healthz", health),
      HttpRouter.add("GET", "/health", health),
      roleRoutes
    );
  })
);

runWorkspaceServer(
  HttpRouter.serve(routes, workspaceHttpRouterOptions).pipe(
    Layer.provide(
      Layer.merge(WorkspaceHttpServer, WorkspaceContainerTelemetryLive)
    )
  )
);
