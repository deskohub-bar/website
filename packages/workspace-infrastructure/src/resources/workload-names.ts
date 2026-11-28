import type {
  ImageDigest,
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "../config/stack-config";

export const workspaceApiServiceId = "workspace-api";
export const workspaceArtifactRepositoryId = "workspace";
export const workspaceImageName = "workspace";

export const workloadServiceIds = {
  api: workspaceApiServiceId,
  "tasks-worker": "workspace-tasks-worker",
  "scheduler-worker": "workspace-scheduler-worker",
} satisfies Record<WorkspaceWorkload, string>;

/**
 * The deterministic run.app URL of a service. Declarations use it so
 * queue and schedule targets need no apply-time output; readback checks
 * that the live service reports the same URL.
 */
export const workloadHost = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) =>
  `${workloadServiceIds[workload]}-${config.projectNumber}.${config.region}.run.app`;

export const workloadUrl = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => `https://${workloadHost(config, workload)}`;

/** The runtime identity a workload's revisions run as. */
export const workloadRuntimeServiceAccount = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => {
  switch (workload) {
    case "api":
      return config.serviceAccounts.apiRuntime;
    case "tasks-worker":
      return config.serviceAccounts.tasksWorkerRuntime;
    case "scheduler-worker":
      return config.serviceAccounts.schedulerWorkerRuntime;
  }
};

/**
 * The OIDC audience for a private worker: its deterministic HTTPS URL, which
 * Cloud Run accepts natively and which differs per worker and project.
 */
export const workloadAudience = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => workloadUrl(config, workload);

/** The image reference, pinned by digest; Cloud Run never resolves a tag. */
export const workspaceImageReference = (
  config: WorkspaceStackConfig,
  imageDigest: ImageDigest
) =>
  `${config.region}-docker.pkg.dev/${config.projectId}/${workspaceArtifactRepositoryId}/${workspaceImageName}@${imageDigest}`;

export const workspaceLabels = (config: WorkspaceStackConfig) => ({
  "deskohub-app": "workspace",
  "deskohub-stage": config.stage,
});

/** A Secret Manager secret's resource name in the stage's project. */
export const secretResourceName = (
  config: WorkspaceStackConfig,
  secretId: string
) => `projects/${config.projectId}/secrets/${secretId}`;
