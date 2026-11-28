import { describe, expect, test } from "bun:test";
import { resolveDeploymentIdentity } from "./deployment-identity";

describe("resolveDeploymentIdentity", () => {
  test("reads Vercel's commit and deployment on Vercel", () => {
    expect(
      resolveDeploymentIdentity({
        VERCEL_GIT_COMMIT_SHA: "vercel-sha",
        VERCEL_DEPLOYMENT_ID: "dpl_synthetic",
      })
    ).toEqual({ revisionSha: "vercel-sha", deploymentId: "dpl_synthetic" });
  });

  test("names a Cloud Run rollout by its revision, not as a commit", () => {
    expect(
      resolveDeploymentIdentity({
        WORKSPACE_REVISION_SHA: "image-sha",
        K_REVISION: "workspace-00007-abc",
      })
    ).toEqual({
      revisionSha: "image-sha",
      deploymentId: "workspace-00007-abc",
    });
    expect(
      resolveDeploymentIdentity({ K_REVISION: "workspace-00007-abc" })
        .revisionSha
    ).toBeUndefined();
  });

  test("lets explicit Workspace settings override the host's", () => {
    expect(
      resolveDeploymentIdentity({
        WORKSPACE_REVISION_SHA: "workspace-sha",
        VERCEL_GIT_COMMIT_SHA: "vercel-sha",
        WORKSPACE_DEPLOYMENT_ID: "release-12",
        VERCEL_DEPLOYMENT_ID: "dpl_synthetic",
        K_REVISION: "workspace-00007-abc",
      })
    ).toEqual({ revisionSha: "workspace-sha", deploymentId: "release-12" });
  });

  test("is empty without any identity", () => {
    expect(resolveDeploymentIdentity({})).toEqual({
      revisionSha: undefined,
      deploymentId: undefined,
    });
  });
});
