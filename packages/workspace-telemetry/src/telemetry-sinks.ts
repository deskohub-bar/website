import { CloudinarySignatureRedactor } from "@deskohub/cloudinary/telemetry";
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import * as OtelResource from "@effect/opentelemetry/Resource";
import type { TracerProvider } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Data, Effect, Layer } from "effect";
import { createCensoredOtelSpanExporter } from "./censorship";
import {
  createAllowlistedSpanExporter,
  SpanAllowlistProcessor,
} from "./span-allowlist";
import {
  isPostHogExportEnabled,
  type PostHogExportPolicy,
} from "./telemetry-policy";

/**
 * Builders for the Workspace's telemetry sinks: its service identity, the
 * span redaction stack, the PostHog OTLP log and trace exports, the Effect
 * tracer, and the bounded log flush. They read no environment, so the E2E
 * runner, which has no Workspace configuration, builds its trace export
 * here too.
 */

const WORKSPACE_SERVICE_NAME = "deskohub-workspace";
const WORKSPACE_SERVICE_NAMESPACE = "deskohub";

/** Who emits the telemetry. The service defaults to the Workspace. */
export interface TelemetryIdentity {
  readonly deploymentEnvironment?: string;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly deploymentId?: string;
}

const identityResource = ({
  deploymentEnvironment,
  serviceName = WORKSPACE_SERVICE_NAME,
  serviceVersion,
  deploymentId,
}: TelemetryIdentity) =>
  resourceFromAttributes({
    "deployment.environment.name": deploymentEnvironment,
    "service.name": serviceName,
    "service.namespace": WORKSPACE_SERVICE_NAMESPACE,
    "service.version": serviceVersion,
    ...(deploymentId && { "deployment.id": deploymentId }),
  });

export interface WorkspaceOTelRegistrationOptions {
  /** The stage the process serves, such as production or preview. */
  readonly deploymentEnvironment?: string | undefined;
  /** The source commit the process serves. */
  readonly serviceVersion?: string | undefined;
  /** The host's rollout, such as a Cloud Run revision. */
  readonly deploymentId?: string | undefined;
  readonly posthogHost?: string | undefined;
  readonly posthogProjectToken?: string | undefined;
  /** Which deployments export their spans to PostHog. */
  readonly tracesExport?: PostHogExportPolicy | undefined;
  /**
   * Whether `registerOTel` may add its automatic exporters when the spans
   * don't go to PostHog, as on Vercel (the default). A container host turns
   * it off: there they would send spans unfiltered to any OTLP endpoint the
   * environment names, or to `localhost:4318`.
   */
  readonly automaticExport?: boolean | undefined;
}

/**
 * Whether a process with these options exports its spans to PostHog: it has
 * a project token and `tracesExport` includes its deployment.
 */
export const exportsPostHogTraces = ({
  deploymentEnvironment,
  posthogProjectToken,
  tracesExport,
}: Pick<
  WorkspaceOTelRegistrationOptions,
  "deploymentEnvironment" | "posthogProjectToken" | "tracesExport"
>) =>
  Boolean(posthogProjectToken) &&
  isPostHogExportEnabled({ deploymentEnvironment, policy: tracesExport });

const postHogSpanProcessor = (options: WorkspaceOTelRegistrationOptions) =>
  options.posthogProjectToken && exportsPostHogTraces(options)
    ? createPostHogSpanProcessor({
        deploymentEnvironment: options.deploymentEnvironment,
        posthogHost: options.posthogHost,
        posthogProjectToken: options.posthogProjectToken,
      })
    : undefined;

const directSpanProcessors = (exporter: SpanProcessor | undefined) => [
  ...createWorkspaceSpanRedactors(),
  new SpanAllowlistProcessor(),
  ...(exporter ? [exporter] : []),
];

/**
 * `registerOTel` options for the Workspace server.
 *
 * When the deployment exports its spans to PostHog, on Vercel and on a
 * container host alike, the span redactors and the span allowlist run ahead
 * of a single bounded batch export to PostHog's `/i/v1/traces`, which
 * applies the allowlist again, and no automatic exporter runs; the identity
 * adds the stage, the revision and the rollout.
 *
 * Otherwise, by default, as on Vercel, they are the Workspace identity and
 * the span redactors ahead of `registerOTel`'s automatic exporting
 * processors. Without automatic export, spans are recorded and filtered but
 * never exported.
 */
