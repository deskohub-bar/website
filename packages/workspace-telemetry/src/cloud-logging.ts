import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  Cause,
  Context,
  Logger,
  type LogLevel,
  Option,
  Predicate,
  References,
  Result,
  Tracer,
} from "effect";
import {
  censorLoggerOptions,
  createCensoredOtelLogger,
  createWorkspaceOtelLoggerLive,
  WorkspaceLoggerLive,
} from "./censorship";
import type { workspaceLogFormatSchema } from "./telemetry-policy";

/**
 * Workspace log records as Cloud Logging structured JSON: one object per
 * stdout line, which the Cloud Run logging agent parses into a LogEntry.
 * The record carries the Workspace's identity and the active trace and span,
 * and every value passes through the shared censor first. Only the field
 * names are Google's; nothing here calls a Google SDK.
 * https://cloud.google.com/logging/docs/structured-logging
 */

/** Who emits a record, as labels every record repeats. */
export interface CloudLoggingIdentity {
  readonly deploymentStage?: string | undefined;
  readonly serviceRole: string;
  readonly revisionSha?: string | undefined;
  readonly deploymentId?: string | undefined;
}

/** Every Workspace sink shares censorship, including the optional OTLP sink. */
export const createWorkspaceLoggerLive = ({
  format,
  identity,
  loggerProvider,
}: {
  readonly format: typeof workspaceLogFormatSchema.Type | undefined;
  readonly identity: CloudLoggingIdentity;
  readonly loggerProvider: LoggerProvider | undefined;
}) => {
  if (format !== "cloud-logging-json") {
    return loggerProvider
      ? createWorkspaceOtelLoggerLive(loggerProvider)
      : WorkspaceLoggerLive;
  }
  const consoleLogger = makeCloudLoggingLogger(identity);
  return Logger.layer(
    loggerProvider
      ? [consoleLogger, createCensoredOtelLogger(loggerProvider)]
      : [consoleLogger]
  );
};

const cloudLoggingSeverity = (logLevel: LogLevel.LogLevel) => {
  switch (logLevel) {
    case "Fatal":
      return "CRITICAL";
    case "Error":
      return "ERROR";
    case "Warn":
      return "WARNING";
    case "Info":
      return "INFO";
    case "Debug":
    case "Trace":
      return "DEBUG";
    default:
      return "DEFAULT";
  }
};

interface CloudLoggingLabels {
  readonly environment: string | undefined;
  readonly service_role: string;
  readonly revision: string | undefined;
  readonly deployment_id: string | undefined;
}

type LogAnnotations = ReturnType<typeof logAnnotations>;

const logAnnotations = (options: Logger.Options<unknown>) =>
  options.fiber.getRef(References.CurrentLogAnnotations);

/**
 * One Cloud Logging record. JSON leaves out the fields that are undefined.
 * https://cloud.google.com/logging/docs/agent/logging/configuration#special-fields
 */
export interface CloudLoggingRecord {
  readonly severity: string;
  /** The stable name of what happened, for queries and alerts. */
  readonly event: string;
  readonly message: string;
  readonly time: string;
  readonly "logging.googleapis.com/labels": CloudLoggingLabels;
  readonly trace_id?: string | undefined;
  readonly span_id?: string | undefined;
  readonly annotations?: LogAnnotations | undefined;
  readonly details?: readonly unknown[] | undefined;
  readonly spans?: Readonly<Record<string, string>> | undefined;
  readonly cause?: string | undefined;
}

/**
 * The active trace and span as plain fields, which a record's PostHog trace
 * is found by; Cloud Trace holds no Workspace spans to link to.
 */
const traceFields = (options: Logger.Options<unknown>) => {
  const span = Context.getOption(options.fiber.context, Tracer.ParentSpan);
  if (Option.isNone(span)) return {};
  const { traceId, spanId } = span.value;
  return { trace_id: traceId, span_id: spanId };
};

const logSpanDurations = (options: Logger.Options<unknown>) => {
  const now = options.date.getTime();
  const spans = options.fiber.getRef(References.CurrentLogSpans);
  return spans.length === 0
    ? undefined
    : Object.fromEntries(
        spans.map(([label, startedAt]) => [label, `${now - startedAt}ms`])
      );
};

/**
 * The record's stable event name: the call's `event` annotation, such as
 * `runtime.shutdown.started`, or else its static message as a key, such as
 * `checkout_provider_slow` for "Checkout provider slow." and
 * `nexi_retry_attempt` for "Nexi retry attempt #2".
 */
/**
 * The message without the counts and numbers a caller wrote into it, such
 * as "Nexi retry attempt #2", so every record of one call shares a static
 * message; numbers belong in its structured fields.
 */
const staticMessage = (message: string) =>
  message
    .replace(/(^|\s)#?\d+(?:[.,:]\d+)*(?=[\s.,;:!?)]|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

const eventName = (annotations: LogAnnotations, message: string) => {
  const annotated = annotations.event;
  if (Predicate.isString(annotated) && annotated) return annotated;
  const key = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "log";
};

/**
 * The censored structured record of one log call. The message is the static
 * text of the call, without numbers written into it; values the call passes
 * beside it go under `details`.
 */
export const cloudLoggingRecord = (
  identity: CloudLoggingIdentity,
  rawOptions: Logger.Options<unknown>
): CloudLoggingRecord => {
  const options = censorLoggerOptions(rawOptions);
  const parts: readonly unknown[] = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const details = parts.filter((part) => !Predicate.isString(part));
  const annotations = logAnnotations(options);
  const message = staticMessage(parts.filter(Predicate.isString).join(" "));

  return {
    severity: cloudLoggingSeverity(options.logLevel),
    event: eventName(annotations, message),
    message,
    time: options.date.toISOString(),
    "logging.googleapis.com/labels": {
      environment: identity.deploymentStage,
      service_role: identity.serviceRole,
      revision: identity.revisionSha,
      deployment_id: identity.deploymentId,
    },
    ...traceFields(options),
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
    details: details.length > 0 ? details : undefined,
    spans: logSpanDurations(options),
    cause:
      options.cause.reasons.length === 0
        ? undefined
        : Cause.pretty(options.cause),
  };
};

/** The envelope of a record whose values JSON can't encode. */
const unserializableRecord = (record: CloudLoggingRecord) =>
  JSON.stringify({
    severity: record.severity,
    event: record.event,
    message: record.message,
    time: record.time,
    "logging.googleapis.com/labels": record["logging.googleapis.com/labels"],
    serialization: "failed",
  });

/** One JSON line per record. */
const formatCloudLoggingLine = (record: CloudLoggingRecord) =>
  Result.try(() => JSON.stringify(record)).pipe(
    Result.getOrElse(() => unserializableRecord(record))
  );

/** The censoring Cloud Logging logger, writing one JSON line to stdout. */
export const makeCloudLoggingLogger = (identity: CloudLoggingIdentity) =>
  Logger.withConsoleLog(
    Logger.make((options) =>
      formatCloudLoggingLine(cloudLoggingRecord(identity, options))
    )
  );
