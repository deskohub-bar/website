import { describe, expect, test } from "bun:test";
import {
  type ProbeLogLine,
  probeHandlers,
  type ServiceRole,
} from "@deskohub/workspace-cloud-run/sandbox-probe";
import {
  ProbeRejected,
  SandboxProbeRpcs,
} from "@deskohub/workspace-cloud-run/sandbox-probe/rpcs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization, RpcTest } from "effect/rpc";
import * as Stream from "effect/Stream";
import {
  probeTestContext,
  probeVersion,
  runWithProbe,
} from "./probe-server.test-utils";

const marker = "synthetic-probe-marker-7c1d";
const digest = new Bun.CryptoHasher("sha256").update(marker).digest("hex");
const schemaBinary = "application/vnd.effect.rpc+schema-binary";
const roles: ReadonlyArray<ServiceRole> = [
  "api",
  "tasks-worker",
  "scheduler-worker",
];

const memoryClient = RpcTest.makeClient(SandboxProbeRpcs);

const runInMemory = <A, E>(
  use: (client: Effect.Success<typeof memoryClient>) => Effect.Effect<A, E>
) => {
  const { lines, layer } = probeTestContext("api");
  return Effect.runPromise(
    memoryClient.pipe(
      Effect.flatMap(use),
      Effect.map((value) => ({ value, lines })),
      Effect.scoped,
      Effect.provide(probeHandlers.pipe(Layer.provide(layer)))
    )
  );
};

/** An RPC client over POST /rpc with SchemaBinary that records response content types. */
const httpClient = (origin: string, contentTypes: string[]) =>
  RpcClient.make(SandboxProbeRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({
        url: `${origin}/rpc`,
        transformClient: HttpClient.tap((response) =>
          Effect.sync(() => {
            contentTypes.push(response.headers["content-type"] ?? "");
          })
        ),
      }).pipe(Layer.provide(RpcSerialization.layerSchemaBinary()))
    )
  );

const send = (url: string, init?: RequestInit) =>
  Effect.promise(() => fetch(url, init));

const statusOf = (url: string, init?: RequestInit) =>
  send(url, init).pipe(Effect.map((response) => response.status));

