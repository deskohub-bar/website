import type { ServiceProps, TrafficTarget } from "@alchemy.run/gcp/Run";
import { sha256Hex } from "@deskohub/workspace-cloud-run/sha256";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Order from "effect/Order";
import type {
  ImageDigest,
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "../config/stack-config";
import { workspaceQueueContracts } from "../contracts/queue-contracts";
import { workspaceScheduleContracts } from "../contracts/schedule-contracts";
import { routableDeployments } from "../release/release-reconciler";
import {
  type ReleaseId,
  type ReleaseRecord,
  templateRevisionOf,
} from "../release/release-record";
import { toGcpDuration } from "./queue-declarations";
import {
  secretResourceName,
  workloadAudience,
  workloadRuntimeServiceAccount,
  workloadServiceIds,
  workspaceImageReference,
  workspaceLabels,
} from "./workload-names";

/** Secret Manager references for one workload, pinned to their versions. */
const secretEnvironment = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) =>
  config.secrets
    .filter((secret) => secret.consumers.includes(workload))
    .map((secret) => ({
      name: secret.environmentVariable,
      valueSource: {
        secretKeyRef: {
          secret: secretResourceName(config, secret.secretId),
          version: secret.version,
        },
      },
    }));

/** The port every Workspace container listens on. */
const workspaceContainerPort = 8080;

/** A worker's request timeout covers the longest handler budget it serves. */
const workerTimeout = (workload: "tasks-worker" | "scheduler-worker") =>
  toGcpDuration(
    Duration.seconds(
      Math.max(
        ...(workload === "tasks-worker"
          ? workspaceQueueContracts.map((contract) => contract.dispatchDeadline)
          : workspaceScheduleContracts.map(
              (contract) => contract.attemptDeadline
            )
        ).map(Duration.toSeconds)
      )
    )
  );

/**
 * The OIDC identity and audience a private worker accepts, the ones its
 * queue or schedule signs tokens with; the API service accepts none.
 */
const invokerEnvironment = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => {
  switch (workload) {
    case "api":
      return [];
    case "tasks-worker":
      return [
        {
          name: "WORKSPACE_TASKS_AUDIENCE",
          value: workloadAudience(config, workload),
        },
        {
          name: "WORKSPACE_TASKS_INVOKER_EMAIL",
          value: config.serviceAccounts.tasksInvoker,
        },
      ];
    case "scheduler-worker":
      return [
        {
          name: "WORKSPACE_SCHEDULER_AUDIENCE",
          value: workloadAudience(config, workload),
        },
        {
          name: "WORKSPACE_SCHEDULER_INVOKER_EMAIL",
          value: config.serviceAccounts.schedulerInvoker,
        },
      ];
  }
};

/**
 * The single container of a revision. Every service runs the same image;
 * `WORKSPACE_SERVICE_ROLE` picks the routes it mounts, so a worker never
 * serves `/rpc` and the API never serves worker paths. Telemetry goes from
 * the app to PostHog directly; no collector runs beside it.
 */
const containers = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload,
  imageDigest: ImageDigest
) => [
  {
    image: workspaceImageReference(config, imageDigest),
    ports: [{ containerPort: workspaceContainerPort }],
    env: [
      { name: "WORKSPACE_SERVICE_ROLE", value: workload },
      ...(config.stage === "sandbox"
        ? [{ name: "WORKSPACE_DEPLOYMENT_STAGE", value: config.stage }]
        : []),
      ...invokerEnvironment(config, workload),
      ...secretEnvironment(config, workload),
    ],
    // Cloud Run routes traffic to an instance only once it reports healthy.
    startupProbe: {
      httpGet: { path: "/healthz", port: workspaceContainerPort },
      periodSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 30,
    },
  },
];

/**
 * The template annotation carrying the fingerprint of the template spec,
 * so readback can tell a template declared from an older config apart.
 */
export const templateSpecAnnotation = "deskohub.workspace/template-spec";

/** The API revision template for one image, without its revision name. */
const apiTemplateSpec = (
  config: WorkspaceStackConfig,
  imageDigest: ImageDigest
) => ({
  serviceAccount: config.serviceAccounts.apiRuntime,
  timeout: "300s",
  scaling: {
    minInstanceCount: 0,
    maxInstanceCount: config.capacity.apiMaxInstances,
  },
  containers: containers(config, "api", imageDigest),
});

/**
 * A short sha256 fingerprint of the API template spec for one image. Two
 * templates with the same fingerprint may share a revision name.
 */
export const apiTemplateSpecFingerprint = (
  config: WorkspaceStackConfig,
  imageDigest: ImageDigest
) =>
  sha256Hex(JSON.stringify(apiTemplateSpec(config, imageDigest))).slice(0, 16);

/** The service annotation carrying the record's traffic generation. */
export const trafficGenerationAnnotation =
  "deskohub.workspace/traffic-generation";

/** The traffic tag that keeps a release's revision reachable by URL. */
export const releaseTrafficTag = (releaseId: ReleaseId) =>
  `release-${releaseId}`;

