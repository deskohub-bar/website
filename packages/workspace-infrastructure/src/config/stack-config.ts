import { WorkspaceServiceRole } from "@deskohub/workspace-cloud-run/service-role";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/** The default region for every Workspace stack (#1452). */
export const defaultWorkspaceRegion = "europe-west1";

export const WorkspaceStage = Schema.Literals([
  "sandbox",
  "preview",
  "production",
]).annotate({
  identifier: "WorkspaceStage",
  description: "The isolated Google Cloud environment a stack deploys to.",
});
export type WorkspaceStage = typeof WorkspaceStage.Type;

export const GcpProjectId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
).pipe(
  Schema.brand("GcpProjectId"),
  Schema.annotate({
    identifier: "GcpProjectId",
    description: "A Google Cloud project ID; each stage has its own project.",
  })
);
export type GcpProjectId = typeof GcpProjectId.Type;

export const GcpRegion = Schema.String.check(
  Schema.isPattern(/^[a-z]+-[a-z]+[0-9]$/)
).pipe(
  Schema.brand("GcpRegion"),
  Schema.annotate({
    identifier: "GcpRegion",
    description: "A Google Cloud region such as europe-west1.",
  })
);
export type GcpRegion = typeof GcpRegion.Type;

export const GcsBucketName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/)
).pipe(
  Schema.brand("GcsBucketName"),
  Schema.annotate({
    identifier: "GcsBucketName",
    description: "A Cloud Storage bucket name without dots.",
  })
);
export type GcsBucketName = typeof GcsBucketName.Type;

export const ServiceAccountEmail = Schema.String.check(
  Schema.isPattern(
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/
  )
).pipe(
  Schema.brand("ServiceAccountEmail"),
  Schema.annotate({
    identifier: "ServiceAccountEmail",
    description: "A user-managed service account in a Workspace project.",
  })
);
export type ServiceAccountEmail = typeof ServiceAccountEmail.Type;

/**
 * A Secret Manager reference. It names a secret and pins one numeric
 * version; the value itself never enters configuration or Alchemy state.
 */
export const WorkspaceWorkload = WorkspaceServiceRole.annotate({
  identifier: "WorkspaceWorkload",
  description: "One of the three Cloud Run services built from the image.",
});
export type WorkspaceWorkload = typeof WorkspaceWorkload.Type;

export const SecretReference = Schema.Struct({
  /** The workloads that receive the secret; each gets its own grant. */
  consumers: Schema.Array(WorkspaceWorkload).check(Schema.isMinLength(1)),
  environmentVariable: Schema.String.check(
    Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)
  ),
  secretId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,255}$/)),
  version: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
}).annotate({
  identifier: "SecretReference",
  description:
    "A Secret Manager secret ID and pinned version, never a secret value.",
});
export type SecretReference = typeof SecretReference.Type;

export const WorkspaceServiceAccounts = Schema.Struct({
  /** The GitHub Actions identity that applies the stack. */
  deployer: ServiceAccountEmail,
  /** Runtime identity of the IAM-private API service. */
  apiRuntime: ServiceAccountEmail,
  /**
   * The frontend identity (Vercel through workload identity federation)
   * that may invoke the API service.
   */
  frontendInvoker: ServiceAccountEmail,
  /** Runtime identity of the private Cloud Tasks worker. */
  tasksWorkerRuntime: ServiceAccountEmail,
  /** Runtime identity of the private Cloud Scheduler worker. */
  schedulerWorkerRuntime: ServiceAccountEmail,
  /** OIDC identity Cloud Tasks presents to the tasks worker. */
  tasksInvoker: ServiceAccountEmail,
  /** OIDC identity Cloud Scheduler presents to the scheduler worker. */
  schedulerInvoker: ServiceAccountEmail,
  /** Uploads mobile update assets; may create objects but never replace them. */
  mobileUpdatesPublisher: ServiceAccountEmail,
}).annotate({ identifier: "WorkspaceServiceAccounts" });
export type WorkspaceServiceAccounts = typeof WorkspaceServiceAccounts.Type;

const positiveInt = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

export const WorkspaceCapacity = Schema.Struct({
  apiMaxInstances: positiveInt(100),
  workerMaxInstances: positiveInt(100),
  queueMaxConcurrentDispatches: positiveInt(1000),
  queueMaxDispatchesPerSecond: positiveInt(500),
}).annotate({ identifier: "WorkspaceCapacity" });
export type WorkspaceCapacity = typeof WorkspaceCapacity.Type;

