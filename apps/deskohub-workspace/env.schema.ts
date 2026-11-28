import { PostHogProjectId } from "@deskohub/analytics-posthog/identifiers";
import { dotyposApiTimeoutDefaultMilliseconds } from "@deskohub/dotypos/api-timeout";
import { igloohomeApiTimeoutMaximumMilliseconds } from "@deskohub/igloohome/config";
import { Effect, Schema } from "effect";
import {
  optionalStringSchema,
  optionalUrlEnvSchema,
  postHogBrowserEnvironmentCheck,
  toEnvSchema,
  type workspaceClientEnvSchema,
} from "./client-env.schema";
import { parseBetterAuthSecrets } from "./features/account/backend/auth/auth-secrets";
import { signingCertificateFingerprintSchema } from "./features/account/backend/auth/native-app";
import { reviewAccountCredentialsSchema } from "./features/account/backend/auth/review-account-credentials";
import { allowsMockPaymentProvider } from "./features/checkout/backend/payment/payment-provider-environment";
import {
  postHogFeatureFlagOverridesEnvironmentCheck,
  postHogFeatureFlagOverridesSchema,
  vercelEnvironmentSchema,
} from "./features/feature-flags/feature-flag-overrides.schema";
import {
  postHogExportPolicySchema,
  workspaceLogFormatSchema,
  workspaceLogLevelSchema,
} from "./shared/backend/observability/telemetry-policy";
import { deploymentStageSchema } from "./shared/deployment/deployment-stage";
import {
  runtimeHostSchema,
  serviceRoleSchema,
} from "./shared/deployment/runtime-host";
import { trustedClientAddressHeaderSchema } from "./shared/deployment/trusted-client-address";
import { urlStringSchema } from "./shared/utils/url-schema";

const nonEmptyStringSchema = toEnvSchema(Schema.NonEmptyString);
const urlEnvSchema = toEnvSchema(urlStringSchema);

const optionalNonEmptyStringSchema = toEnvSchema(
  Schema.optional(Schema.NonEmptyString)
);

const optionalEmailAddressSchema = toEnvSchema(
  Schema.optional(
    Schema.Trimmed.check(Schema.isPattern(/^[^\s@<>]+@[^\s@<>]+$/))
  )
);

const igloohomeProductionEnvironmentCheck = Schema.makeFilter<{
  readonly VERCEL_ENV: "production" | "preview" | "development";
  readonly IGLOOHOME_CLIENT_ID?: string | undefined;
  readonly IGLOOHOME_CLIENT_SECRET?: string | undefined;
}>((environment) => {
  if (environment.VERCEL_ENV !== "production") return undefined;

  return (["IGLOOHOME_CLIENT_ID", "IGLOOHOME_CLIENT_SECRET"] as const).flatMap(
    (key) =>
      environment[key] === undefined
        ? [{ path: [key], issue: `${key} is required in production.` }]
        : []
  );
});

const isBlank = (value: string | undefined): boolean =>
  value === undefined || value.trim() === "";

/** An origin alone: scheme, host and port, with no path, query or fragment. */
const originSchema = urlStringSchema.check(
  Schema.makeFilter(
    (value) => URL.canParse(value) && new URL(value).origin === value,
    { expected: "an origin such as https://workspace.example, without a path" }
  )
);

/**
 * Vercel supplies the deployment and production hosts. A container host has
 * neither, so it must name its public origin and the header its trusted
 * ingress sets to the client address; without that header no forwarded
 * address is trusted at all.
 */
