import "@/shared/testing/workspace-test-env";

import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  getWorkspaceCallbackOrigin,
  resolveWorkspaceDeploymentHosts,
} from "./workspace-url.config";

const getOrigin = (environment: {
  readonly deploymentEnvironment: "development" | "preview" | "production";
  readonly deploymentUrl: string;
  readonly productionUrl?: string;
}) => Effect.runSync(getWorkspaceCallbackOrigin(environment)).origin;

test("selects the callback origin from the runtime environment", () => {
  expect(
    getOrigin({
      deploymentEnvironment: "preview",
      deploymentUrl: "preview-a.vercel.app",
    })
  ).toBe("https://preview-a.vercel.app");

  expect(
    getOrigin({
      deploymentEnvironment: "development",
      deploymentUrl: "localhost:3000",
    })
  ).toBe("http://localhost:3000");

  expect(
    getOrigin({
      deploymentEnvironment: "production",
      deploymentUrl: "ignored.vercel.app",
      productionUrl: "workspace.deskohub.cz",
    })
  ).toBe("https://workspace.deskohub.cz");
});

test("keeps Vercel's deployment, production and branch hosts without a public origin", () => {
  expect(
    resolveWorkspaceDeploymentHosts({
      VERCEL_URL: "workspace-abc.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "workspace.deskohub.cz",
      VERCEL_BRANCH_URL: "workspace-git-branch.vercel.app",
    })
  ).toEqual({
    deploymentUrl: "workspace-abc.vercel.app",
    productionUrl: "workspace.deskohub.cz",
    branchUrl: "workspace-git-branch.vercel.app",
  });
});

test("serves every callback from the public origin a container host names", () => {
  const publicOrigin = "https://workspace-preview.deskohub.invalid";
  const hosts = resolveWorkspaceDeploymentHosts({
    WORKSPACE_PUBLIC_ORIGIN: publicOrigin,
    VERCEL_URL: "ignored.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "ignored.deskohub.cz",
    VERCEL_BRANCH_URL: "ignored-git-branch.vercel.app",
  });

  expect(hosts).toEqual({
    deploymentUrl: publicOrigin,
    productionUrl: publicOrigin,
    branchUrl: undefined,
  });
  for (const deploymentEnvironment of ["preview", "production"] as const) {
    expect(
      Effect.runSync(
        getWorkspaceCallbackOrigin({ deploymentEnvironment, ...hosts })
      ).origin
    ).toBe(publicOrigin);
  }
});