const postJson = (url: string, body: Readonly<Record<string, string>>) =>
  statusOf(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("sandbox probe RPCs in memory", () => {
  test("Probe.ingest returns the marker's SHA-256 and logs only the digest", async () => {
    const { value, lines } = await runInMemory((client) =>
      client["Probe.ingest"]({ marker })
    );
    expect(value).toEqual({ markerSha256: digest });
    expect(lines).toEqual([
      {
        severity: "INFO",
        message: "workspace probe ingest received",
        event: "probe.ingest",
        markerSha256: digest,
        probeVersion,
        serviceRole: "api",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(marker);
  });

  test("Probe.fail fails with the typed ProbeRejected error", async () => {
    const { value } = await runInMemory((client) =>
      Effect.flip(client["Probe.fail"]({}))
    );
    expect(value).toBeInstanceOf(ProbeRejected);
  });

  test("Probe.count streams 0 to n - 1", async () => {
    const { value } = await runInMemory((client) =>
      Effect.all([
        Stream.runCollect(client["Probe.count"]({ n: 3 })),
        Stream.runCollect(client["Probe.count"]({ n: 0 })),
        Stream.runCollect(client["Probe.count"]({ n: 100 })),
      ])
    );
    expect(value).toEqual([
      [0, 1, 2],
      [],
      Array.from({ length: 100 }, (_, index) => index),
    ]);
  });

  test.each([-1, 101, 1.5])("Probe.count rejects n = %p", async (n) => {
    const { value } = await runInMemory((client) =>
      Effect.exit(
        Effect.suspend(() => Stream.runCollect(client["Probe.count"]({ n })))
      )
    );
    expect(Exit.isFailure(value)).toBe(true);
  });
});

describe("sandbox probe over HTTP", () => {
  test.each(roles)(
    "%s reports its version and role on /healthz and /health",
    async (role) => {
      const health = await runWithProbe(role, ({ origin }) =>
        Effect.forEach(["/healthz", "/health"], (path) =>
          send(`${origin}${path}`).pipe(
            Effect.flatMap((response) =>
              Effect.promise(() => response.json()).pipe(
                Effect.map((body) => ({ status: response.status, body }))
              )
            )
          )
        )
      );
      const reported = {
        status: 200,
        body: { status: "ok", version: probeVersion, role },
      };
      expect(health).toEqual([reported, reported]);
    }
  );

  test("api serves the RPCs over POST /rpc with SchemaBinary", () =>
    runWithProbe("api", ({ origin, lines }) =>
      Effect.gen(function* () {
        const contentTypes: string[] = [];
        const client = yield* httpClient(origin, contentTypes);
        const ingested = yield* client["Probe.ingest"]({ marker });
        const rejected = yield* Effect.flip(client["Probe.fail"]({}));
        const chunks = yield* Stream.runCollect(
          client["Probe.count"]({ n: 3 })
        );
        expect(ingested).toEqual({ markerSha256: digest });
        expect(rejected).toBeInstanceOf(ProbeRejected);
        expect(chunks).toEqual([0, 1, 2]);
        expect(contentTypes).toEqual([
          schemaBinary,
          schemaBinary,
          schemaBinary,
        ]);
        expect(lines.map((line) => line.event)).toEqual([
          "probe.listening",
          "probe.ingest",
        ]);
        expect(JSON.stringify(lines)).not.toContain(marker);
      })
    ));

  test("api mounts no worker routes", () =>
    runWithProbe("api", ({ origin }) =>
      Effect.all([
        postJson(`${origin}/api/queues/workspace/reservations`, { marker }),
        statusOf(`${origin}/api/cron/workspace/proof-tick`),
        statusOf(`${origin}/elsewhere`),
      ]).pipe(
        Effect.map((statuses) => expect(statuses).toEqual([404, 404, 404]))
      )
    ));

  test("tasks-worker accepts queue deliveries and logs only the marker digest", () =>
    runWithProbe("tasks-worker", ({ origin, lines }) =>
      Effect.gen(function* () {
        const statuses = yield* Effect.all([
          postJson(`${origin}/api/queues/workspace/reservations`, { marker }),
          postJson(`${origin}/api/queues/workspace/reservations`, {}),
          statusOf(`${origin}/rpc`, { method: "POST" }),
          statusOf(`${origin}/api/cron/workspace/proof-tick`),
        ]);
        expect(statuses).toEqual([204, 400, 404, 404]);
        expect(lines.slice(1)).toEqual([
          {
            severity: "INFO",
            message: "workspace probe task received",
            event: "probe.task",
            queue: "reservations",
            markerSha256: digest,
            probeVersion,
            serviceRole: "tasks-worker",
          },
        ]);
        expect(JSON.stringify(lines)).not.toContain(marker);
      })
    ));

  test("scheduler-worker accepts GET and POST schedule runs", () =>
    runWithProbe("scheduler-worker", ({ origin, lines }) =>
      Effect.gen(function* () {
        const statuses = yield* Effect.all([
          statusOf(`${origin}/api/cron/workspace/proof-tick`),
          statusOf(`${origin}/api/cron/workspace/proof-tick`, {
            method: "POST",
          }),
          statusOf(`${origin}/rpc`, { method: "POST" }),
          postJson(`${origin}/api/queues/workspace/reservations`, { marker }),
        ]);
        expect(statuses).toEqual([204, 204, 404, 404]);
        const scheduled: ProbeLogLine = {
          severity: "INFO",
          message: "workspace probe schedule received",
          event: "probe.schedule",
          job: "proof-tick",
          probeVersion,
          serviceRole: "scheduler-worker",
        };
        expect(lines.slice(1)).toEqual([scheduled, scheduled]);
      })
    ));
});
