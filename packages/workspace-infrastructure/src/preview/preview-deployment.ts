import { taggedCloudRunOrigin } from "@deskohub/workspace-cloud-run/preview-generation";
import * as Schema from "effect/Schema";
import {
  type PreviewRole,
  type PreviewTarget,
  previewCommitLabel,
  previewDatabaseSecret,
  previewGenerationLabel,
  previewNeonBranchLabel,
  previewPilot,
  previewPilotLabel,
  previewRevision,
  previewSeedRevision,
  previewServiceOrigin,
  previewTargetGeneration,
  previewTrafficTag,
  previewWorkerTag,
} from "./preview-services";

const Environment = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
  valueSource: Schema.optional(
    Schema.Struct({
      secretKeyRef: Schema.Struct({
        secret: Schema.String,
        version: Schema.String,
      }),
    })
  ),
});
export const PreviewServiceReadback = Schema.Struct({
  uri: Schema.optional(Schema.String),
  urls: Schema.optional(Schema.Array(Schema.String)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  reconciling: Schema.optional(Schema.Boolean),
  invokerIamDisabled: Schema.optional(Schema.Boolean),
  latestReadyRevision: Schema.optional(Schema.String),
  terminalCondition: Schema.optional(Schema.Struct({ state: Schema.String })),
  template: Schema.optional(
    Schema.Struct({
      revision: Schema.optional(Schema.String),
      containers: Schema.Array(
        Schema.Struct({
          image: Schema.String,
          env: Schema.optional(Schema.Array(Environment)),
        })
      ),
    })
  ),
  trafficStatuses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        revision: Schema.String,
        percent: Schema.optional(Schema.Finite),
        tag: Schema.optional(Schema.String),
        uri: Schema.optional(Schema.String),
      })
    )
  ),
});
export type PreviewServiceReadback = typeof PreviewServiceReadback.Type;
export type PreviewSnapshot = ReadonlyMap<PreviewRole, PreviewServiceReadback>;

const revisionName = (value: string | undefined) => value?.split("/").at(-1);

export const resolvePreviewServiceOrigin = (
  role: PreviewRole,
  service: PreviewServiceReadback | undefined
) => {
  const origin = previewServiceOrigin(role);
  return service?.uri === origin || service?.urls?.includes(origin)
    ? origin
    : undefined;
};

export const canResumePreviewSeed = (services: PreviewSnapshot) =>
  Array.from(services).every(
    ([role, service]) =>
      !service.reconciling &&
      !service.invokerIamDisabled &&
      !service.labels?.[previewPilotLabel] &&
      revisionName(service.template?.revision) === previewSeedRevision(role)
  );

const environmentOf = (service: PreviewServiceReadback) =>
  new Map(
    service.template?.containers[0]?.env?.map((item) => [item.name, item.value])
  );

export const requireOwnedServices = (
  services: PreviewSnapshot,
  pr: string,
  neonBranch: string
) => {
  for (const [role, service] of services) {
    const owner = service.labels?.[previewPilotLabel];
    if (service.reconciling || service.invokerIamDisabled) {
      throw new Error(
        "Preview service is changing or its invoker check is disabled"
      );
    }
    if (
      !owner &&
      revisionName(service.template?.revision) === previewSeedRevision(role)
    ) {
      continue;
    }
    if (
      owner !== previewPilot(pr) ||
      service.labels?.[previewNeonBranchLabel] !== neonBranch
    ) {
      throw new Error(
        "Preview service is owned by a different pilot or Neon branch"
      );
    }
  }
};

type Candidate = Omit<PreviewTarget, "databaseVersion">;

