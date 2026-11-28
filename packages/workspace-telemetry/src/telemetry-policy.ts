import { type LogLevel, Schema } from "effect";

/**
 * Which deployments export a Workspace signal, its logs or its traces, to
 * PostHog. "production-only", the default, keeps preview and development
 * telemetry out of PostHog: E2E runs against previews used to exhaust the
 * PostHog Logs quota. "always" opts a deployment in, for example through a
 * branch-scoped Vercel Preview variable while diagnosing that preview.
 */
export const postHogExportPolicySchema = Schema.Literals([
  "production-only",
  "always",
]);

export type PostHogExportPolicy = typeof postHogExportPolicySchema.Type;

/** Whether a deployment in `deploymentEnvironment` exports under `policy`. */
export const isPostHogExportEnabled = ({
  deploymentEnvironment,
  policy = "production-only",
}: {
  readonly deploymentEnvironment?: string | undefined;
  readonly policy?: PostHogExportPolicy | undefined;
}) => policy === "always" || deploymentEnvironment === "production";

/** Effect's log level names, as `WORKSPACE_LOG_LEVEL` accepts them. */
export const workspaceLogLevelSchema = Schema.Literals([
  "All",
  "Fatal",
  "Error",
  "Warn",
  "Info",
  "Debug",
  "Trace",
  "None",
] as const satisfies readonly LogLevel.LogLevel[]);

/**
 * The least severe level Workspace runs log: `logLevel` when set, else Info in
 * production and Debug everywhere else.
 */
export const workspaceMinimumLogLevel = ({
  deploymentEnvironment,
  logLevel,
}: {
  readonly deploymentEnvironment?: string | undefined;
  readonly logLevel?: LogLevel.LogLevel | undefined;
}): LogLevel.LogLevel =>
  logLevel ?? (deploymentEnvironment === "production" ? "Info" : "Debug");

/**
 * How Workspace server logs reach the console: logfmt lines, which Vercel's
 * log drains read, or Cloud Logging structured JSON on a container host.
 */
export const workspaceLogFormatSchema = Schema.Literals([
  "logfmt",
  "cloud-logging-json",
]);
