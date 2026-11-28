import type { RepositoryProps } from "@alchemy.run/gcp/ArtifactRegistry";
import type { MemberProps } from "@alchemy.run/gcp/IAM";
import type { AlertPolicyProps } from "@alchemy.run/gcp/Monitoring";
import type { BucketProps } from "@alchemy.run/gcp/Storage";
import type {
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "../config/stack-config";
import {
  secretResourceName,
  workloadRuntimeServiceAccount,
  workloadServiceIds,
  workspaceArtifactRepositoryId,
  workspaceLabels,
} from "./workload-names";

/** Workspace images; tags cannot move, deployments use digests anyway. */
export const artifactRepositoryProps = (
  config: WorkspaceStackConfig
): RepositoryProps => ({
  repositoryId: workspaceArtifactRepositoryId,
  location: config.region,
  format: "DOCKER",
  description: "Workspace container images, deployed by digest.",
  labels: workspaceLabels(config),
  dockerConfig: { immutableTags: true },
});

/**
 * Mobile update assets. Versioned, uniform access, never force-destroyed
 * outside the sandbox, and written create-only by the mobile publisher
 * (`mobileUpdatesPublisherGrant`). A locked retention policy is deferred:
 * beta.87 `Storage.Bucket` exposes no retention props.
 */
export const mobileUpdatesBucketProps = (
  config: WorkspaceStackConfig
): BucketProps => ({
  bucketName: config.mobileUpdatesBucket,
  location: config.region.toUpperCase(),
  storageClass: "STANDARD",
  versioning: true,
  uniformBucketLevelAccess: true,
  forceDestroy: config.stage === "sandbox",
  labels: workspaceLabels(config),
});

/**
 * The mobile publisher may only create objects: replacing an issued object
 * name needs `storage.objects.delete`, which `objectCreator` lacks, so live
 * bytes at a published name never change.
 */
export const mobileUpdatesPublisherGrant = (
  config: WorkspaceStackConfig
): { readonly id: string; readonly props: MemberProps } => ({
  id: "MobileUpdatesPublisher",
  props: {
    kind: "storage.bucket",
    name: config.mobileUpdatesBucket,
    role: "roles/storage.objectCreator",
    member: `serviceAccount:${config.serviceAccounts.mobileUpdatesPublisher}`,
  },
});

/**
 * The mobile publisher may read an object it was refused to create: after
 * `ifGenerationMatch=0` answers HTTP 412, publishing verifies the existing
 * object instead of overwriting it. `legacyObjectReader` grants only
 * `storage.objects.get`, so the publisher still cannot list, delete or
 * replace objects.
 */
export const mobileUpdatesPublisherReadGrant = (
  config: WorkspaceStackConfig
): { readonly id: string; readonly props: MemberProps } => ({
  id: "MobileUpdatesPublisherRead",
  props: {
    kind: "storage.bucket",
    name: config.mobileUpdatesBucket,
    role: "roles/storage.legacyObjectReader",
    member: `serviceAccount:${config.serviceAccounts.mobileUpdatesPublisher}`,
  },
});

const serviceResourceName = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) =>
  `projects/${config.projectId}/locations/${config.region}/services/${workloadServiceIds[workload]}`;

export interface ServiceInvokerGrant {
  readonly id: string;
  readonly workload: WorkspaceWorkload;
  readonly props: MemberProps;
}

/**
 * Who may invoke each service, and nothing else: Cloud Tasks and Cloud
 * Scheduler each reach only their own worker, the frontend reaches only the
 * API, and in the sandbox the deployer reaches the API for the hosted
 * proof's authenticated RPC probe. No service grants `allUsers` or
 * `allAuthenticatedUsers`.
 */
export const serviceInvokerGrants = (
  config: WorkspaceStackConfig
): ReadonlyArray<ServiceInvokerGrant> => {
  const invoker = (
    id: string,
    workload: WorkspaceWorkload,
    serviceAccount: string
  ): ServiceInvokerGrant => ({
    id,
    workload,
    props: {
      kind: "run.service",
      name: serviceResourceName(config, workload),
      role: "roles/run.invoker",
      member: `serviceAccount:${serviceAccount}`,
    },
  });
  return [
    invoker(
      "TasksWorkerInvoker",
      "tasks-worker",
      config.serviceAccounts.tasksInvoker
    ),
    invoker(
      "SchedulerWorkerInvoker",
      "scheduler-worker",
      config.serviceAccounts.schedulerInvoker
    ),
    invoker(
      "FrontendApiInvoker",
      "api",
      config.serviceAccounts.frontendInvoker
    ),
    ...(config.stage === "sandbox"
      ? [invoker("DeployerApiInvoker", "api", config.serviceAccounts.deployer)]
      : []),
  ];
};

