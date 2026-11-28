import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Cause, Config, Console, Effect, Layer, Schema } from "effect";

const ListenPort = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 65535 })
);

export const WorkspaceHttpServer = NodeHttpServer.layerConfig(createServer, {
  host: Config.succeed("0.0.0.0"),
  port: Config.schema(ListenPort, "PORT").pipe(Config.withDefault(8080)),
});

export const workspaceHttpRouterOptions = { disableLogger: true };

export const runWorkspaceServer = <A, E>(server: Layer.Layer<A, E, never>) =>
  NodeRuntime.runMain(
    Layer.launch(server).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Console.error("Workspace API startup failed")
      )
    ),
    { disableErrorReporting: true }
  );
