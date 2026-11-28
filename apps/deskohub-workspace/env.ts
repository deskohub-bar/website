import { createEnv } from "@t3-oss/env-nextjs";
import { Predicate } from "effect";
import { workspaceClientEnvSchema } from "./client-env.schema";
import {
  createEnvironmentSchema,
  workspaceServerEnvSchema,
} from "./env.schema";
import { selectDeploymentStageSetting } from "./shared/deployment/deployment-stage-setting.js";

// Next only transforms statically named environment accesses. Key rotation is
// additive: configure the new variable, add its direct access here, deploy,
// and only then change the active key ID.
const accountingDocumentSnapshotSecrets: Readonly<
  Record<string, string | undefined>
> = {
  K202608: process.env.ACCOUNTING_DOCUMENT_SNAPSHOT_KEY_K202608,
};

type WorkspaceRuntimeEnv = Readonly<
  Record<
    | keyof typeof workspaceServerEnvSchema.fields
    | keyof typeof workspaceClientEnvSchema.fields,
    string | undefined
  >
>;

/**
 * Validates a runtime environment, reporting failures without echoing
 * configured values. `env` below supplies the statically named
 * `process.env` reads that Next requires.
 */
export const createWorkspaceEnv = (runtimeEnv: WorkspaceRuntimeEnv) =>
  createEnv({
    server: workspaceServerEnvSchema.fields,
    client: workspaceClientEnvSchema.fields,
    runtimeEnv: { ...runtimeEnv },
    createFinalSchema: createEnvironmentSchema,
    emptyStringAsUndefined: true,
    onValidationError: (error) => {
      const sanitizedError = error.map((issue) => {
        const hasPath = (key: string) =>
          issue.path?.some((segment) =>
            Predicate.isObject(segment) ? segment.key === key : segment === key
          );

        if (hasPath("POSTHOG_FEATURE_FLAG_OVERRIDES")) {
          return {
            ...issue,
            message: "Invalid PostHog feature flag override configuration.",
          };
        }

        if (hasPath("BETTER_AUTH_SECRETS")) {
          return {
            ...issue,
            message: "Invalid Better Auth secret configuration.",
          };
        }

        if (hasPath("REVIEW_ACCOUNT_CREDENTIALS")) {
          return {
            ...issue,
            message: "Invalid review account credential configuration.",
          };
        }

        if (hasPath("IGLOOHOME_CLIENT_SECRET")) {
          return {
            ...issue,
            message: "Invalid Igloohome client credential configuration.",
          };
        }

        if (hasPath("EMAIL_API_KEY")) {
          return {
            ...issue,
            message: "Invalid email delivery configuration.",
          };
        }

        if (hasPath("ANALYTICS_WAREHOUSE_SOURCE_TOKEN")) {
          return {
            ...issue,
            message: "Invalid analytics warehouse source token configuration.",
          };
        }

        if (hasPath("CRON_SECRET")) {
          return {
            ...issue,
            message: "Invalid production cron authentication configuration.",
          };
        }

        return issue;
      });

      throw new Error(
        `Invalid workspace environment variables: ${JSON.stringify(sanitizedError, null, 2)}`
      );
    },
    onInvalidAccess: (variable) => {
      throw new Error(
        `Attempted to access server-side workspace environment variable '${variable}' on the client`
      );
    },
  });

