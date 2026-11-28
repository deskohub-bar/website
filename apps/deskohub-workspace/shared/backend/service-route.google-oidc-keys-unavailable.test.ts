import { afterAll, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import {
  googleInvokerSettings,
  mockWorkerHost,
  schedulerInvoker,
  serveGoogleSigningKeys,
} from "@/shared/testing/google-oidc.test-utils";
import { captureWorkspaceLogs } from "@/shared/testing/workspace-telemetry.test-utils";

const workspaceLogs = captureWorkspaceLogs();
const nextServer = await import("next/server");
// Outside a Next request, scheduling the telemetry flush would log a warning.
mock.module("next/server", () => ({ ...nextServer, after: () => undefined }));

await mockWorkerHost({
  WORKSPACE_RUNTIME_HOST: "container",
  VERCEL_ENV: "production",
  ...googleInvokerSettings,
});

const { defineWorkspaceCron } = await import("@/shared/backend/service-route");

// Verification caches the first key set it fetches, so this file never lets
// Google's certificates succeed.
const google = await serveGoogleSigningKeys();
afterAll(() => google.restore());

describe("Google signing keys unavailable", () => {
  test.each([
    "server-error",
    "not-json",
    "invalid-set",
    "network-error",
  ] as const)("a %s rejects with 401 and logs an error", async (state) => {
    google.serve(state);
    workspaceLogs.reset();
    let runs = 0;
    const GET = defineWorkspaceCron({
      operation: "test.cron.keysUnavailable",
      failureMessage: "Test job failed",
      run: () =>
        Effect.sync(() => {
          runs += 1;
        }),
    });

    const response = await GET(
      new Request("https://scheduler-worker.workspace.test/api/cron/test", {
        headers: {
          authorization: `Bearer ${await google.token(schedulerInvoker)}`,
        },
      })
    );

    expect(response.status).toBe(401);
    expect(runs).toBe(0);
    expect(
      workspaceLogs
        .records()
        .filter(({ severityText }) => severityText === "error")
        .map(({ body }) => (Array.isArray(body) ? body[0] : body))
    ).toEqual(["Google signing keys are unavailable"]);
  });
});
