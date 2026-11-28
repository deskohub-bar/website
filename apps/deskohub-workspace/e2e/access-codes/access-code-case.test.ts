import { describe, expect, test } from "bun:test";
import {
  workspaceE2EAccessCodeCleanupTimeout,
  workspaceE2EAccessCodePlaywrightTimeout,
  workspaceE2ETimeouts,
} from "../timeouts";
import { selectActionReplayHeaders } from "./access-code-case";

describe("access code creation case planning", () => {
  test("allows both action barriers and the remaining cleanup after the case deadline", () => {
    const minimumCleanupTime =
      workspaceE2ETimeouts.accessCodeActionBarrier * 2 +
      workspaceE2ETimeouts.accessCodeStaleBarrier +
      workspaceE2ETimeouts.cleanupAction +
      workspaceE2ETimeouts.datasource;

    expect(workspaceE2EAccessCodeCleanupTimeout).toBeGreaterThanOrEqual(
      minimumCleanupTime
    );
    expect(workspaceE2EAccessCodePlaywrightTimeout).toBeGreaterThanOrEqual(
      workspaceE2ETimeouts.accessCodeCase + workspaceE2EAccessCodeCleanupTimeout
    );
  });

  test("keeps only action-relevant headers when replaying a captured request", () => {
    const replayHeaders = selectActionReplayHeaders({
      accept: "*/*",
      "accept-encoding": "gzip, deflate",
      authorization: "Basic c2VjcmV0",
      connection: "keep-alive",
      "content-length": "256",
      "content-type": "text/plain;charset=UTF-8",
      cookie: "_vercel_protection_bypass=secret",
      host: "deskohub-workspace-site-abc12345-deskohub.vercel.app",
      "next-action": "7f9c0e2b",
      "next-router-state-tree": "%5B%22%22%5D",
      origin: "https://deskohub-workspace-site-abc12345-deskohub.vercel.app",
      "x-vercel-protection-bypass": "secret",
    });

    expect(replayHeaders).toEqual({
      accept: "*/*",
      "accept-encoding": "gzip, deflate",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": "7f9c0e2b",
      "next-router-state-tree": "%5B%22%22%5D",
      origin: "https://deskohub-workspace-site-abc12345-deskohub.vercel.app",
    });
  });
});
