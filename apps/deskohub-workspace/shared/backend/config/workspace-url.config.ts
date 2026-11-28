import { Data, Effect, Result } from "effect";
import { env } from "@/env";
import type { DeploymentStage } from "@/shared/deployment/deployment-stage";

export class WorkspaceUrlConfigError extends Data.TaggedError(
  "WorkspaceUrlConfigError"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface WorkspaceCallbackEnvironment {
  readonly deploymentEnvironment: DeploymentStage;
  readonly deploymentUrl: string | undefined;
  readonly productionUrl: string | undefined;
}

/**
 * The hosts a deployment answers on: its own deployment URL, the project's
 * production URL, and on Vercel a preview's branch URL. A host other than
 * Vercel names one canonical public origin, which is all three.
 */
export interface WorkspaceDeploymentHosts {
  readonly deploymentUrl: string | undefined;
  readonly productionUrl: string | undefined;
  readonly branchUrl: string | undefined;
}

export const resolveWorkspaceDeploymentHosts = (settings: {
  readonly WORKSPACE_PUBLIC_ORIGIN?: string | undefined;
  readonly VERCEL_URL?: string | undefined;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string | undefined;
  readonly VERCEL_BRANCH_URL?: string | undefined;
}): WorkspaceDeploymentHosts =>
  settings.WORKSPACE_PUBLIC_ORIGIN
    ? {
        deploymentUrl: settings.WORKSPACE_PUBLIC_ORIGIN,
        productionUrl: settings.WORKSPACE_PUBLIC_ORIGIN,
        branchUrl: undefined,
      }
    : {
        deploymentUrl: settings.VERCEL_URL,
        productionUrl: settings.VERCEL_PROJECT_PRODUCTION_URL,
        branchUrl: settings.VERCEL_BRANCH_URL,
      };

/** The hosts of the running deployment. */
export const workspaceDeploymentHosts = () =>
  resolveWorkspaceDeploymentHosts(env);

export const getWorkspaceCallbackOrigin = (
  environment: WorkspaceCallbackEnvironment
): Effect.Effect<URL, WorkspaceUrlConfigError> =>
  Effect.suspend(() =>
    Effect.fromResult(resolveWorkspaceCallbackOrigin(environment))
  );

export const getWorkspaceRuntimeCallbackOrigin: Effect.Effect<
  URL,
  WorkspaceUrlConfigError
> = Effect.suspend(() =>
  Effect.fromResult(resolveWorkspaceRuntimeCallbackOrigin())
);

/**
 * Resolves the callback origin of the running deployment synchronously, for
 * callers such as the proxy that must not start an Effect runtime.
 */
export const resolveWorkspaceRuntimeCallbackOrigin = () => {
  const { deploymentUrl, productionUrl } = workspaceDeploymentHosts();
  return resolveWorkspaceCallbackOrigin({
    deploymentEnvironment: env.VERCEL_ENV,
    deploymentUrl,
    productionUrl,
  });
};

const resolveWorkspaceCallbackOrigin = ({
  deploymentEnvironment,
  deploymentUrl,
  productionUrl,
}: WorkspaceCallbackEnvironment): Result.Result<
  URL,
  WorkspaceUrlConfigError
> => {
  const url =
    deploymentEnvironment === "production" ? productionUrl : deploymentUrl;

  if (!url) {
    return Result.fail(
      new WorkspaceUrlConfigError({
        message: "Payment checkout callback URL is not configured.",
      })
    );
  }

  return Result.try({
    try: () =>
      new URL(
        url.includes("://")
          ? url
          : `${deploymentEnvironment === "development" ? "http" : "https"}://${url}`
      ),
    catch: (cause) =>
      new WorkspaceUrlConfigError({
        message: "Payment checkout callback URL is not configured.",
        cause,
      }),
  });
};
