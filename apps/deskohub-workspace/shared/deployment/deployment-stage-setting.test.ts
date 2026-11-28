import { describe, expect, test } from "bun:test";
import { selectDeploymentStageSetting } from "./deployment-stage-setting.js";

describe("selectDeploymentStageSetting", () => {
  test("keeps Vercel's stage when no Workspace stage is set", () => {
    expect(selectDeploymentStageSetting({ VERCEL_ENV: "preview" })).toBe(
      "preview"
    );
  });

  test("prefers the Workspace stage a container host sets", () => {
    expect(
      selectDeploymentStageSetting({
        WORKSPACE_DEPLOYMENT_STAGE: "production",
        VERCEL_ENV: undefined,
      })
    ).toBe("production");
    expect(
      selectDeploymentStageSetting({
        WORKSPACE_DEPLOYMENT_STAGE: "preview",
        VERCEL_ENV: "production",
      })
    ).toBe("preview");
  });

  test("treats an empty Workspace stage as unset", () => {
    expect(
      selectDeploymentStageSetting({
        WORKSPACE_DEPLOYMENT_STAGE: "",
        VERCEL_ENV: "development",
      })
    ).toBe("development");
  });
});
