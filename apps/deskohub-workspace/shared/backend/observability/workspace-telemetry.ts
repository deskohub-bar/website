import { ProxyTracerProvider, trace } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import { Data, Effect, Layer, Logger, Predicate, References } from "effect";
import { env } from "@/env";
import { resolveDeploymentIdentity } from "@/shared/deployment/deployment-identity";
import { defaultServiceRole } from "@/shared/deployment/runtime-host";
import {
  type CloudLoggingIdentity,
  createWorkspaceLoggerLive,
  makeCloudLoggingLogger,
} from "./cloud-logging";
import { workspaceMinimumLogLevel } from "./telemetry-policy";
import {
  createIdentifiedTracingLive,
  createPostHogLoggerProvider,
  createWorkspaceOTelRegistration,
  exportsPostHogTraces,
  flushLoggerProvider,
} from "./telemetry-sinks";
import { WorkspaceClockLive } from "./workspace-clock";

/** The build and rollout this process serves, whichever host runs it. */
const workspaceDeploymentIdentity = () => resolveDeploymentIdentity(env);

/** Where and for which deployments this process exports its spans. */
const workspaceTraceExport = () => ({
  deploymentEnvironment: env.VERCEL_ENV,
  posthogHost: env.POSTHOG_INGEST_HOST,
  posthogProjectToken: env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  tracesExport: env.POSTHOG_TRACES_EXPORT,
});

/**
 * `registerOTel` options for this process: the span allowlist and the
 * PostHog trace export when `POSTHOG_TRACES_EXPORT` includes the deployment,
 * on any host; otherwise Vercel's automatic exporters, or on a container
 * host no exporter.
 */
export const workspaceOTelRegistration = () => {
  const identity = workspaceDeploymentIdentity();
  return createWorkspaceOTelRegistration({
    ...workspaceTraceExport(),
    serviceVersion: identity.revisionSha,
    deploymentId: identity.deploymentId,
    automaticExport: env.WORKSPACE_RUNTIME_HOST !== "container",
  });
};

/** Who emits this process's structured log records. */
const workspaceCloudLoggingIdentity = (): CloudLoggingIdentity => {
  const identity = workspaceDeploymentIdentity();
  return {
    deploymentStage: env.VERCEL_ENV,
    serviceRole: env.WORKSPACE_SERVICE_ROLE ?? defaultServiceRole,
    revisionSha: identity.revisionSha,
    deploymentId: identity.deploymentId,
  };
};

/**
 * The process's Workspace telemetry, kept on `globalThis` under this key.
 * Next.js evaluates this module once for `instrumentation.ts` and again for
 * the app bundles, so a module-level provider would give each instance its
 * own buffer, and a flush in one would miss records the other holds. The
 * OTel logs API can't stand in: its global provider has no `forceFlush`.
 * Tests put a provider over the SDK's in-memory exporter here before the
 * first run.
 */
export const workspaceTelemetryHandle = Symbol.for(
  "@deskohub-workspace/telemetry"
);

export interface WorkspaceTelemetryHandle {
  /** Where Workspace logs go; undefined when PostHog logging is off. */
  readonly loggerProvider: LoggerProvider | undefined;
  /** The process's log drains, shared by every module instance. */
  logDrains?: LogDrains;
}

interface LogDrains {
  /** The drain exporting now. */
  running?: Promise<void>;
  /** The drain that starts when the running one ends, shared by every caller. */
  queued?: Promise<void>;
}

// Only this module writes the slot, so the annotation checks those writes;
// it trusts, rather than verifies, a value another module instance stored.
type GlobalWithTelemetry = typeof globalThis & {
  [workspaceTelemetryHandle]?: WorkspaceTelemetryHandle;
};

/**
 * The process's PostHog logger provider, built from the Workspace's
 * configuration by whichever module instance asks first. Undefined without a
 * PostHog project token, and outside production unless `POSTHOG_LOGS_EXPORT`
 * opts the deployment in. Throws when export is on without the PostHog host
 * or environment; the runtime then can't build its observability.
 */
export const workspaceLoggerProvider = () => {
  const processGlobals: GlobalWithTelemetry = globalThis;
  processGlobals[workspaceTelemetryHandle] ??= {
    loggerProvider: createPostHogLoggerProvider({
      deploymentEnvironment: env.VERCEL_ENV,
      logsExport: env.POSTHOG_LOGS_EXPORT,
      posthogHost: env.POSTHOG_INGEST_HOST,
      posthogProjectToken: env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
      serviceVersion: workspaceDeploymentIdentity().revisionSha,
    }),
  };
  return processGlobals[workspaceTelemetryHandle].loggerProvider;
};

/**
 * The Workspace's censoring console logger, its OTel logger when PostHog
 * logging is on, its tracer over the global tracer provider, and the minimum
 * log level of every run it serves (`workspaceMinimumLogLevel`). The process
 * logger provider is resolved when the Layer builds, not when this module
 * loads.
 */
