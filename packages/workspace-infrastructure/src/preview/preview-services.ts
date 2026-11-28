import type { ServiceProps } from "@alchemy.run/gcp/Run/Service";
import {
  PreviewNeonBranchId,
  PreviewRuntimeBinding,
  previewRuntimeGeneration,
  taggedCloudRunOrigin,
} from "@deskohub/workspace-cloud-run/preview-generation";
import { sha256Hex } from "@deskohub/workspace-cloud-run/sha256";
import * as Schema from "effect/Schema";

export const previewProject = "deskohub-workspace-sandbox";
const previewProjectNumber = "759037106024";
export const previewRegion = "europe-west1";
export const previewStateBucket = `${previewProject}-backend-preview-state`;
export const previewStage = "preview";
export const previewDatabaseSecret = "workspace-backend-preview-database";
export const previewSigningSecret = "workspace-backend-preview-signing";
export const previewPilotLabel = "workspace-preview-pilot";
export const previewGenerationLabel = "workspace-preview-generation";
export const previewCommitLabel = "workspace-preview-commit";
export const previewNeonBranchLabel = "workspace-preview-neon-branch";
export const previewImageRepository = `${previewRegion}-docker.pkg.dev/${previewProject}/workspace-backend-preview/backend`;

export const previewServices = {
  api: "workspace-api-preview",
  "tasks-worker": "workspace-tasks-preview",
  "scheduler-worker": "workspace-scheduler-preview",
} as const;

export type PreviewRole = keyof typeof previewServices;
export const previewServiceOrigin = (role: PreviewRole) =>
  `https://${previewServices[role]}-${previewProjectNumber}.${previewRegion}.run.app`;

export const previewRoles = [
  "tasks-worker",
  "scheduler-worker",
  "api",
] as const;

const seedImage =
  "gcr.io/cloudrun/hello@sha256:9654ebfdd31387ad4c1b79ca025ce55ed157d55abb29bdd6ec2231f754d8da0e";

const PreviewNumber = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,9}$/)
);
const PreviewImage = Schema.String.check(
  Schema.makeFilter((value) => {
    const [repository, digest, extra] = value.split("@");
    return (
      repository === previewImageRepository &&
      digest !== undefined &&
      /^sha256:[0-9a-f]{64}$/.test(digest) &&
      extra === undefined
    );
  })
);
export const PreviewCandidate = Schema.Struct({
  pr: PreviewNumber,
  binding: PreviewRuntimeBinding,
  neonBranch: PreviewNeonBranchId,
  image: PreviewImage,
  signingVersion: PreviewNumber,
  workerBaseOrigin: Schema.Literal(previewServiceOrigin("tasks-worker")),
});
export const PreviewTarget = Schema.Struct({
  ...PreviewCandidate.fields,
  databaseVersion: PreviewNumber,
});
export type PreviewTarget = typeof PreviewTarget.Type;

export const previewPilot = (pr: string) => `p${pr}`;

export const previewTargetGeneration = (target: PreviewTarget) =>
  sha256Hex(
    JSON.stringify([
      target.pr,
      previewRuntimeGeneration(target.binding),
      target.neonBranch,
      target.image,
      target.databaseVersion,
      target.signingVersion,
      target.workerBaseOrigin,
    ])
  ).slice(0, 32);

export const previewSeedRevision = (role: PreviewRole) =>
  `${previewServices[role]}-seed`;

export const previewRevision = (role: PreviewRole, target: PreviewTarget) =>
  `${previewServices[role]}-g-${previewTargetGeneration(target).slice(0, 16)}`;

export const previewWorkerTag = (target: PreviewTarget) =>
  `g-${previewTargetGeneration(target).slice(0, 16)}`;

export const previewTrafficTag = (role: PreviewRole, target: PreviewTarget) =>
  role === "api" ? target.binding.branchTag : previewWorkerTag(target);

const secretEnvironment = (name: string, secret: string, version: string) => ({
  name,
  valueSource: { secretKeyRef: { secret, version } },
});

const targetEnvironment = (role: PreviewRole, target: PreviewTarget) => [
  { name: "WORKSPACE_DEPLOYMENT_STAGE", value: "preview" },
  { name: "WORKSPACE_SERVICE_ROLE", value: role },
  { name: "WORKSPACE_PREVIEW_COMMIT_SHA", value: target.binding.commitSha },
  {
    name: "WORKSPACE_PREVIEW_DEPLOYMENT_ID",
    value: target.binding.deploymentId,
  },
  { name: "WORKSPACE_PREVIEW_BRANCH_TAG", value: target.binding.branchTag },
  { name: "WORKSPACE_PREVIEW_NEON_BRANCH_ID", value: target.neonBranch },
  {
    name: "WORKSPACE_PREVIEW_DATABASE_ENDPOINT",
    value: target.binding.databaseEndpoint,
  },
  {
    name: "WORKSPACE_PREVIEW_DATABASE_VERSION",
    value: target.databaseVersion,
  },
  {
    name: "WORKSPACE_PREVIEW_SIGNING_VERSION",
    value: target.signingVersion,
  },
  {
    name: "WORKSPACE_PREVIEW_WORKER_ORIGIN",
    value: taggedCloudRunOrigin(
      target.workerBaseOrigin,
      previewWorkerTag(target)
    ),
  },
  ...(role === "api"
    ? [
        secretEnvironment(
          "DATABASE_URL",
          previewDatabaseSecret,
          target.databaseVersion
        ),
        secretEnvironment(
          "BETTER_AUTH_SECRETS",
          previewSigningSecret,
          target.signingVersion
        ),
      ]
    : []),
];

const trafficFor = (revision: string, percent: number, tag?: string) => ({
  type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
  revision,
  percent,
  tag,
});

export const previewServiceProps = (
  role: PreviewRole,
  target?: PreviewTarget
) => {
  const serviceId = previewServices[role];
  const seed = previewSeedRevision(role);
  const labels: Record<string, string> = target
    ? {
        [previewPilotLabel]: previewPilot(target.pr),
        [previewGenerationLabel]: previewTargetGeneration(target),
        [previewCommitLabel]: target.binding.commitSha,
        [previewNeonBranchLabel]: target.neonBranch,
      }
    : {};
  return {
    serviceId,
    location: previewRegion,
    ingress: "INGRESS_TRAFFIC_ALL",
    invokerIamDisabled: false,
    labels,
    scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
    template: {
      revision: target ? previewRevision(role, target) : seed,
      labels,
      serviceAccount: `${role === "api" ? "workspace-preview-api-runtime" : "workspace-preview-worker"}@${previewProject}.iam.gserviceaccount.com`,
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      timeout: "60s",
      containers: [
        {
          image: target?.image ?? seedImage,
          env: target ? targetEnvironment(role, target) : [],
          ports: [{ containerPort: 8080 }],
          startupProbe: target
            ? { httpGet: { path: "/healthz", port: 8080 } }
            : undefined,
        },
      ],
    },
    traffic: [
      trafficFor(seed, 100),
      ...(target
        ? [
            trafficFor(
              previewRevision(role, target),
              0,
              previewTrafficTag(role, target)
            ),
          ]
        : []),
    ],
  } satisfies ServiceProps;
};
