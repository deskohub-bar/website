import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { WorkspaceContainerTelemetryLive } from "./index";

const tokenMarker = "synthetic-private-link-marker";
const authorizationMarker = "synthetic-private-header-marker";
const projectToken = "synthetic-project-token";
const spanName = "workspace.probe";

const runProbe = async (posthogPolicies: {
  readonly logs?: "always";
  readonly traces?: "always";
}) => {
  const received: {
    path: string;
    authorization: string | null;
    body: string;
  }[] = [];
  const posthog = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return new Response(null, { status: 200 });
    },
  });

  const environment = {
    K_REVISION: "test-cloud-run-revision",
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: projectToken,
    OTEL_EXPORTER_OTLP_ENDPOINT: posthog.url.origin,
    POSTHOG_INGEST_HOST: posthog.url.origin,
    POSTHOG_LOGS_EXPORT: posthogPolicies.logs,
    POSTHOG_TRACES_EXPORT: posthogPolicies.traces,
    VERCEL_DEPLOYMENT_ID: undefined,
    VERCEL_ENV: "production",
    WORKSPACE_DEPLOYMENT_ID: undefined,
    WORKSPACE_DEPLOYMENT_STAGE: "preview",
    WORKSPACE_LOG_FORMAT: undefined,
    WORKSPACE_LOG_LEVEL: undefined,
    WORKSPACE_REVISION_SHA: "test-source-revision",
    WORKSPACE_SERVICE_ROLE: "api",
  };
  const originalEnvironment = Object.entries(environment).map(
    ([name]) => [name, process.env[name]] as const
  );
  const consoleLog = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    const spanContext = await Effect.runPromise(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        yield* Effect.logDebug("Workspace probe").pipe(
          Effect.annotateLogs({ token: tokenMarker, role: "api" })
        );
        return { traceId: span.traceId, spanId: span.spanId };
      }).pipe(
        Effect.withSpan(spanName, {
          attributes: {
            "http.request.header.authorization": authorizationMarker,
            "url.full": `https://workspace.invalid/rpc?token=${tokenMarker}`,
            "http.request.method": "POST",
          },
        }),
        Effect.provide(WorkspaceContainerTelemetryLive)
      )
    );

    return {
      ...spanContext,
      received,
      consoleLines: consoleLog.mock.calls.map((args) => args.join(" ")),
    };
  } finally {
    consoleLog.mockRestore();
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    posthog.stop(true);
  }
};

test("drains censored logs and allowlisted traces to the direct PostHog paths", async () => {
  const { received, traceId, spanId, consoleLines } = await runProbe({
    logs: "always",
    traces: "always",
  });

  expect(consoleLines).toHaveLength(1);
  expect(consoleLines.join(" ")).not.toContain(tokenMarker);
  expect(consoleLines.join(" ")).not.toContain(authorizationMarker);
  expect(JSON.parse(consoleLines[0] ?? "")).toMatchObject({
    event: "workspace_probe",
    trace_id: traceId,
    span_id: spanId,
    annotations: { token: "[REDACTED]", role: "api" },
    "logging.googleapis.com/labels": {
      environment: "preview",
      service_role: "api",
      revision: "test-source-revision",
      deployment_id: "test-cloud-run-revision",
    },
  });
  expect(received.map(({ path }) => path).sort()).toEqual([
    "/i/v1/logs",
    "/i/v1/traces",
  ]);
  for (const { authorization, body } of received) {
    expect(authorization).toBe(`Bearer ${projectToken}`);
    expect(body).not.toContain(tokenMarker);
    expect(body).not.toContain(authorizationMarker);
  }

  const logBody = received.find(({ path }) => path === "/i/v1/logs")?.body;
  expect(logBody).toContain("Workspace probe");
  expect(logBody).toContain("[REDACTED]");
  expect(logBody).toContain(`"traceId":"${traceId}"`);
  expect(logBody).toContain(`"spanId":"${spanId}"`);

  const traceBody = received.find(({ path }) => path === "/i/v1/traces")?.body;
  expect(traceBody).toContain(spanName);
  expect(traceBody).toContain(traceId);
  expect(traceBody).toContain("http.request.method");
  expect(traceBody).not.toContain("http.request.header.authorization");
  expect(traceBody).not.toContain("url.full");
});

test("uses the container stage to gate preview exports independently", async () => {
  const defaultPolicy = await runProbe({});
  expect(defaultPolicy.received).toEqual([]);
  expect(defaultPolicy.consoleLines.join(" ")).toContain("Workspace probe");

  const logsOnly = await runProbe({ logs: "always" });
  expect(logsOnly.received.map(({ path }) => path)).toEqual(["/i/v1/logs"]);

  const tracesOnly = await runProbe({ traces: "always" });
  expect(tracesOnly.received.map(({ path }) => path)).toEqual(["/i/v1/traces"]);
});
