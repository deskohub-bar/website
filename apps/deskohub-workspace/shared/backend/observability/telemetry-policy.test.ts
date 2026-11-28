import { describe, expect, test } from "bun:test";
import {
  isPostHogExportEnabled,
  workspaceMinimumLogLevel,
} from "./telemetry-policy";

describe("isPostHogExportEnabled", () => {
  test("exports production only by default", () => {
    expect(
      isPostHogExportEnabled({ deploymentEnvironment: "production" })
    ).toBe(true);
    for (const deploymentEnvironment of ["preview", "development", undefined]) {
      expect(isPostHogExportEnabled({ deploymentEnvironment })).toBe(false);
    }
  });

  test("exports any deployment that opts in", () => {
    for (const deploymentEnvironment of ["preview", "development", undefined]) {
      expect(
        isPostHogExportEnabled({ deploymentEnvironment, policy: "always" })
      ).toBe(true);
    }
  });
});

describe("workspaceMinimumLogLevel", () => {
  test("keeps production at Info", () => {
    expect(
      workspaceMinimumLogLevel({ deploymentEnvironment: "production" })
    ).toBe("Info");
  });

  test("includes Debug everywhere else", () => {
    for (const deploymentEnvironment of ["preview", "development", undefined]) {
      expect(workspaceMinimumLogLevel({ deploymentEnvironment })).toBe("Debug");
    }
  });

  test("honors an explicit level in any environment", () => {
    expect(
      workspaceMinimumLogLevel({
        deploymentEnvironment: "production",
        logLevel: "Debug",
      })
    ).toBe("Debug");
    expect(
      workspaceMinimumLogLevel({
        deploymentEnvironment: "preview",
        logLevel: "Warn",
      })
    ).toBe("Warn");
  });
});
