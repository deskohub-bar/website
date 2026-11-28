import "@/shared/testing/workspace-test-env";

import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import vercelConfig from "@/vercel.json";

const cronPaths = vercelConfig.crons.map(({ path }) => path);

test("schedules cron routes", () => {
  expect(cronPaths).not.toHaveLength(0);
});

test.each(cronPaths)(
  "%s rejects a request without the cron secret",
  async (path) => {
    const { GET } = await import(`@/app${path}/route`);
    expect(GET).toBeInstanceOf(Function);

    const response: unknown = await GET(
      new Request(`https://workspace.test${path}`)
    );
    assert(response instanceof Response);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"Unauthorized"}');
  }
);
