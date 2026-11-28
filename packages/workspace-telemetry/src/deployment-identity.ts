/**
 * Which build and which rollout of it a process serves, independent of the
 * host. Telemetry, release lookups and logs read it instead of host
 * variables.
 */
export interface DeploymentIdentity {
  /** The source commit of the build, which also names its source maps. */
  readonly revisionSha: string | undefined;
  /** The host's id of this rollout, such as a Vercel deployment or a Cloud Run revision. */
  readonly deploymentId: string | undefined;
}

export interface DeploymentIdentitySettings {
  readonly WORKSPACE_REVISION_SHA?: string | undefined;
  readonly VERCEL_GIT_COMMIT_SHA?: string | undefined;
  readonly WORKSPACE_DEPLOYMENT_ID?: string | undefined;
  readonly VERCEL_DEPLOYMENT_ID?: string | undefined;
  readonly K_REVISION?: string | undefined;
}

/**
 * Explicit Workspace settings win; otherwise each host's own variables:
 * Vercel's commit and deployment, or the Cloud Run revision name, which
 * identifies a rollout but not a commit.
 */
export const resolveDeploymentIdentity = (
  settings: DeploymentIdentitySettings
): DeploymentIdentity => ({
  revisionSha:
    settings.WORKSPACE_REVISION_SHA ||
    settings.VERCEL_GIT_COMMIT_SHA ||
    undefined,
  deploymentId:
    settings.WORKSPACE_DEPLOYMENT_ID ||
    settings.VERCEL_DEPLOYMENT_ID ||
    settings.K_REVISION ||
    undefined,
});
