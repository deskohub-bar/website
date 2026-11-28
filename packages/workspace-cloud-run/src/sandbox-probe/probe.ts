// The disposable probe's routes and receipts for the hosted sandbox proof.
// The service role picks the mounted routes. Logs carry only the marker digest.
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { WorkspaceServiceRole } from "../service-role";
import { sha256Hex } from "../sha256.mjs";
import { ProbeRejected, SandboxProbeRpcs } from "./probe-rpcs";

export type ServiceRole = WorkspaceServiceRole;

/** Which service this probe instance plays and the build it reports. */
export class ProbeIdentity extends Context.Service<
  ProbeIdentity,
  { readonly role: ServiceRole; readonly version: string }
>()("sandbox-probe/ProbeIdentity") {
  static readonly Default = Layer.effect(ProbeIdentity)(
    Effect.gen(function* () {
      const role = yield* Config.schema(
        WorkspaceServiceRole,
        "WORKSPACE_SERVICE_ROLE"
      );
      const version = yield* Config.String("PROBE_BUILD_VERSION").pipe(
        Config.withDefault("dev")
      );
      return { role, version };
    })
  );
}

interface ProbeLogBase {
  readonly severity: "INFO";
  readonly probeVersion: string;
  readonly serviceRole: ServiceRole;
}

/** One structured stdout line; Cloud Logging indexes its fields. */
export type ProbeLogLine =
  | (ProbeLogBase & {
      readonly message: "sandbox probe listening";
      readonly event: "probe.listening";
      readonly address: string;
    })
  | (ProbeLogBase & {
      readonly message: "workspace probe ingest received";
      readonly event: "probe.ingest";
      readonly markerSha256: string;
    })
  | (ProbeLogBase & {
      readonly message: "workspace probe task received";
      readonly event: "probe.task";
      readonly queue: string;
      readonly markerSha256: string;
    })
  | (ProbeLogBase & {
      readonly message: "workspace probe schedule received";
      readonly event: "probe.schedule";
      readonly job: string;
    });

export class ProbeLog extends Context.Service<
  ProbeLog,
  { readonly write: (line: ProbeLogLine) => Effect.Effect<void> }
>()("sandbox-probe/ProbeLog") {
  static readonly Default = Layer.succeed(ProbeLog)({
    write: (line) => Console.log(JSON.stringify(line)),
  });
}

/** The probe's RPC handlers, also served in-memory by tests through `RpcTest`. */
export const probeHandlers = SandboxProbeRpcs.toLayer(
  Effect.gen(function* () {
    const identity = yield* ProbeIdentity;
    const log = yield* ProbeLog;
    return SandboxProbeRpcs.of({
      "Probe.ingest": ({ marker }) => {
        const digest = sha256Hex(marker);
        return log
          .write({
            severity: "INFO",
            message: "workspace probe ingest received",
            event: "probe.ingest",
            markerSha256: digest,
            probeVersion: identity.version,
            serviceRole: identity.role,
          })
          .pipe(Effect.as({ markerSha256: digest }));
      },
      "Probe.fail": () =>
        Effect.fail(
          new ProbeRejected({ reason: "the sandbox probe rejects Probe.fail" })
        ),
      // One value per chunk, so each reaches the client as its own RPC frame.
      "Probe.count": ({ n }) => Stream.range(0, n - 1, 1),
    });
  })
);

const QueueRequest = Schema.Struct({ queue: Schema.String });
const TaskBody = Schema.Struct({ marker: Schema.String });
const ScheduleRequest = Schema.Struct({ job: Schema.String });

const badRequest = () =>
  Effect.succeed(HttpServerResponse.empty({ status: 400 }));

const taskRoutes = Effect.gen(function* () {
  const identity = yield* ProbeIdentity;
  const log = yield* ProbeLog;
  return HttpRouter.add(
    "POST",
    "/api/queues/workspace/:queue",
    Effect.gen(function* () {
      const { queue } = yield* HttpRouter.schemaPathParams(QueueRequest);
      const { marker } = yield* HttpServerRequest.schemaBodyJson(TaskBody);
      yield* log.write({
        severity: "INFO",
        message: "workspace probe task received",
        event: "probe.task",
        queue,
        markerSha256: sha256Hex(marker),
        probeVersion: identity.version,
        serviceRole: identity.role,
      });
      return HttpServerResponse.empty();
    }).pipe(Effect.catch(badRequest))
  );
});

const scheduleRoutes = Effect.gen(function* () {
  const identity = yield* ProbeIdentity;
  const log = yield* ProbeLog;
  const schedule = Effect.gen(function* () {
    const { job } = yield* HttpRouter.schemaPathParams(ScheduleRequest);
    yield* log.write({
      severity: "INFO",
      message: "workspace probe schedule received",
      event: "probe.schedule",
      job,
      probeVersion: identity.version,
      serviceRole: identity.role,
    });
    return HttpServerResponse.empty();
  }).pipe(Effect.catch(badRequest));
  return Layer.mergeAll(
    HttpRouter.add("GET", "/api/cron/workspace/:job", schedule),
    HttpRouter.add("POST", "/api/cron/workspace/:job", schedule)
  );
});

const probeRoutesWith = <E, R>(apiRoutes: Layer.Layer<never, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const identity = yield* ProbeIdentity;
      const healthBody = HttpServerResponse.json({
        status: "ok",
        version: identity.version,
        role: identity.role,
      });
      // /healthz is the Cloud Run startup probe. Cloud Run reserves some paths
      // ending in "z" on the public run.app URL, so outside callers use /health.
      const health = Layer.mergeAll(
        HttpRouter.add("GET", "/healthz", healthBody),
        HttpRouter.add("GET", "/health", healthBody)
      );
      const roleRoutes = Match.value(identity.role).pipe(
        Match.when("api", () => apiRoutes),
        Match.when("tasks-worker", () => Layer.unwrap(taskRoutes)),
        Match.when("scheduler-worker", () => Layer.unwrap(scheduleRoutes)),
        Match.exhaustive
      );
      return Layer.mergeAll(health, roleRoutes);
    })
  );

const listening = Layer.effectDiscard(
  Effect.gen(function* () {
    const identity = yield* ProbeIdentity;
    const log = yield* ProbeLog;
    const server = yield* HttpServer.HttpServer;
    yield* log.write({
      severity: "INFO",
      message: "sandbox probe listening",
      event: "probe.listening",
      address: HttpServer.formatAddress(server.address),
      probeVersion: identity.version,
      serviceRole: identity.role,
    });
  })
);

/** The probe's HTTP app; provide an `HttpServer`, `ProbeIdentity` and `ProbeLog`. */
// Announced only once the routes serve, so a reader of the line can call them.
export const probeServerWith = <E, R>(apiRoutes: Layer.Layer<never, E, R>) =>
  listening.pipe(
    Layer.provide(
      HttpRouter.serve(probeRoutesWith(apiRoutes), {
        disableLogger: true,
        disableListenLog: true,
      })
    )
  );