/** An image reference pinned by digest. Tags are rejected. */
export const ImageDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/)
).pipe(
  Schema.brand("ImageDigest"),
  Schema.annotate({
    identifier: "ImageDigest",
    description: "An immutable OCI image digest (sha256).",
  })
);
export type ImageDigest = typeof ImageDigest.Type;

const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
);

/** Approved spend and lifetime for a disposable sandbox (#1452). */
export const SandboxBudget = Schema.Struct({
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  maximumSpend: Schema.Finite.check(Schema.isGreaterThan(0)),
  teardownAt: IsoDate,
}).annotate({ identifier: "SandboxBudget" });
export type SandboxBudget = typeof SandboxBudget.Type;

export const GcpProjectNumber = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{5,19}$/)
).pipe(
  Schema.brand("GcpProjectNumber"),
  Schema.annotate({
    identifier: "GcpProjectNumber",
    description:
      "The numeric project number; it fixes deterministic run.app URLs.",
  })
);
export type GcpProjectNumber = typeof GcpProjectNumber.Type;

const BaseStackConfig = Schema.Struct({
  projectId: GcpProjectId,
  projectNumber: GcpProjectNumber,
  region: GcpRegion.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultWorkspaceRegion))
  ),
  stateBucket: GcsBucketName,
  mobileUpdatesBucket: GcsBucketName,
  serviceAccounts: WorkspaceServiceAccounts,
  secrets: Schema.Array(SecretReference),
  capacity: WorkspaceCapacity,
  /** Cloud Scheduler jobs stay paused unless the environment is authorized. */
  schedulesEnabled: Schema.Boolean,
  /** Cloud Monitoring notification channel resource names. */
  alertNotificationChannels: Schema.Array(
    Schema.String.check(
      Schema.isPattern(/^projects\/[a-z0-9-]+\/notificationChannels\/[0-9]+$/)
    )
  ),
});

/**
 * A disposable run's suffix for Cloud Tasks queue IDs. Cloud Tasks keeps a
 * deleted queue's ID unavailable for days, so a sandbox proof that tears
 * down and reruns needs IDs of its own.
 */
export const DisposableQueueSuffix = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/)
);

export const SandboxStackConfig = Schema.Struct({
  ...BaseStackConfig.fields,
  stage: Schema.Literal("sandbox"),
  budget: SandboxBudget,
  disposableQueueSuffix: Schema.optionalKey(DisposableQueueSuffix),
}).annotate({ identifier: "SandboxStackConfig" });

export const PreviewStackConfig = Schema.Struct({
  ...BaseStackConfig.fields,
  stage: Schema.Literal("preview"),
}).annotate({ identifier: "PreviewStackConfig" });

export const ProductionStackConfig = Schema.Struct({
  ...BaseStackConfig.fields,
  stage: Schema.Literal("production"),
}).annotate({ identifier: "ProductionStackConfig" });

export const WorkspaceStackConfig = Schema.Union([
  SandboxStackConfig,
  PreviewStackConfig,
  ProductionStackConfig,
]).annotate({ identifier: "WorkspaceStackConfig" });
export type WorkspaceStackConfig = typeof WorkspaceStackConfig.Type;
export type WorkspaceStackConfigInput = typeof WorkspaceStackConfig.Encoded;

/**
 * A rejected stack configuration. It carries only the paths that failed,
 * never the rejected input, so logging it cannot leak a pasted secret.
 */
export class WorkspaceStackConfigInvalid extends Data.TaggedError(
  "WorkspaceStackConfigInvalid"
)<{
  readonly paths: ReadonlyArray<string>;
  readonly reason: "schema" | "secret-material" | "identity";
}> {
  override get message() {
    return `Workspace stack configuration is invalid (${this.reason}) at: ${this.paths.join(", ")}`;
  }
}

/**
 * Shapes that only appear in secret material. A value that matches is
 * rejected even under an allowed key.
 */
const secretMaterialPatterns: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"private_key"\s*:/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{8,}/,
  /\bgh[pousr]_[0-9A-Za-z]{20,}/,
  /\bya29\.[0-9A-Za-z_-]{10,}/,
];

const secretKeyPattern =
  /^(?:value|secretValue|password|token|apiKey|privateKey|credentials?|connectionString)$/i;

