import { expect, test } from "bun:test";
import {
  previewBackendBranchTag,
  taggedCloudRunOrigin,
} from "@deskohub/workspace-cloud-run/preview-generation";
import * as Schema from "effect/Schema";
import {
  canResumePreviewSeed,
  PreviewServiceReadback,
  previewSnapshotFence,
  requireOwnedServices,
  resolvePreviewServiceOrigin,
  verifyPreviewRouting,
  versionFromAppliedCandidate,
} from "./preview-deployment";
import {
  type PreviewRole,
  type PreviewTarget,
  previewImageRepository,
  previewRevision,
  previewRoles,
  previewSeedRevision,
  previewServiceProps,
  previewServices,
  previewStateBucket,
  previewTrafficTag,
  previewWorkerTag,
} from "./preview-services";

const originFor = (role: PreviewRole) =>
  `https://${previewServices[role]}-759037106024.europe-west1.run.app`;

const a: PreviewTarget = {
  pr: "8",
  binding: {
    commitSha: "a".repeat(40),
    deploymentId: "dpl_previewA",
    branchTag: previewBackendBranchTag("feature/preview"),
    databaseEndpoint: "d".repeat(64),
  },
  neonBranch: "br-synthetic-preview",
  image: `${previewImageRepository}@sha256:${"e".repeat(64)}`,
  signingVersion: "3",
  databaseVersion: "5",
  workerBaseOrigin: originFor("tasks-worker"),
};

const b: PreviewTarget = {
  ...a,
  binding: {
    ...a.binding,
    commitSha: "b".repeat(40),
    deploymentId: "dpl_previewB",
  },
  databaseVersion: "6",
};

const readback = (
  role: PreviewRole,
  target: PreviewTarget
): PreviewServiceReadback => {
  const desired = previewServiceProps(role, target);
  const uri = originFor(role);
  return {
    uri,
    template: desired.template,
    labels: desired.labels,
    terminalCondition: { state: "CONDITION_SUCCEEDED" },
    latestReadyRevision: previewRevision(role, target),
    trafficStatuses: desired.traffic.map(({ revision, tag, percent }) => ({
      revision,
      tag,
      percent,
      uri: tag && taggedCloudRunOrigin(uri, tag),
    })),
  };
};

const snapshot = (target: PreviewTarget) =>
  new Map(previewRoles.map((role) => [role, readback(role, target)]));

test("updates the branch tag from A to B without moving untagged traffic", () => {
  expect(previewTrafficTag("api", a)).toBe(previewTrafficTag("api", b));
  expect(previewWorkerTag(a)).not.toBe(previewWorkerTag(b));
  for (const role of previewRoles) {
    const service = previewServiceProps(role, b);
    expect(service.invokerIamDisabled).toBe(false);
    expect(service.traffic).toEqual([
      expect.objectContaining({
        revision: previewSeedRevision(role),
        percent: 100,
      }),
      expect.objectContaining({
        revision: previewRevision(role, b),
        percent: 0,
      }),
    ]);
    expect(() => verifyPreviewRouting(role, readback(role, a), b)).toThrow();
    expect(() =>
      verifyPreviewRouting(role, readback(role, b), b)
    ).not.toThrow();
    const [runtimeAccount] = service.template.serviceAccount.split("@");
    expect(runtimeAccount?.length).toBeLessThanOrEqual(30);
  }
  const worker = previewServiceProps("api", b).template.containers[0]?.env.find(
    (item) => item.name === "WORKSPACE_PREVIEW_WORKER_ORIGIN"
  );
  expect(worker).toMatchObject({
    value: `https://${previewWorkerTag(b)}---workspace-tasks-preview-759037106024.europe-west1.run.app`,
  });
});

test("recovers an interrupted seed without replacing an active generation", () => {
  const seed = previewServiceProps("api");
  const services = new Map<PreviewRole, PreviewServiceReadback>([
    [
      "api",
      {
        template: seed.template,
      },
    ],
  ]);
  expect(canResumePreviewSeed(services)).toBe(true);
  services.set("api", readback("api", a));
  expect(canResumePreviewSeed(services)).toBe(false);
});

test("rejects a missing tag or a worker destination from a different generation", () => {
  const api = readback("api", b);
  const trafficStatuses = api.trafficStatuses?.filter((entry) => !entry.tag);
  expect(() =>
    verifyPreviewRouting("api", { ...api, trafficStatuses }, b)
  ).toThrow();
  const wrongDestination = {
    ...b,
    workerBaseOrigin: "https://other-123.europe-west1.run.app",
  };
  const workerEnv = previewServiceProps("api", wrongDestination).template
    .containers[0]?.env;
  expect(() =>
    verifyPreviewRouting(
      "api",
      {
        ...api,
        template: {
          revision: api.template?.revision,
          containers: [{ image: b.image, env: workerEnv }],
        },
      },
      b
    )
  ).toThrow("destination");
});

test("requires the deterministic worker URL even when Cloud Run reports a hashed primary URI", () => {
  const role = "tasks-worker";
  const uri = "https://workspace-tasks-preview-abc123-ew.a.run.app";
  const service = readback(role, b);
  const hashedReadback = Schema.decodeSync(PreviewServiceReadback)({
    ...service,
    uri,
    urls: [uri, originFor(role)],
    trafficStatuses: service.trafficStatuses?.map((entry) =>
      entry.tag
        ? { ...entry, uri: taggedCloudRunOrigin(uri, entry.tag) }
        : entry
    ),
  });
  expect(resolvePreviewServiceOrigin(role, hashedReadback)).toBe(
    originFor(role)
  );
  expect(() => verifyPreviewRouting(role, hashedReadback, b)).not.toThrow();

  const otherProject = {
    ...hashedReadback,
    urls: [uri, "https://workspace-tasks-preview-123.europe-west1.run.app"],
  };
  expect(resolvePreviewServiceOrigin(role, otherProject)).toBeUndefined();
  expect(() => verifyPreviewRouting(role, otherProject, b)).toThrow();
});

test("refuses cleanup or deploy across owners and detects a changed cleanup snapshot", () => {
  const services = snapshot(a);
  requireOwnedServices(services, a.pr, a.neonBranch);
  expect(() => requireOwnedServices(services, "99", a.neonBranch)).toThrow(
    "different pilot"
  );
  expect(() => requireOwnedServices(services, a.pr, "br-other")).toThrow(
    "different pilot"
  );
  expect(previewSnapshotFence(services)).not.toBe(
    previewSnapshotFence(snapshot(b))
  );
  expect(previewStateBucket).not.toBe(
    "deskohub-workspace-sandbox-workspace-state"
  );
});

test("recovers the pinned database version only for an equivalent exact-preview retry", () => {
  const partial = snapshot(a);
  partial.set("tasks-worker", readback("tasks-worker", b));
  expect(versionFromAppliedCandidate(partial, b)).toBe(b.databaseVersion);
  expect(versionFromAppliedCandidate(snapshot(a), b)).toBeUndefined();
  expect(() =>
    versionFromAppliedCandidate(partial, {
      ...b,
      image: `${previewImageRepository}@sha256:${"f".repeat(64)}`,
    })
  ).toThrow("different backend candidate");
});