/** The release taking untagged traffic: the one being applied, else active. */
const servingDeployment = (record: ReleaseRecord) =>
  record.pendingApply?.target ?? record.active;

const byReleaseId = Order.mapInput(
  Order.String,
  (deployment: { readonly releaseId: ReleaseId }) => deployment.releaseId
);

/**
 * Untagged traffic goes to the serving release. The candidate and every
 * release still in its compatible window keep a zero-percent tag, so the
 * candidate can be verified before promotion and pages an older release
 * served can still reach it.
 *
 * Tagged entries are ordered by release id, not by where the record lists
 * them. Settling a traffic change moves the old active release to the end
 * of the compatible window, so the record the apply declared and the
 * settled record list the same releases in a different order. Alchemy
 * compares the traffic array in order, so an order taken from the record
 * would make the next plan report an update.
 */
export const apiTraffic = (
  record: ReleaseRecord,
  now: DateTime.Utc
): ReadonlyArray<TrafficTarget> => {
  const serving = servingDeployment(record);
  if (serving === null) {
    return [];
  }
  const tagged = Arr.sort(
    Arr.dedupeWith(
      [
        ...(record.candidate === null ? [] : [record.candidate]),
        ...routableDeployments(record, now),
      ].filter((deployment) => deployment.releaseId !== serving.releaseId),
      (left, right) => left.releaseId === right.releaseId
    ),
    byReleaseId
  );
  return [
    {
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: serving.revision,
      percent: 100,
      tag: releaseTrafficTag(serving.releaseId),
    },
    ...tagged.map((deployment) => ({
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: deployment.revision,
      percent: 0,
      tag: releaseTrafficTag(deployment.releaseId),
    })),
  ];
};

/**
 * The IAM-private API service. Its default `run.app` URL takes traffic
 * from anywhere, and Cloud Run rejects every caller without
 * `roles/run.invoker` before a request reaches the container: only the
 * frontend identity (and, in the sandbox, the deployer) holds it.
 *
 * The template is the candidate, else the revision last materialized; only
 * the very first release takes its template from the pending promotion. A
 * candidate therefore becomes a real zero-traffic revision while the active
 * one keeps serving, and promote and restore change traffic only. Nothing
 * is declared before a release serves.
 */
/**
 * The revision name and image the API template is declared with: the
 * candidate, else the materialized template under the name the record
 * declared it, else the serving release. `specFingerprint` is the spec a
 * minted name was decided for, or null for a release's own name. Null
 * before a release serves.
 */
export const declaredApiTemplate = (record: ReleaseRecord) => {
  const serving = servingDeployment(record);
  if (serving === null) {
    return null;
  }
  const template = record.candidate ?? record.materialized ?? serving;
  return {
    revision:
      template === record.materialized
        ? templateRevisionOf(record.materialized)
        : template.revision,
    imageDigest: template.imageDigest,
    specFingerprint:
      template === record.materialized
        ? (record.materialized.template?.specFingerprint ?? null)
        : null,
  };
};

export const apiServiceProps = (
  config: WorkspaceStackConfig,
  record: ReleaseRecord,
  now: DateTime.Utc
): ServiceProps | undefined => {
  const template = declaredApiTemplate(record);
  if (template === null) {
    return undefined;
  }
  const { revision } = template;
  return {
    serviceId: workloadServiceIds.api,
    location: config.region,
    labels: workspaceLabels(config),
    ingress: "INGRESS_TRAFFIC_ALL",
    invokerIamDisabled: false,
    // The frontend calls the deterministic run.app URL; declaring it keeps
    // Alchemy repairing a URL someone turned off.
    defaultUriDisabled: false,
    annotations: {
      [trafficGenerationAnnotation]: String(record.trafficGeneration),
    },
    template: {
      revision,
      annotations: {
        [templateSpecAnnotation]: apiTemplateSpecFingerprint(
          config,
          template.imageDigest
        ),
      },
      ...apiTemplateSpec(config, template.imageDigest),
    },
    traffic: [...apiTraffic(record, now)],
  };
};

/**
 * A private worker: the default run.app ingress like the API, so IAM alone
 * decides who calls it (only its own queue or schedule invoker), and a
 * custom audience distinct from every other worker.
 */
export const workerServiceProps = (
  config: WorkspaceStackConfig,
  workload: "tasks-worker" | "scheduler-worker",
  imageDigest: ImageDigest
): ServiceProps => ({
  serviceId: workloadServiceIds[workload],
  location: config.region,
  labels: workspaceLabels(config),
  ingress: "INGRESS_TRAFFIC_ALL",
  invokerIamDisabled: false,
  customAudiences: [workloadAudience(config, workload)],
  template: {
    serviceAccount: workloadRuntimeServiceAccount(config, workload),
    timeout: workerTimeout(workload),
    scaling: {
      minInstanceCount: 0,
      maxInstanceCount: config.capacity.workerMaxInstances,
    },
    containers: containers(config, workload, imageDigest),
  },
});