export const createWorkspaceOTelRegistration = ({
  deploymentEnvironment,
  serviceVersion,
  deploymentId,
  posthogHost,
  posthogProjectToken,
  tracesExport,
  automaticExport = true,
}: WorkspaceOTelRegistrationOptions = {}) => {
  const postHogExport = postHogSpanProcessor({
    deploymentEnvironment,
    posthogHost,
    posthogProjectToken,
    tracesExport,
  });
  if (!postHogExport && automaticExport) {
    return {
      serviceName: WORKSPACE_SERVICE_NAME,
      attributes: { "service.namespace": WORKSPACE_SERVICE_NAMESPACE },
      spanProcessors: [...createWorkspaceSpanRedactors(), "auto" as const],
    };
  }
  return {
    serviceName: WORKSPACE_SERVICE_NAME,
    attributes: {
      "service.namespace": WORKSPACE_SERVICE_NAMESPACE,
      ...(deploymentEnvironment && {
        "deployment.environment.name": deploymentEnvironment,
      }),
      ...(serviceVersion && { "service.version": serviceVersion }),
      ...(deploymentId && { "deployment.id": deploymentId }),
    },
    spanProcessors: directSpanProcessors(postHogExport),
  };
};

/** The container sends spans only when the direct PostHog policy enables it. */
export const createContainerTracerProvider = (
  options: WorkspaceOTelRegistrationOptions & TelemetryIdentity
) =>
  new BasicTracerProvider({
    resource: identityResource(options),
    spanProcessors: directSpanProcessors(postHogSpanProcessor(options)),
  });

/**
 * Span processors that scrub credentials, such as signed Cloudinary URL
 * signatures, from span names and attributes. Every tracer provider built
 * here lists them ahead of its exporting span processor, whichever
 * instrumentation records the span.
 */
const createWorkspaceSpanRedactors = (): SpanProcessor[] => [
  new CloudinarySignatureRedactor(),
];

const postHogEndpoint = (posthogHost: string, path: string) =>
  new URL(path, posthogHost).toString();

const postHogExportTimeoutMs = 2_000;

/**
 * A batch span processor whose flush also waits for the exports already in
 * flight. The SDK's flush exports the queued spans only, so it can resolve
 * while a batch its timer started is still sending, and a container that
 * idles or a function that freezes after the flush would lose that batch.
 */
class DrainingBatchSpanProcessor extends BatchSpanProcessor {
  readonly #exporter: SpanExporter;

  constructor(
    exporter: SpanExporter,
    config: ConstructorParameters<typeof BatchSpanProcessor>[1]
  ) {
    super(exporter, config);
    this.#exporter = exporter;
  }

  override async forceFlush(): Promise<void> {
    await super.forceFlush();
    await this.#exporter.forceFlush?.();
  }
}

/**
 * The batch export of the Workspace server's spans to PostHog's
 * `/i/v1/traces`, never its AI-only OTLP endpoint, which drops other spans.
 * Its exporter applies the span allowlist again, after every processor ran.
 * Its queue and batches are bounded, so an unreachable PostHog drops spans
 * instead of growing the process's memory.
 */
const createPostHogSpanProcessor = ({
  posthogHost,
  posthogProjectToken,
  deploymentEnvironment,
}: {
  readonly posthogHost: string | undefined;
  readonly posthogProjectToken: string;
  readonly deploymentEnvironment: string | undefined;
}): SpanProcessor => {
  if (!posthogHost) {
    throw new Error(
      "POSTHOG_INGEST_HOST is required when PostHog tracing is enabled"
    );
  }
  if (!deploymentEnvironment) {
    throw new Error(
      "The deployment stage (WORKSPACE_DEPLOYMENT_STAGE or VERCEL_ENV) is required when PostHog tracing is enabled"
    );
  }
  return new DrainingBatchSpanProcessor(
    createAllowlistedSpanExporter(
      new OTLPTraceExporter({
        headers: { Authorization: `Bearer ${posthogProjectToken}` },
        timeoutMillis: postHogExportTimeoutMs,
        url: postHogEndpoint(posthogHost, "/i/v1/traces"),
      })
    ),
    {
      exportTimeoutMillis: postHogExportTimeoutMs,
      maxExportBatchSize: 256,
      maxQueueSize: 2_048,
      scheduledDelayMillis: 1_000,
    }
  );
};

interface PostHogSinkOptions extends TelemetryIdentity {
  readonly posthogHost?: string;
  readonly posthogProjectToken?: string;
}

/**
 * The longest attribute value a Workspace log record exports; the SDK cuts
 * longer strings to this length. Annotations that carried whole inventory
 * record arrays made single PostHog log rows of 25 KB and more.
 */
const logAttributeValueLengthLimit = 4_096;

/**
 * The provider that batches log records into `exporter` under `identity`,
 * with attribute values bounded. Tests pass the SDK's in-memory exporter.
 */
export const createWorkspaceLoggerProvider = (
  exporter: LogRecordExporter,
  identity: TelemetryIdentity
) =>
  new LoggerProvider({
    resource: identityResource(identity),
    logRecordLimits: {
      attributeValueLengthLimit: logAttributeValueLengthLimit,
    },
    processors: [
      new BatchLogRecordProcessor({
        exporter,
        exportTimeoutMillis: postHogExportTimeoutMs,
      }),
    ],
  });

interface PostHogLogSinkOptions extends PostHogSinkOptions {
  readonly logsExport?: PostHogExportPolicy;
}