/**
 * Any value `JSON.parse` yields. Unlike `Schema.Json` it keeps non-finite
 * numbers such as an overflowing `1e400`, so the domain decoder rejects
 * them with the offending field path.
 */
const ParsedJson: Schema.Codec<Schema.Json> = Schema.Union([
  Schema.Null,
  Schema.Number,
  Schema.Boolean,
  Schema.String,
  Schema.Array(Schema.suspend(() => ParsedJson)),
  Schema.Record(
    Schema.String,
    Schema.suspend(() => ParsedJson)
  ),
]);

const findSecretMaterial = (
  input: Schema.Json,
  path: ReadonlyArray<string> = []
): ReadonlyArray<string> => {
  if (Predicate.isString(input)) {
    return secretMaterialPatterns.some((pattern) => pattern.test(input))
      ? [path.join(".") || "<root>"]
      : [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((item, index) =>
      findSecretMaterial(item, [...path, String(index)])
    );
  }
  if (
    input === null ||
    Predicate.isNumber(input) ||
    Predicate.isBoolean(input)
  ) {
    return [];
  }
  return Object.entries(input).flatMap(([key, value]) =>
    secretKeyPattern.test(key)
      ? [[...path, key].join(".")]
      : findSecretMaterial(value, [...path, key])
  );
};

const issuePaths = (issue: SchemaIssue.Issue): ReadonlyArray<string> => [
  ...new Set(
    SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues.map(
      (entry) => entry.path?.map(String).join(".") || "<root>"
    )
  ),
];

/**
 * The one state bucket of a project. The release record and its writer
 * lock live in it, so a config naming any other bucket would give the same
 * project and stage a second lock.
 */
export const workspaceStateBucket = (projectId: GcpProjectId) =>
  `${projectId}-workspace-state`;

/**
 * Decode untrusted stack configuration. Unknown keys fail, so a pasted
 * `value` or credential field never reaches a resource; known secret
 * shapes fail under any key.
 */
export const decodeWorkspaceStackConfig = Effect.fn(
  "WorkspaceStack.decodeWorkspaceStackConfig"
)(function* (input: Schema.Json) {
  const secretPaths = findSecretMaterial(input);
  if (secretPaths.length > 0) {
    return yield* new WorkspaceStackConfigInvalid({
      paths: secretPaths,
      reason: "secret-material",
    });
  }
  const config = yield* Schema.decodeUnknownEffect(WorkspaceStackConfig)(
    input,
    { onExcessProperty: "error", errors: "all" }
  ).pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceStackConfigInvalid({
          paths: issuePaths(error.issue),
          reason: "schema",
        })
    )
  );
  const identityPaths = [
    ...serviceAccountProblems(config),
    ...(config.stateBucket === workspaceStateBucket(config.projectId)
      ? []
      : ["stateBucket"]),
  ];
  if (identityPaths.length > 0) {
    return yield* new WorkspaceStackConfigInvalid({
      paths: identityPaths,
      reason: "identity",
    });
  }
  return config;
});

/**
 * Each role has its own service account, and every account lives in the
 * stage's own project, so one stage's identity never acts in another.
 */
const serviceAccountProblems = (config: WorkspaceStackConfig) => {
  const entries = Object.entries(config.serviceAccounts);
  return entries
    .filter(
      ([role, email]) =>
        !email.endsWith(`@${config.projectId}.iam.gserviceaccount.com`) ||
        entries.some(
          ([other, otherEmail]) => other !== role && otherEmail === email
        )
    )
    .map(([role]) => `serviceAccounts.${role}`);
};

/**
 * The configuration as it may appear in logs, plans and stack outputs.
 * Decoding already rejected secret material, so the encoded form holds
 * only identifiers and pinned secret versions.
 */
export const serializeWorkspaceStackConfig = (config: WorkspaceStackConfig) =>
  JSON.stringify(Schema.encodeSync(WorkspaceStackConfig)(config));

/**
 * The stage config CI supplies as JSON in `WORKSPACE_STACK_CONFIG`; it
 * alone selects project, stage and state for the stack and the release flow.
 */
export const configuredWorkspaceStack = Config.String(
  "WORKSPACE_STACK_CONFIG"
).pipe(
  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ParsedJson))),
  Effect.flatMap(decodeWorkspaceStackConfig)
);