const deploymentHostEnvironmentCheck = Schema.makeFilter<{
  readonly WORKSPACE_RUNTIME_HOST?: "vercel" | "container" | undefined;
  readonly WORKSPACE_PUBLIC_ORIGIN?: string | undefined;
  readonly WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER?: string | undefined;
  readonly VERCEL_URL?: string | undefined;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string | undefined;
}>((environment) => {
  if (environment.WORKSPACE_RUNTIME_HOST === "container") {
    return [
      ...(environment.WORKSPACE_PUBLIC_ORIGIN
        ? []
        : [
            {
              path: ["WORKSPACE_PUBLIC_ORIGIN"],
              issue: "A container deployment requires its public origin.",
            },
          ]),
      ...(environment.WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER
        ? []
        : [
            {
              path: ["WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER"],
              issue:
                "A container deployment requires the client address header its ingress sets.",
            },
          ]),
    ];
  }
  if (environment.WORKSPACE_PUBLIC_ORIGIN) return undefined;
  return (["VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const)
    .filter((key) => !environment[key])
    .map((key) => ({
      path: [key],
      issue: "Required unless WORKSPACE_PUBLIC_ORIGIN names the public origin.",
    }));
});

const paymentProviderEnvironmentCheck = Schema.makeFilter<{
  readonly WORKSPACE_PAYMENT_PROVIDER?:
    | "nexi"
    | "mock"
    | "fallback"
    | undefined;
  readonly VERCEL_ENV: string;
  readonly VERCEL_AUTOMATION_BYPASS_SECRET?: string | undefined;
}>((environment) => {
  const provider = environment.WORKSPACE_PAYMENT_PROVIDER;
  if (
    (provider === "mock" || provider === "fallback") &&
    !allowsMockPaymentProvider(environment)
  ) {
    return [
      {
        path: ["WORKSPACE_PAYMENT_PROVIDER"],
        issue:
          "Mock payments require a preview with Deployment Protection for Automation configured.",
      },
    ];
  }
  return undefined;
});

/**
 * Deployed environments must never serve a release whose account email
 * delivery is unconfigured: without a Resend key every message, including
 * magic links, is only logged. Production on Vercel must also never leave
 * cleanup jobs publicly invokable without cron authentication; a container
 * host authenticates Cloud Scheduler's OIDC token instead of the cron secret.
 * Development and test environments stay usable without these secrets.
 */
const accountOperationsEnvironmentCheck = Schema.makeFilter<{
  readonly VERCEL_ENV: "production" | "preview" | "development";
  readonly WORKSPACE_RUNTIME_HOST?: "vercel" | "container" | undefined;
  readonly EMAIL_API_KEY?: string | undefined;
  readonly CRON_SECRET?: string | undefined;
}>((environment) => {
  if (environment.VERCEL_ENV === "development") return undefined;

  const requirements: readonly (readonly [
    "EMAIL_API_KEY" | "CRON_SECRET",
    string,
  ])[] = [
    ["EMAIL_API_KEY", "EMAIL_API_KEY is required in production and preview."],
    ...(environment.VERCEL_ENV === "production" &&
    environment.WORKSPACE_RUNTIME_HOST !== "container"
      ? [["CRON_SECRET", "CRON_SECRET is required in production."] as const]
      : []),
  ];

  return requirements.flatMap(([key, issue]) =>
    isBlank(environment[key]) ? [{ path: [key], issue }] : []
  );
});

/**
 * Production must never serve a release whose account authentication cannot
 * bootstrap. The account-owned secrets parser is the authority for the
 * versioned, duplicate-free, strong-secret contract; environments outside
 * production may omit the variable entirely.
 */
const betterAuthSecretsProductionEnvironmentCheck = Schema.makeFilter<{
  readonly VERCEL_ENV: "production" | "preview" | "development";
  readonly BETTER_AUTH_SECRETS?: string | undefined;
}>((environment) => {
  if (environment.VERCEL_ENV !== "production") return undefined;

  return parseBetterAuthSecrets(environment.BETTER_AUTH_SECRETS).kind ===
    "valid"
    ? undefined
    : [
        {
          path: ["BETTER_AUTH_SECRETS"],
          issue:
            "BETTER_AUTH_SECRETS must contain valid versioned secrets in production.",
        },
      ];
});

export const workspaceServerEnvSchema = Schema.Struct({
  ACCOUNTING_DOCUMENT_SNAPSHOT_ACTIVE_KEY_ID: toEnvSchema(
    Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{2,31}$/))
  ),
  CLOUDINARY_API_KEY: nonEmptyStringSchema,
  CLOUDINARY_API_SECRET: nonEmptyStringSchema,
  DATABASE_URL: urlEnvSchema,
  DATABASE_URL_UNPOOLED: optionalUrlEnvSchema,
  BETTER_AUTH_SECRETS: toEnvSchema(Schema.optional(Schema.NonEmptyString)),
  DOTYPOS_API_TIMEOUT: toEnvSchema(
    Schema.FiniteFromString.check(Schema.isInt())
      .check(Schema.isGreaterThan(0))
      .pipe(
        Schema.withDecodingDefaultType(
          Effect.succeed(dotyposApiTimeoutDefaultMilliseconds)
        )
      )
  ),
  DOTYPOS_API_URL: urlEnvSchema,
  DOTYPOS_BRANCH_ID: nonEmptyStringSchema,
  DOTYPOS_CLIENT_ID: nonEmptyStringSchema,
  DOTYPOS_CLIENT_SECRET: nonEmptyStringSchema,
  DOTYPOS_CLOUD_ID: nonEmptyStringSchema,
  DOTYPOS_EMPLOYEE_ID: nonEmptyStringSchema,
  DOTYPOS_REFRESH_TOKEN: nonEmptyStringSchema,
  EMAIL_API_KEY: optionalStringSchema,
  EMAIL_CAMPAIGN_ADMIN_INBOX: optionalEmailAddressSchema,
  EMAIL_CAMPAIGN_FROM: optionalEmailAddressSchema,
  EMAIL_CAMPAIGN_REPLY_TO: optionalEmailAddressSchema,
  GOOGLE_CALENDAR_PRIVATE_KEY: nonEmptyStringSchema,
  GOOGLE_CALENDAR_SALES_ID: nonEmptyStringSchema,
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: nonEmptyStringSchema,
  GOOGLE_CALENDAR_WORKSPACE_LIMITATIONS_ID: nonEmptyStringSchema,
  GITHUB_STEP_SUMMARY: optionalStringSchema,
  IGLOOHOME_API_TIMEOUT: toEnvSchema(
    Schema.FiniteFromString.check(Schema.isInt())
      .check(Schema.isGreaterThan(0))
      .check(Schema.isLessThanOrEqualTo(igloohomeApiTimeoutMaximumMilliseconds))
      .pipe(Schema.withDecodingDefaultType(Effect.succeed(10_000)))
  ),
  IGLOOHOME_API_URL: toEnvSchema(
    urlStringSchema.pipe(
      Schema.withDecodingDefaultType(
        Effect.succeed("https://api.igloodeveloper.co/igloohome")
      )
    )
  ),
  IGLOOHOME_AUTH_URL: toEnvSchema(
    urlStringSchema.pipe(
      Schema.withDecodingDefaultType(
        Effect.succeed("https://auth.igloohome.co")
      )
    )
  ),
  IGLOOHOME_CLIENT_ID: optionalNonEmptyStringSchema,
  IGLOOHOME_CLIENT_SECRET: optionalNonEmptyStringSchema,
  IGLOOHOME_ALGOPIN_TARGET_DEVICE_ID: nonEmptyStringSchema,
  RESEND_WEBHOOK_SECRET: nonEmptyStringSchema,
  // App-directory review logins, the only password sign-ins.
  REVIEW_ACCOUNT_CREDENTIALS: toEnvSchema(reviewAccountCredentialsSchema),
  // The Apple Developer team of the native app. Without it the site serves
  // no `/.well-known/apple-app-site-association`.
  APPLE_TEAM_ID: toEnvSchema(
    Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)))
  ),
  // SHA-256 fingerprint of a debug signing certificate whose app builds may
  // use passkeys in local development only.
  ANDROID_DEBUG_SIGNING_CERT_SHA256: toEnvSchema(
    Schema.optional(signingCertificateFingerprintSchema)
  ),
  CHECKOUT_PAY_STATE_KEYS: nonEmptyStringSchema,
  CHECKOUT_RETURN_STATE_TOKEN_SECRET: toEnvSchema(
    Schema.optional(Schema.String.check(Schema.isMinLength(32)))
  ),
  RESERVATION_ACCESS_TOKEN_SECRET: toEnvSchema(
    Schema.optional(Schema.String.check(Schema.isMinLength(32)))
  ),
  CRON_SECRET: toEnvSchema(Schema.optional(Schema.NonEmptyString)),
  ANALYTICS_WAREHOUSE_SOURCE_TOKEN: toEnvSchema(
    Schema.optional(Schema.String.check(Schema.isMinLength(32)))
  ),
  // Bearer token the release pipeline presents to publish mobile app updates.
  MOBILE_UPDATES_PUBLISH_TOKEN: toEnvSchema(
    Schema.optional(Schema.String.check(Schema.isMinLength(32)))
  ),
  // PEM RSA key that signs mobile update manifests; the app embeds its
  // certificate, features/mobile-updates/code-signing-certificate.pem.
  MOBILE_UPDATES_SIGNING_PRIVATE_KEY: toEnvSchema(
    Schema.optional(
      Schema.String.check(
        Schema.isPattern(/-----BEGIN (RSA )?PRIVATE KEY-----/)
      )
    )
  ),
  NEXI_API_KEY: nonEmptyStringSchema,
  NEXI_API_ORIGIN: urlEnvSchema,
  FIO_RECEIVING_ACCOUNTS: toEnvSchema(Schema.optional(Schema.String)),
  FIO_QR_PAYMENTS_ENABLED: toEnvSchema(
    Schema.optional(Schema.Literals(["true", "false"]))
  ),
  NEXI_CHECKOUT_CURRENCY_OVERRIDE: toEnvSchema(
    Schema.optional(Schema.Literal("EUR"))
  ),
  // The ChatGPT app directory's domain verification token, served at
  // `/.well-known/openai-apps-challenge`. Trimmed so a pasted line break
  // doesn't change the served token.
  OPENAI_APPS_CHALLENGE_TOKEN: toEnvSchema(
    Schema.optional(Schema.Trim.check(Schema.isNonEmpty()))
  ),
  POSTHOG_SERVICE_NAME: toEnvSchema(
    Schema.NonEmptyString.pipe(
      Schema.withDecodingDefaultType(Effect.succeed("deskohub-workspace"))
    )
  ),
  POSTHOG_SERVICE_NAMESPACE: toEnvSchema(
    Schema.NonEmptyString.pipe(
      Schema.withDecodingDefaultType(Effect.succeed("deskohub"))
    )
  ),
  POSTHOG_API_KEY: toEnvSchema(Schema.optional(Schema.NonEmptyString)),
  POSTHOG_API_HOST: urlEnvSchema,
  POSTHOG_FEATURE_FLAG_OVERRIDES: toEnvSchema(
    postHogFeatureFlagOverridesSchema
  ),
  POSTHOG_INGEST_HOST: urlEnvSchema,
  POSTHOG_EMAIL_SECRET_KEY: optionalStringSchema,
  POSTHOG_EMAIL_WEBHOOK_SIGNING_SECRET: optionalStringSchema,
  // Which deployments export server logs to PostHog: "production-only" (the
  // default when unset) or "always". Set "always" as a branch-scoped Vercel
  // Preview variable to read one preview's logs in PostHog; it is read at
  // runtime, so a redeploy of that branch picks it up.
  POSTHOG_LOGS_EXPORT: toEnvSchema(Schema.optional(postHogExportPolicySchema)),
  // Which deployments export server spans to PostHog's /i/v1/traces, through
  // the span allowlist: "production-only" (the default when unset) or
  // "always", set like POSTHOG_LOGS_EXPORT to trace one preview or sandbox.
  POSTHOG_TRACES_EXPORT: toEnvSchema(
    Schema.optional(postHogExportPolicySchema)
  ),
  POSTHOG_PERSON_PRIVACY_API_KEY: optionalNonEmptyStringSchema,
  POSTHOG_PROJECT_ID: toEnvSchema(Schema.optional(PostHogProjectId)),
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: optionalStringSchema,
  // Cloud Run's revision name, which identifies a container rollout.
  K_REVISION: optionalNonEmptyStringSchema,
  VERCEL_BRANCH_URL: optionalStringSchema,
  VERCEL_DEPLOYMENT_ID: optionalNonEmptyStringSchema,
  // The deployment stage. `env.ts` resolves it from WORKSPACE_DEPLOYMENT_STAGE
  // where a host sets that, else from Vercel's VERCEL_ENV.
  VERCEL_ENV: toEnvSchema(vercelEnvironmentSchema),
  VERCEL_GIT_COMMIT_SHA: optionalStringSchema,
  VERCEL_AUTOMATION_BYPASS_SECRET: optionalStringSchema,
  VERCEL_PROJECT_PRODUCTION_URL: optionalNonEmptyStringSchema,
  VERCEL_URL: optionalNonEmptyStringSchema,
  // Read by `next.config.mjs` at build time for the `Origin-Trial` header.
  WEBMCP_ORIGIN_TRIAL_TOKENS: optionalNonEmptyStringSchema,
  // Overrides the Vercel-derived deployment identity on another host.
  WORKSPACE_DEPLOYMENT_ID: optionalNonEmptyStringSchema,
  WORKSPACE_DEPLOYMENT_STAGE: toEnvSchema(
    Schema.optional(deploymentStageSchema)
  ),
  WORKSPACE_E2E_BASE_URL: optionalUrlEnvSchema,
  // The least severe level Workspace server runs log, as an Effect log level
  // name ("All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None").
  // Unset, production logs from Info and every other deployment from Debug.
  WORKSPACE_LOG_LEVEL: toEnvSchema(Schema.optional(workspaceLogLevelSchema)),
  // "logfmt" (the default) or "cloud-logging-json" for a container host.
  WORKSPACE_LOG_FORMAT: toEnvSchema(Schema.optional(workspaceLogFormatSchema)),
  WORKSPACE_PAYMENT_PROVIDER: toEnvSchema(
    Schema.optional(Schema.Literals(["nexi", "mock", "fallback"]))
  ),
  // The canonical public origin on a host other than Vercel, which then
  // replaces the Vercel deployment and production hosts.
  WORKSPACE_PUBLIC_ORIGIN: toEnvSchema(Schema.optional(originSchema)),
  // The source commit the build was made from, on a host other than Vercel.
  WORKSPACE_REVISION_SHA: optionalNonEmptyStringSchema,
  WORKSPACE_RUNTIME_HOST: toEnvSchema(Schema.optional(runtimeHostSchema)),
  // The Cloud Scheduler worker's OIDC audience and the service account whose
  // Google-signed token every cron request on a container host must carry.
  // Unset, a container host rejects every cron request.
  WORKSPACE_SCHEDULER_AUDIENCE: toEnvSchema(Schema.optional(urlStringSchema)),
  WORKSPACE_SCHEDULER_INVOKER_EMAIL: optionalEmailAddressSchema,
  WORKSPACE_SERVICE_ROLE: toEnvSchema(Schema.optional(serviceRoleSchema)),
  // The Cloud Tasks worker's OIDC audience and the service account whose
  // Google-signed token every queue delivery on a container host must carry.
  // Unset, a container host rejects every queue delivery.
  WORKSPACE_TASKS_AUDIENCE: toEnvSchema(Schema.optional(urlStringSchema)),
  WORKSPACE_TASKS_INVOKER_EMAIL: optionalEmailAddressSchema,
  // The lowercase header the trusted ingress sets to the client address on a
  // container host. Unset, only Vercel's own header is trusted, on Vercel.
  WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER: toEnvSchema(
    Schema.optional(trustedClientAddressHeaderSchema)
  ),
}).check(
  deploymentHostEnvironmentCheck,
  postHogFeatureFlagOverridesEnvironmentCheck,
  igloohomeProductionEnvironmentCheck,
  accountOperationsEnvironmentCheck,
  betterAuthSecretsProductionEnvironmentCheck,
  paymentProviderEnvironmentCheck
);

/**
 * T3 Env normally validates the field dictionary, which cannot retain checks
 * that depend on multiple fields. Compose its final schema here so server-only
 * deployment checks run without coupling them to `env.ts`.
 */
export const createEnvironmentSchema = (
  fields: typeof workspaceServerEnvSchema.fields &
    typeof workspaceClientEnvSchema.fields,
  isServer: boolean
) => {
  const schema = Schema.Struct(fields).check(postHogBrowserEnvironmentCheck);

  return Schema.toStandardSchemaV1(
    isServer
      ? schema.check(
          deploymentHostEnvironmentCheck,
          postHogFeatureFlagOverridesEnvironmentCheck,
          igloohomeProductionEnvironmentCheck,
          accountOperationsEnvironmentCheck,
          betterAuthSecretsProductionEnvironmentCheck,
          paymentProviderEnvironmentCheck
        )
      : schema
  );
};
