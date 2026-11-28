import { createServer } from "node:http";
import {
  ProbeIdentity,
  ProbeLog,
  type ProbeLogLine,
  probeHandlers,
  probeServerWith,
  type ServiceRole,
} from "@deskohub/workspace-cloud-run/sandbox-probe";
import { SandboxProbeRpcs } from "@deskohub/workspace-cloud-run/sandbox-probe/rpcs";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import { FetchHttpClient, type HttpClient, HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import { RpcSerialization, RpcServer } from "effect/rpc";
import type * as Scope from "effect/Scope";

const probeServer = probeServerWith(
  RpcServer.layerHttp({
    group: SandboxProbeRpcs,
    path: "/rpc",
    protocol: "http",
    disableTracing: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(probeHandlers, RpcSerialization.layerSchemaBinary())
    )
  )
);

export const probeVersion = "v2";

/** A probe identity for `role` and a log that records every line it writes. */
export const probeTestContext = (role: ServiceRole, version = probeVersion) => {
  const lines: ProbeLogLine[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(ProbeIdentity)({ role, version }),
    Layer.succeed(ProbeLog)({
      write: (line) =>
        Effect.sync(() => {
          lines.push(line);
        }),
    })
  );
  return { lines, layer };
};

export interface RunningProbe {
  readonly origin: string;
  readonly lines: ReadonlyArray<ProbeLogLine>;
}

/** Serves the probe as `role` on a loopback port while `use` runs. */
export const runWithProbe = <A, E>(
  role: ServiceRole,
  use: (
    probe: RunningProbe
  ) => Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>,
  version = probeVersion
) => {
  const { lines, layer } = probeTestContext(role, version);
  return Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      return yield* use({
        origin: HttpServer.formatAddress(server.address),
        lines,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          probeServer.pipe(
            Layer.provide(layer),
            Layer.provideMerge(
              NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })
            )
          ),
          FetchHttpClient.layer
        )
      ),
      Effect.scoped
    )
  );
};
