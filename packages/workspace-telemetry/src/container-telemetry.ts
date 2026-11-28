import { Effect, Fiber, Layer, References, Schema } from "effect";
import { createWorkspaceLoggerLive } from "./cloud-logging";
import { resolveDeploymentIdentity } from "./deployment-identity";
import {
  postHogExportPolicySchema,
  workspaceLogFormatSchema,
  workspaceLogLevelSchema,
  workspaceMinimumLogLevel,
} from "./telemetry-policy";
import {
  createContainerTracerProvider,
  createIdentifiedTracingLive,
  createPostHogLoggerProvider,
} from "./telemetry-sinks";

const containerSettings = Schema.Struct({
  POSTHOG_LOGS_EXPORT: Schema.optional(postHogExportPolicySchema),
  POSTHOG_TRACES_EXPORT: Schema.optional(postHogExportPolicySchema),
  WORKSPACE_LOG_FORMAT: Schema.optional(workspaceLogFormatSchema),
  WORKSPACE_LOG_LEVEL: Schema.optional(workspaceLogLevelSchema),
});

const readContainerSettings = () => {
  const environment = process.env;
  const settings = {
    POSTHOG_LOGS_EXPORT: environment.POSTHOG_LOGS_EXPORT || undefined,
    POSTHOG_TRACES_EXPORT: environment.POSTHOG_TRACES_EXPORT || undefined,
    WORKSPACE_LOG_FORMAT: environment.WORKSPACE_LOG_FORMAT || undefined,
    WORKSPACE_LOG_LEVEL: environment.WORKSPACE_LOG_LEVEL || undefined,
  };
  if (!Schema.is(containerSettings)(settings)) {
    throw new Error("Invalid Workspace telemetry settings");
  }
  return { environment, settings };
};

/** Scope the container's SDK providers to its runtime so shutdown drains them. */
export const WorkspaceContainerTelemetryLive: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const { environment, settings } = yield* Effect.sync(readContainerSettings);
    const deploymentStage =
      environment.WORKSPACE_DEPLOYMENT_STAGE || environment.VERCEL_ENV;
    const { revisionSha, deploymentId } = resolveDeploymentIdentity({
      WORKSPACE_REVISION_SHA: environment.WORKSPACE_REVISION_SHA,
      WORKSPACE_DEPLOYMENT_ID: environment.WORKSPACE_DEPLOYMENT_ID,
      VERCEL_GIT_COMMIT_SHA: environment.VERCEL_GIT_COMMIT_SHA,
      VERCEL_DEPLOYMENT_ID: environment.VERCEL_DEPLOYMENT_ID,
      K_REVISION: environment.K_REVISION,
    });
    const sinkOptions = {
      deploymentEnvironment: deploymentStage,
      serviceVersion: revisionSha,
      deploymentId,
      posthogHost: environment.POSTHOG_INGEST_HOST,
      posthogProjectToken: environment.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    };
    const loggerSettings = {
      format: settings.WORKSPACE_LOG_FORMAT ?? "cloud-logging-json",
      identity: {
        deploymentStage,
        serviceRole: environment.WORKSPACE_SERVICE_ROLE || "api",
        revisionSha,
        deploymentId,
      },
    } as const;
    const consoleLogger = createWorkspaceLoggerLive({
      ...loggerSettings,
      loggerProvider: undefined,
    });
    let loggerProvider: ReturnType<typeof createPostHogLoggerProvider>;
    let tracerProvider:
      | ReturnType<typeof createContainerTracerProvider>
      | undefined;
    yield* Effect.addFinalizer(() =>
      drainProviders(loggerProvider, tracerProvider).pipe(
        Effect.provide(consoleLogger)
      )
    );

    loggerProvider = createPostHogLoggerProvider({
      ...sinkOptions,
      logsExport: settings.POSTHOG_LOGS_EXPORT,
    });
    tracerProvider = createContainerTracerProvider({
      ...sinkOptions,
      tracesExport: settings.POSTHOG_TRACES_EXPORT,
    });

    return Layer.mergeAll(
      loggerProvider
        ? createWorkspaceLoggerLive({ ...loggerSettings, loggerProvider })
        : consoleLogger,
      createIdentifiedTracingLive(sinkOptions, tracerProvider),
      Layer.succeed(
        References.MinimumLogLevel,
        workspaceMinimumLogLevel({
          deploymentEnvironment: deploymentStage,
          logLevel: settings.WORKSPACE_LOG_LEVEL,
        })
      )
    );
  })
);

interface TelemetryProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const drainProvider = (
  provider: TelemetryProvider | undefined,
  signal: "log" | "trace"
) =>
  provider
    ? Effect.tryPromise(() =>
        provider.forceFlush().finally(() => provider.shutdown())
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning(`Workspace ${signal} drain failed.`)
        )
      )
    : Effect.void;

/** Leave time for the container's other shutdown work when OTLP is stalled. */
const drainProviders = (
  logger: TelemetryProvider | undefined,
  tracer: TelemetryProvider | undefined
) =>
  Effect.all([drainProvider(logger, "log"), drainProvider(tracer, "trace")], {
    concurrency: "unbounded",
    discard: true,
  }).pipe(
    Effect.timeoutOrElse({
      duration: "4 seconds",
      orElse: () => Effect.logWarning("Workspace telemetry drain timed out."),
    }),
    // The scope is closing uninterruptibly. Run the deadline in a fresh fiber.
    Effect.interruptible,
    Effect.forkDetach,
    Effect.flatMap(Fiber.join)
  );