/**
 * The API reads published mobile update assets to serve them; it never
 * writes the bucket.
 */
export const mobileUpdatesApiReadGrant = (
  config: WorkspaceStackConfig
): { readonly id: string; readonly props: MemberProps } => ({
  id: "MobileUpdatesApiRead",
  props: {
    kind: "storage.bucket",
    name: config.mobileUpdatesBucket,
    role: "roles/storage.objectViewer",
    member: `serviceAccount:${config.serviceAccounts.apiRuntime}`,
  },
});

/**
 * One accessor grant per secret and consuming workload. The secrets
 * themselves are owner-provisioned; Alchemy never holds a value.
 */
export const secretAccessorGrants = (
  config: WorkspaceStackConfig
): ReadonlyArray<{
  readonly id: string;
  readonly workload: WorkspaceWorkload;
  readonly props: MemberProps;
}> =>
  config.secrets.flatMap((secret) =>
    secret.consumers.map((workload) => ({
      id: `SecretAccess-${secret.secretId}-${workload}`,
      workload,
      props: {
        kind: "secretmanager.secret",
        name: secretResourceName(config, secret.secretId),
        role: "roles/secretmanager.secretAccessor",
        member: `serviceAccount:${workloadRuntimeServiceAccount(config, workload)}`,
      },
    }))
  );

const workloadServiceFilter = (config: WorkspaceStackConfig) =>
  `resource.labels.service_name = one_of("${workloadServiceIds.api}", "${workloadServiceIds["tasks-worker"]}", "${workloadServiceIds["scheduler-worker"]}")` +
  ` AND resource.labels.location = "${config.region}"`;

/** Alert definitions for the migrated workloads (#1456, #1453). */
export const alertPolicyDeclarations = (
  config: WorkspaceStackConfig
): ReadonlyArray<{ readonly id: string; readonly props: AlertPolicyProps }> => {
  const common = {
    notificationChannels: [...config.alertNotificationChannels],
    labels: workspaceLabels(config),
    enabled: true,
  };
  return [
    {
      id: "QueueBacklogAlert",
      props: {
        ...common,
        displayName: `Workspace ${config.stage}: Cloud Tasks backlog`,
        severity: "ERROR",
        combiner: "OR",
        conditions: [
          {
            displayName: "Queue depth above 500 for 15 minutes",
            conditionThreshold: {
              filter:
                'resource.type = "cloud_tasks_queue" AND metric.type = "cloudtasks.googleapis.com/queue/depth"',
              aggregations: [
                {
                  alignmentPeriod: "300s",
                  perSeriesAligner: "ALIGN_MAX",
                },
              ],
              comparison: "COMPARISON_GT",
              thresholdValue: 500,
              duration: "900s",
            },
          },
        ],
        documentation: {
          mimeType: "text/markdown",
          content:
            "Outstanding Cloud Tasks work is above its window. Check the durable intents for the queue before re-driving.",
        },
      },
    },
    {
      id: "ServerErrorRateAlert",
      props: {
        ...common,
        displayName: `Workspace ${config.stage}: Cloud Run 5xx responses`,
        severity: "ERROR",
        combiner: "OR",
        conditions: [
          {
            displayName: "5xx responses above 1 per second for 10 minutes",
            conditionThreshold: {
              filter: `resource.type = "cloud_run_revision" AND metric.type = "run.googleapis.com/request_count" AND metric.labels.response_code_class = "5xx" AND ${workloadServiceFilter(config)}`,
              aggregations: [
                {
                  alignmentPeriod: "60s",
                  perSeriesAligner: "ALIGN_RATE",
                  crossSeriesReducer: "REDUCE_SUM",
                  groupByFields: ["resource.labels.service_name"],
                },
              ],
              comparison: "COMPARISON_GT",
              thresholdValue: 1,
              duration: "600s",
            },
          },
        ],
      },
    },
    {
      id: "SchedulerFailureAlert",
      props: {
        ...common,
        displayName: `Workspace ${config.stage}: Cloud Scheduler job failure`,
        severity: "WARNING",
        combiner: "OR",
        conditions: [
          {
            displayName: "A scheduler attempt failed",
            conditionMatchedLog: {
              filter:
                'resource.type = "cloud_scheduler_job" AND severity >= ERROR AND resource.labels.job_id =~ "^workspace-"',
            },
          },
        ],
        alertStrategy: {
          notificationRateLimit: { period: "3600s" },
          autoClose: "86400s",
        },
      },
    },
  ];
};
