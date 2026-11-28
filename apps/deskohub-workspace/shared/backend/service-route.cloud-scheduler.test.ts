import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import {
  googleInvokerSettings,
  mockWorkerHost,
  schedulerInvoker,
  serveGoogleSigningKeys,
  tasksInvoker,
} from "@/shared/testing/google-oidc.test-utils";

const nextServer = await import("next/server");
// Outside a Next request, scheduling the telemetry flush would log a warning.
mock.module("next/server", () => ({ ...nextServer, after: () => undefined }));

const cronSecret = "test-cron-secret";
const containerHost = {
  WORKSPACE_RUNTIME_HOST: "container",
  VERCEL_ENV: "production",
  CRON_SECRET: cronSecret,
  ...googleInvokerSettings,
} as const;
const setHost = await mockWorkerHost(containerHost);

const { defineWorkspaceCron } = await import("./service-route");

const google = await serveGoogleSigningKeys();
afterAll(() => google.restore());
afterEach(() => {
  setHost(containerHost);
});

const countingCron = () => {
  let runs = 0;
  const GET = defineWorkspaceCron({
    operation: "test.cron.scheduler",
    failureMessage: "Test job failed",
    run: () =>
      Effect.sync(() => {
        runs += 1;
        return { swept: 1 };
      }),
  });
  return { GET, runs: () => runs };
};

const cronRequest = (authorization?: string) =>
  new Request("https://scheduler-worker.workspace.test/api/cron/test", {
    headers: authorization ? { authorization } : {},
  });

describe("cron routes on a container host", () => {
  test("run for the scheduler invoker's token", async () => {
    const { GET, runs } = countingCron();

    const response = await GET(
      cronRequest(`Bearer ${await google.token(schedulerInvoker)}`)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ swept: 1 });
    expect(runs()).toBe(1);
  });

  test("reject the cron secret with 401", async () => {
    const { GET, runs } = countingCron();

    const response = await GET(cronRequest(`Bearer ${cronSecret}`));

    expect(response.status).toBe(401);
    expect(runs()).toBe(0);
  });

  test("reject the tasks invoker's token for the scheduler audience with 403", async () => {
    const { GET, runs } = countingCron();

    const response = await GET(
      cronRequest(
        `Bearer ${await google.token(tasksInvoker, { aud: schedulerInvoker.audience })}`
      )
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(runs()).toBe(0);
  });

  test("reject the tasks invoker's own token with 401", async () => {
    const { GET, runs } = countingCron();

    const response = await GET(
      cronRequest(`Bearer ${await google.token(tasksInvoker)}`)
    );

    expect(response.status).toBe(401);
    expect(runs()).toBe(0);
  });

  test("reject every request without the scheduler settings", async () => {
    setHost({
      ...containerHost,
      WORKSPACE_SCHEDULER_INVOKER_EMAIL: undefined,
      WORKSPACE_SCHEDULER_AUDIENCE: undefined,
    });
    const { GET, runs } = countingCron();

    const response = await GET(
      cronRequest(`Bearer ${await google.token(schedulerInvoker)}`)
    );

    expect(response.status).toBe(401);
    expect(runs()).toBe(0);
  });

  test("reject an unauthenticated request in development too", async () => {
    setHost({
      ...containerHost,
      VERCEL_ENV: "development",
      CRON_SECRET: undefined,
    });
    const { GET, runs } = countingCron();

    const response = await GET(cronRequest());

    expect(response.status).toBe(401);
    expect(runs()).toBe(0);
  });
});

describe("cron routes on Vercel", () => {
  test("accept the cron secret and refuse a scheduler token", async () => {
    setHost({ ...containerHost, WORKSPACE_RUNTIME_HOST: undefined });
    const { GET, runs } = countingCron();

    const secret = await GET(cronRequest(`Bearer ${cronSecret}`));
    const scheduler = await GET(
      cronRequest(`Bearer ${await google.token(schedulerInvoker)}`)
    );

    expect([secret.status, scheduler.status]).toEqual([200, 401]);
    expect(runs()).toBe(1);
  });
});