export const env = createWorkspaceEnv({
  ACCOUNTING_DOCUMENT_SNAPSHOT_ACTIVE_KEY_ID:
    process.env.ACCOUNTING_DOCUMENT_SNAPSHOT_ACTIVE_KEY_ID,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  BETTER_AUTH_SECRETS: process.env.BETTER_AUTH_SECRETS,
  DOTYPOS_API_TIMEOUT: process.env.DOTYPOS_API_TIMEOUT,
  DOTYPOS_API_URL: process.env.DOTYPOS_API_URL,
  DOTYPOS_BRANCH_ID: process.env.DOTYPOS_BRANCH_ID,
  DOTYPOS_CLIENT_ID: process.env.DOTYPOS_CLIENT_ID,
  DOTYPOS_CLIENT_SECRET: process.env.DOTYPOS_CLIENT_SECRET,
  DOTYPOS_CLOUD_ID: process.env.DOTYPOS_CLOUD_ID,
  DOTYPOS_EMPLOYEE_ID: process.env.DOTYPOS_EMPLOYEE_ID,
  DOTYPOS_REFRESH_TOKEN: process.env.DOTYPOS_REFRESH_TOKEN,
  EMAIL_API_KEY: process.env.EMAIL_API_KEY,
  EMAIL_CAMPAIGN_ADMIN_INBOX: process.env.EMAIL_CAMPAIGN_ADMIN_INBOX,
  EMAIL_CAMPAIGN_FROM: process.env.EMAIL_CAMPAIGN_FROM,
  EMAIL_CAMPAIGN_REPLY_TO: process.env.EMAIL_CAMPAIGN_REPLY_TO,
  GOOGLE_CALENDAR_PRIVATE_KEY: process.env.GOOGLE_CALENDAR_PRIVATE_KEY,
  GOOGLE_CALENDAR_SALES_ID: process.env.GOOGLE_CALENDAR_SALES_ID,
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL:
    process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_CALENDAR_WORKSPACE_LIMITATIONS_ID:
    process.env.GOOGLE_CALENDAR_WORKSPACE_LIMITATIONS_ID,
  GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY,
  IGLOOHOME_API_TIMEOUT: process.env.IGLOOHOME_API_TIMEOUT,
  IGLOOHOME_API_URL: process.env.IGLOOHOME_API_URL,
  IGLOOHOME_AUTH_URL: process.env.IGLOOHOME_AUTH_URL,
  IGLOOHOME_CLIENT_ID: process.env.IGLOOHOME_CLIENT_ID,
  IGLOOHOME_CLIENT_SECRET: process.env.IGLOOHOME_CLIENT_SECRET,
  IGLOOHOME_ALGOPIN_TARGET_DEVICE_ID:
    process.env.IGLOOHOME_ALGOPIN_TARGET_DEVICE_ID,
  RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
  REVIEW_ACCOUNT_CREDENTIALS: process.env.REVIEW_ACCOUNT_CREDENTIALS,
  APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
  ANDROID_DEBUG_SIGNING_CERT_SHA256:
    process.env.ANDROID_DEBUG_SIGNING_CERT_SHA256,
  CHECKOUT_PAY_STATE_KEYS: process.env.CHECKOUT_PAY_STATE_KEYS,
  CHECKOUT_RETURN_STATE_TOKEN_SECRET:
    process.env.CHECKOUT_RETURN_STATE_TOKEN_SECRET,
  RESERVATION_ACCESS_TOKEN_SECRET: process.env.RESERVATION_ACCESS_TOKEN_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,
  ANALYTICS_WAREHOUSE_SOURCE_TOKEN:
    process.env.ANALYTICS_WAREHOUSE_SOURCE_TOKEN,
  MOBILE_UPDATES_PUBLISH_TOKEN: process.env.MOBILE_UPDATES_PUBLISH_TOKEN,
  MOBILE_UPDATES_SIGNING_PRIVATE_KEY:
    process.env.MOBILE_UPDATES_SIGNING_PRIVATE_KEY,
  NEXI_API_KEY: process.env.NEXI_API_KEY,
  NEXI_API_ORIGIN: process.env.NEXI_API_ORIGIN,
  FIO_RECEIVING_ACCOUNTS: process.env.FIO_RECEIVING_ACCOUNTS,
  FIO_QR_PAYMENTS_ENABLED: process.env.FIO_QR_PAYMENTS_ENABLED,
  NEXI_CHECKOUT_CURRENCY_OVERRIDE: process.env.NEXI_CHECKOUT_CURRENCY_OVERRIDE,
  OPENAI_APPS_CHALLENGE_TOKEN: process.env.OPENAI_APPS_CHALLENGE_TOKEN,
  POSTHOG_SERVICE_NAME: process.env.POSTHOG_SERVICE_NAME,
  POSTHOG_SERVICE_NAMESPACE: process.env.POSTHOG_SERVICE_NAMESPACE,
  POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
  POSTHOG_API_HOST: process.env.POSTHOG_API_HOST,
  POSTHOG_FEATURE_FLAG_OVERRIDES: process.env.POSTHOG_FEATURE_FLAG_OVERRIDES,
  POSTHOG_INGEST_HOST: process.env.POSTHOG_INGEST_HOST,
  POSTHOG_EMAIL_SECRET_KEY: process.env.POSTHOG_EMAIL_SECRET_KEY,
  POSTHOG_EMAIL_WEBHOOK_SIGNING_SECRET:
    process.env.POSTHOG_EMAIL_WEBHOOK_SIGNING_SECRET,
  POSTHOG_LOGS_EXPORT: process.env.POSTHOG_LOGS_EXPORT,
  POSTHOG_TRACES_EXPORT: process.env.POSTHOG_TRACES_EXPORT,
  POSTHOG_PERSON_PRIVACY_API_KEY: process.env.POSTHOG_PERSON_PRIVACY_API_KEY,
  POSTHOG_PROJECT_ID: process.env.POSTHOG_PROJECT_ID,
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  VERCEL_AUTOMATION_BYPASS_SECRET: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  K_REVISION: process.env.K_REVISION,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
  // The deployment stage, whichever host sets it.
  VERCEL_ENV: selectDeploymentStageSetting({
    WORKSPACE_DEPLOYMENT_STAGE: process.env.WORKSPACE_DEPLOYMENT_STAGE,
    VERCEL_ENV: process.env.VERCEL_ENV,
  }),
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  VERCEL_URL: process.env.VERCEL_URL,
  WEBMCP_ORIGIN_TRIAL_TOKENS: process.env.WEBMCP_ORIGIN_TRIAL_TOKENS,
  WORKSPACE_DEPLOYMENT_ID: process.env.WORKSPACE_DEPLOYMENT_ID,
  WORKSPACE_DEPLOYMENT_STAGE: process.env.WORKSPACE_DEPLOYMENT_STAGE,
  WORKSPACE_E2E_BASE_URL: process.env.WORKSPACE_E2E_BASE_URL,
  WORKSPACE_LOG_FORMAT: process.env.WORKSPACE_LOG_FORMAT,
  WORKSPACE_LOG_LEVEL: process.env.WORKSPACE_LOG_LEVEL,
  WORKSPACE_PAYMENT_PROVIDER: process.env.WORKSPACE_PAYMENT_PROVIDER,
  WORKSPACE_PUBLIC_ORIGIN: process.env.WORKSPACE_PUBLIC_ORIGIN,
  WORKSPACE_REVISION_SHA: process.env.WORKSPACE_REVISION_SHA,
  WORKSPACE_RUNTIME_HOST: process.env.WORKSPACE_RUNTIME_HOST,
  WORKSPACE_SCHEDULER_AUDIENCE: process.env.WORKSPACE_SCHEDULER_AUDIENCE,
  WORKSPACE_SCHEDULER_INVOKER_EMAIL:
    process.env.WORKSPACE_SCHEDULER_INVOKER_EMAIL,
  WORKSPACE_SERVICE_ROLE: process.env.WORKSPACE_SERVICE_ROLE,
  WORKSPACE_TASKS_AUDIENCE: process.env.WORKSPACE_TASKS_AUDIENCE,
  WORKSPACE_TASKS_INVOKER_EMAIL: process.env.WORKSPACE_TASKS_INVOKER_EMAIL,
  WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER:
    process.env.WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER,
  NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME:
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  NEXT_PUBLIC_GTM_ID: process.env.NEXT_PUBLIC_GTM_ID,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN:
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  // The browser's stage, resolved as `client-env.ts` resolves it.
  NEXT_PUBLIC_VERCEL_ENV: selectDeploymentStageSetting({
    WORKSPACE_DEPLOYMENT_STAGE:
      process.env.NEXT_PUBLIC_WORKSPACE_DEPLOYMENT_STAGE,
    VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  }),
});

export const getAccountingDocumentSnapshotSecret = (keyId: string) =>
  accountingDocumentSnapshotSecrets[keyId];