/** Reuse a version from a partial apply or exact retry, and refuse drift. */
export const versionFromAppliedCandidate = (
  services: PreviewSnapshot,
  target: Candidate
) => {
  const versions = new Set<string>();
  for (const service of services.values()) {
    const environment = environmentOf(service);
    if (
      environment.get("WORKSPACE_PREVIEW_COMMIT_SHA") !==
        target.binding.commitSha ||
      environment.get("WORKSPACE_PREVIEW_DEPLOYMENT_ID") !==
        target.binding.deploymentId
    ) {
      continue;
    }
    const version = environment.get("WORKSPACE_PREVIEW_DATABASE_VERSION");
    if (
      !version ||
      service.template?.containers[0]?.image !== target.image ||
      environment.get("WORKSPACE_PREVIEW_BRANCH_TAG") !==
        target.binding.branchTag ||
      environment.get("WORKSPACE_PREVIEW_DATABASE_ENDPOINT") !==
        target.binding.databaseEndpoint ||
      environment.get("WORKSPACE_PREVIEW_SIGNING_VERSION") !==
        target.signingVersion
    ) {
      throw new Error(
        "An immutable deployment already has a different backend candidate"
      );
    }
    versions.add(version);
  }
  if (versions.size > 1) {
    throw new Error(
      "The deployed candidate has inconsistent database versions"
    );
  }
  return versions.values().next().value;
};

export const verifyPreviewRouting = (
  role: PreviewRole,
  service: PreviewServiceReadback | undefined,
  target: PreviewTarget
) => {
  const revision = previewRevision(role, target);
  const tag = previewTrafficTag(role, target);
  const traffic = service?.trafficStatuses ?? [];
  const [defaultTraffic] = traffic.filter((entry) => (entry.percent ?? 0) > 0);
  const [taggedTraffic] = traffic.filter((entry) => entry.tag === tag);
  const origin = resolvePreviewServiceOrigin(role, service);
  const deterministicTagOrigin = origin && taggedCloudRunOrigin(origin, tag);
  const taggedUri = taggedTraffic?.uri;
  const reportedTagOrigin =
    service?.uri && taggedCloudRunOrigin(service.uri, tag);
  const container = service?.template?.containers[0];
  const databaseReference = container?.env?.find(
    (item) => item.name === "DATABASE_URL"
  )?.valueSource?.secretKeyRef;
  if (
    !service ||
    service.reconciling ||
    service.invokerIamDisabled ||
    service.terminalCondition?.state !== "CONDITION_SUCCEEDED" ||
    service.labels?.[previewGenerationLabel] !==
      previewTargetGeneration(target) ||
    service.labels[previewCommitLabel] !== target.binding.commitSha ||
    service.labels[previewNeonBranchLabel] !== target.neonBranch ||
    revisionName(service.latestReadyRevision) !== revision ||
    container?.image !== target.image ||
    traffic.length !== 2 ||
    defaultTraffic?.percent !== 100 ||
    revisionName(defaultTraffic.revision) !== previewSeedRevision(role) ||
    taggedTraffic?.percent ||
    revisionName(taggedTraffic?.revision) !== revision ||
    !deterministicTagOrigin ||
    !taggedUri ||
    (taggedUri !== deterministicTagOrigin && taggedUri !== reportedTagOrigin)
  ) {
    throw new Error(
      `Generation did not converge on the ${role} preview service`
    );
  }
  if (
    environmentOf(service).get("WORKSPACE_PREVIEW_WORKER_ORIGIN") !==
      taggedCloudRunOrigin(target.workerBaseOrigin, previewWorkerTag(target)) ||
    (role === "api" &&
      (databaseReference?.secret !== previewDatabaseSecret ||
        databaseReference.version !== target.databaseVersion))
  ) {
    throw new Error(
      `Generation is bound to an unexpected ${role} destination or database`
    );
  }
};

export const previewSnapshotFence = (services: PreviewSnapshot) =>
  JSON.stringify(
    Array.from(services, ([role, service]) => [
      role,
      service.labels?.[previewGenerationLabel] ?? null,
      revisionName(service.template?.revision) ?? null,
      service.trafficStatuses?.map(({ revision, tag, percent }) => [
        revision,
        tag,
        percent,
      ]),
    ])
  );