/**
 * The provider that exports log records to PostHog, or undefined without a
 * project token or when `logsExport` leaves the deployment's logs out.
 */
export function createPostHogLoggerProvider({
  logsExport,
  posthogHost,
  posthogProjectToken,
  ...identity
}: PostHogLogSinkOptions) {
  if (!posthogProjectToken) return undefined;
  if (
    !isPostHogExportEnabled({
      deploymentEnvironment: identity.deploymentEnvironment,
      policy: logsExport,
    })
  ) {
    return undefined;
  }
  if (!posthogHost) {
    throw new Error(
      "POSTHOG_INGEST_HOST is required when PostHog logging is enabled"
    );
  }
  if (!identity.deploymentEnvironment) {
    throw new Error(
      "The deployment stage (WORKSPACE_DEPLOYMENT_STAGE or VERCEL_ENV) is required when PostHog logging is enabled"
    );
  }

  return createWorkspaceLoggerProvider(
    new OTLPLogExporter({
      headers: {
        Authorization: `Bearer ${posthogProjectToken}`,
        "Content-Type": "application/json",
      },
      timeoutMillis: postHogExportTimeoutMs,
      url: postHogEndpoint(posthogHost, "/i/v1/logs"),
    }),
    identity
  );
}

/**
 * The provider that redacts and censors spans before it batches them into
 * `exporter` under `identity`. Tests pass the SDK's in-memory exporter.
 */
export const createWorkspaceTracerProvider = (
  exporter: SpanExporter,
  identity: TelemetryIdentity
) =>
  new BasicTracerProvider({
    resource: identityResource(identity),
    spanProcessors: [
      ...createWorkspaceSpanRedactors(),
      new BatchSpanProcessor(createCensoredOtelSpanExporter(exporter), {
        exportTimeoutMillis: postHogExportTimeoutMs,
      }),
    ],
  });

/**
 * The provider that exports redacted, censored spans to PostHog, or
 * undefined without a project token.
 */
export function createPostHogTracerProvider({
  posthogHost,
  posthogProjectToken,
  ...identity
}: PostHogSinkOptions) {
  if (!posthogProjectToken) return undefined;
  if (!posthogHost) {
    throw new Error(
      "POSTHOG_INGEST_HOST is required when PostHog tracing is enabled"
    );
  }

  return createWorkspaceTracerProvider(
    new OTLPTraceExporter({
      headers: { Authorization: `Bearer ${posthogProjectToken}` },
      timeoutMillis: postHogExportTimeoutMs,
      url: postHogEndpoint(posthogHost, "/i/v1/traces"),
    }),
    identity
  );
}

interface TracingLiveOptions {
  readonly attributes?: Record<string, boolean | number | string>;
  readonly provider?: TracerProvider;
  readonly serviceName: string;
  readonly serviceVersion?: string;
}

/**
 * The Effect tracer over `provider`, or over the global tracer provider that
 * `registerOTel` installs when there is none.
 */
export const createTracingLive = ({
  attributes,
  provider,
  serviceName,
  serviceVersion,
}: TracingLiveOptions) => {
  const providerLive = provider
    ? Layer.succeed(OtelTracer.OtelTracerProvider, provider)
    : OtelTracer.layerGlobalProvider;
  const resourceLive = OtelResource.layer({
    attributes,
    serviceName,
    serviceVersion,
  });

  return OtelTracer.layer.pipe(
    Layer.provide(Layer.merge(providerLive, resourceLive))
  );
};

/** The Effect tracer for `identity`, over `provider` or the global one. */
export const createIdentifiedTracingLive = (
  { deploymentEnvironment, serviceName, serviceVersion }: TelemetryIdentity,
  provider?: TracerProvider
) =>
  createTracingLive({
    attributes: {
      ...(deploymentEnvironment && {
        "deployment.environment.name": deploymentEnvironment,
      }),
      "service.namespace": WORKSPACE_SERVICE_NAMESPACE,
    },
    provider,
    serviceName: serviceName ?? WORKSPACE_SERVICE_NAME,
    serviceVersion,
  });

class LogFlushError extends Data.TaggedError("LogFlushError")<{
  readonly cause: unknown;
}> {}

/**
 * Exports the log records `provider` still buffers within the post-response
 * deadline. Never fails: a rejected or overdue flush is logged as a warning.
 */
export const flushLoggerProvider = (
  provider: Pick<LoggerProvider, "forceFlush"> | undefined,
  timeoutMs = postHogExportTimeoutMs
): Effect.Effect<void> =>
  provider
    ? Effect.tryPromise({
        try: () => provider.forceFlush({ timeoutMillis: timeoutMs }),
        catch: (cause) => new LogFlushError({ cause }),
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.catchTags({
          LogFlushError: ({ cause }) =>
            Effect.logWarning("PostHog log flush failed.", { cause }),
          TimeoutError: () =>
            Effect.logWarning(
              "PostHog log flush exceeded its post-response deadline."
            ),
        })
      )
    : Effect.void;
