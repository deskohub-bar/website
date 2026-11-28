import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import type { registerOTel as registerVercelOTel } from "@vercel/otel";
import { Layer } from "effect";

// Nothing here reaches a real OpenTelemetry or PostHog endpoint: the OTel
// registration, the global logger provider and the Workspace telemetry are
// fakes.
const registerOTel = mock(
  (_options: Parameters<typeof registerVercelOTel>[0]) => undefined
);
const vercelOtel = await import("@vercel/otel");
mock.module("@vercel/otel", () => ({ ...vercelOtel, registerOTel }));

const setGlobalLoggerProvider = mock((_provider: LoggerProvider) => true);
const apiLogs = await import("@opentelemetry/api-logs");
mock.module("@opentelemetry/api-logs", () => ({
  ...apiLogs,
  logs: { setGlobalLoggerProvider },
}));

const syntheticRegistration = { serviceName: "synthetic-workspace" };
const syntheticLoggerProvider: LoggerProvider = {
  getLogger: () => ({ emit: () => undefined, enabled: () => false }),
};
let loggerProviderEnabled = false;
const workspaceOTelRegistration = mock(() => syntheticRegistration);
const workspaceLoggerProvider = mock(() =>
  loggerProviderEnabled ? syntheticLoggerProvider : undefined
);
const workspaceTelemetry = await import(
  "./shared/backend/observability/workspace-telemetry"
);
// The standalone observability a Cloud Logging log format gives; undefined
// for the default logfmt.
const syntheticStandaloneObservability = Layer.empty;
let cloudLoggingFormat = false;
const workspaceStandaloneObservabilityLive = mock(() =>
  cloudLoggingFormat ? syntheticStandaloneObservability : undefined
);
mock.module("./shared/backend/observability/workspace-telemetry", () => ({
  ...workspaceTelemetry,
  workspaceLoggerProvider,
  workspaceOTelRegistration,
  workspaceStandaloneObservabilityLive,
}));

const setStandaloneWorkspaceObservability = mock(
  (_layer: Layer.Layer<never>) => undefined
);
const standaloneRunner = await import(
  "./shared/backend/standalone-workspace-effect"
);
mock.module("./shared/backend/standalone-workspace-effect", () => ({
  ...standaloneRunner,
  setStandaloneWorkspaceObservability,
}));

const installRuntimeShutdown = mock(
  (_installation: { readonly run: unknown; readonly exit: unknown }) =>
    async () =>
      undefined
);
const onRuntimeShutdown = mock((_hook: { readonly name: string }) => undefined);
const runtimeLifecycle = await import("./shared/deployment/runtime-lifecycle");
mock.module("./shared/deployment/runtime-lifecycle", () => ({
  ...runtimeLifecycle,
  installRuntimeShutdown,
  onRuntimeShutdown,
}));

// The runtime host this test reads; everything else is the test environment.
let runtimeHost: string | undefined;
const workspaceEnv = await import("./env");
mock.module("./env", () => ({
  ...workspaceEnv,
  env: new Proxy(workspaceEnv.env, {
    get: (target, key) =>
      key === "WORKSPACE_RUNTIME_HOST" ? runtimeHost : Reflect.get(target, key),
  }),
}));
const { register } = await import("./instrumentation");

const originalRuntime = process.env.NEXT_RUNTIME;

beforeEach(() => {
  installRuntimeShutdown.mockClear();
  onRuntimeShutdown.mockClear();
  registerOTel.mockClear();
  setGlobalLoggerProvider.mockClear();
  setStandaloneWorkspaceObservability.mockClear();
  workspaceLoggerProvider.mockClear();
});

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
});

describe("register", () => {
  test("wires nothing outside the Node.js runtime", async () => {
    loggerProviderEnabled = true;
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(registerOTel).not.toHaveBeenCalled();
    expect(workspaceLoggerProvider).not.toHaveBeenCalled();
    expect(setGlobalLoggerProvider).not.toHaveBeenCalled();
  });

  test("registers the Workspace tracing", async () => {
    loggerProviderEnabled = false;
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(registerOTel).toHaveBeenCalledTimes(1);
    expect(registerOTel).toHaveBeenCalledWith(syntheticRegistration);
  });

  test("keeps the global logger provider without a Workspace logger provider", async () => {
    loggerProviderEnabled = false;
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(setGlobalLoggerProvider).not.toHaveBeenCalled();
  });

  test("sends logs through the Workspace logger provider when there is one", async () => {
    loggerProviderEnabled = true;
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(setGlobalLoggerProvider).toHaveBeenCalledTimes(1);
    expect(setGlobalLoggerProvider).toHaveBeenCalledWith(
      syntheticLoggerProvider
    );
  });

  test("gives standalone runs the Cloud Logging format on any host that asks for it", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    cloudLoggingFormat = true;

    try {
      await register();
    } finally {
      cloudLoggingFormat = false;
    }

    expect(setStandaloneWorkspaceObservability).toHaveBeenCalledWith(
      syntheticStandaloneObservability
    );
    expect(installRuntimeShutdown).not.toHaveBeenCalled();
  });

  test("keeps standalone runs on logfmt by default", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(setStandaloneWorkspaceObservability).not.toHaveBeenCalled();
  });

  test("leaves shutdown to Vercel on the default host", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(installRuntimeShutdown).not.toHaveBeenCalled();
    expect(onRuntimeShutdown).not.toHaveBeenCalled();
  });

  test("installs the drain-and-flush shutdown on a container host", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    runtimeHost = "container";

    try {
      await register();
    } finally {
      runtimeHost = undefined;
    }

    expect(installRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(onRuntimeShutdown.mock.calls.map(([hook]) => hook.name)).toEqual([
      "telemetry.logs",
      "telemetry.analytics",
      "telemetry.traces",
    ]);
  });
});