export const WorkspaceObservabilityLive: Layer.Layer<never> = Layer.unwrap(
  Effect.sync(() => {
    const loggerProvider = workspaceLoggerProvider();
    return Layer.mergeAll(
      WorkspaceClockLive,
      createWorkspaceLoggerLive({
        format: env.WORKSPACE_LOG_FORMAT,
        identity: workspaceCloudLoggingIdentity(),
        loggerProvider,
      }),
      createIdentifiedTracingLive({
        serviceVersion: workspaceDeploymentIdentity().revisionSha,
      }),
      Layer.succeed(
        References.MinimumLogLevel,
        workspaceMinimumLogLevel({
          deploymentEnvironment: env.VERCEL_ENV,
          logLevel: env.WORKSPACE_LOG_LEVEL,
        })
      )
    );
  })
);

/**
 * Observability for standalone runs of a process that logs Cloud Logging
 * JSON: the censoring structured console logger, without the PostHog
 * export, and the tracer over the registered provider, so a record carries
 * the trace and span it was written in. Undefined for any other log format,
 * where standalone runs keep their logfmt logger.
 */
export const workspaceStandaloneObservabilityLive = ():
  | Layer.Layer<never>
  | undefined =>
  env.WORKSPACE_LOG_FORMAT === "cloud-logging-json"
    ? Layer.mergeAll(
        WorkspaceClockLive,
        Logger.layer([makeCloudLoggingLogger(workspaceCloudLoggingIdentity())]),
        createIdentifiedTracingLive({
          serviceVersion: workspaceDeploymentIdentity().revisionSha,
        })
      )
    : undefined;

/**
 * Exports what `loggerProvider` buffers when the drain starts. The SDK's
 * `forceFlush` returns at once while another is exporting, leaving records
 * logged since that one began in its buffer, behind a timer a frozen
 * invocation never fires. So a drain requested meanwhile waits for the
 * running one and then exports, and every request in that wait shares it.
 */
const drainLogs = (
  handle: WorkspaceTelemetryHandle,
  loggerProvider: Pick<LoggerProvider, "forceFlush">,
  options: Parameters<LoggerProvider["forceFlush"]>[0]
): Promise<void> => {
  handle.logDrains ??= {};
  const drains = handle.logDrains;
  if (drains.queued) return drains.queued;
  const start = () => {
    drains.queued = undefined;
    const running = loggerProvider.forceFlush(options).finally(() => {
      if (drains.running === running) drains.running = undefined;
    });
    drains.running = running;
    return running;
  };
  if (!drains.running) return start();
  drains.queued = drains.running.then(start, start);
  return drains.queued;
};

/**
 * Exports the Workspace logs the process buffers when the flush is
 * requested, within the post-response deadline. Never fails.
 */
export const flushWorkspaceLogs: Effect.Effect<void> = Effect.suspend(() => {
  const loggerProvider = workspaceLoggerProvider();
  const processGlobals: GlobalWithTelemetry = globalThis;
  const handle = processGlobals[workspaceTelemetryHandle];
  return flushLoggerProvider(
    loggerProvider &&
      handle && {
        forceFlush: (options) => drainLogs(handle, loggerProvider, options),
      }
  );
});

/**
 * Exports the spans the registered tracer provider still batches, for a
 * container's shutdown. Resolves at once when no SDK provider is registered.
 */
export const flushWorkspaceTraces = (): Promise<void> => {
  const registered = trace.getTracerProvider();
  const provider: object =
    registered instanceof ProxyTracerProvider
      ? registered.getDelegate()
      : registered;
  return Predicate.hasProperty(provider, "forceFlush") &&
    Predicate.isFunction(provider.forceFlush)
    ? Promise.resolve(provider.forceFlush()).then(() => undefined)
    : Promise.resolve();
};

/**
 * Whether this process exports its own spans, to PostHog. Otherwise
 * `registerOTel`'s automatic exporters, if any, send them and the Workspace
 * never flushes them.
 */
export const exportsWorkspaceTraces = () =>
  exportsPostHogTraces(workspaceTraceExport());

class TraceFlushError extends Data.TaggedError("TraceFlushError")<{
  readonly cause: unknown;
}> {}

/** The post-response deadline of the PostHog trace flush. */
const traceFlushTimeoutMs = 2_000;

/**
 * Exports the spans the process batches for PostHog within the
 * post-response deadline, so a container that idles or a function that
 * freezes after the response still sends them. A no-op when the process
 * doesn't export its spans. Never fails.
 */
export const flushWorkspaceTracesAfterResponse: Effect.Effect<void> =
  Effect.suspend(() =>
    exportsWorkspaceTraces()
      ? Effect.tryPromise({
          try: flushWorkspaceTraces,
          catch: (cause) => new TraceFlushError({ cause }),
        }).pipe(
          Effect.timeout(traceFlushTimeoutMs),
          Effect.catchTags({
            TraceFlushError: ({ cause }) =>
              Effect.logWarning("Workspace trace flush failed.", { cause }),
            TimeoutError: () =>
              Effect.logWarning(
                "Workspace trace flush exceeded its post-response deadline."
              ),
          })
        )
      : Effect.void
  );
