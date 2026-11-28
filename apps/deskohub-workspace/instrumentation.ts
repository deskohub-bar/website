import "./shared/polyfills/temporal";

import { logs } from "@opentelemetry/api-logs";
import { registerOTel } from "@vercel/otel";
import { env } from "./env";
import {
  flushWorkspaceLogs,
  flushWorkspaceTraces,
  workspaceLoggerProvider,
  workspaceOTelRegistration,
  workspaceStandaloneObservabilityLive,
} from "./shared/backend/observability/workspace-telemetry";
import {
  runStandaloneWorkspaceEffect,
  setStandaloneWorkspaceObservability,
} from "./shared/backend/standalone-workspace-effect";
import {
  installRuntimeShutdown,
  onRuntimeShutdown,
} from "./shared/deployment/runtime-lifecycle";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  registerOTel(workspaceOTelRegistration());

  const loggerProvider = workspaceLoggerProvider();
  if (loggerProvider) logs.setGlobalLoggerProvider(loggerProvider);

  // Standalone runs log in the format WORKSPACE_LOG_FORMAT names, on any host.
  const standaloneObservability = workspaceStandaloneObservabilityLive();
  if (standaloneObservability) {
    setStandaloneWorkspaceObservability(standaloneObservability);
  }

  // A container keeps serving until SIGTERM; Vercel ends invocations itself.
  if (env.WORKSPACE_RUNTIME_HOST !== "container") return;
  // Loaded here, not at the top: only a container flushes analytics itself.
  const { flushServerAnalytics } = await import(
    "./shared/backend/analytics/analytics-event-delivery.service"
  );
  const runFlush = runStandaloneWorkspaceEffect("runtime.telemetry-flush");
  onRuntimeShutdown({
    name: "telemetry.logs",
    stage: "flush",
    run: () => runFlush(flushWorkspaceLogs),
  });
  onRuntimeShutdown({
    name: "telemetry.analytics",
    stage: "flush",
    run: () => runFlush(flushServerAnalytics),
  });
  onRuntimeShutdown({
    name: "telemetry.traces",
    stage: "flush",
    run: flushWorkspaceTraces,
  });
  installRuntimeShutdown({
    run: runStandaloneWorkspaceEffect("runtime.shutdown"),
    exit: (code) => process.exit(code),
  });
}
