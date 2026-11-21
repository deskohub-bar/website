import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import { env } from "@/env";
import { POST } from "./route";

test.each([
  { VERCEL_ENV: "development", WORKSPACE_PAYMENT_PROVIDER: "nexi" },
  { VERCEL_ENV: "production", WORKSPACE_PAYMENT_PROVIDER: "nexi" },
  { VERCEL_ENV: "production", WORKSPACE_PAYMENT_PROVIDER: "mock" },
  { VERCEL_ENV: "production", WORKSPACE_PAYMENT_PROVIDER: "fallback" },
  { VERCEL_ENV: "preview", WORKSPACE_PAYMENT_PROVIDER: "nexi" },
] as const)(
  "returns 404 before reading the body when mock payments are disabled",
  async (mode) => {
    const previous = {
      VERCEL_ENV: env.VERCEL_ENV,
      WORKSPACE_PAYMENT_PROVIDER: env.WORKSPACE_PAYMENT_PROVIDER,
      VERCEL_AUTOMATION_BYPASS_SECRET: env.VERCEL_AUTOMATION_BYPASS_SECRET,
    };
    Object.assign(env, mode, {
      VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-test-protection",
    });
    try {
      const json = mock(() =>
        Promise.reject(new Error("Body must remain unread."))
      );
      const request = Object.assign(
        new Request(
          "https://workspace.example.test/api/webhooks/mock-payment",
          {
            method: "POST",
            body: "{",
          }
        ),
        { json }
      );

      expect((await POST(request)).status).toBe(404);
      expect(json).not.toHaveBeenCalled();
    } finally {
      Object.assign(env, previous);
    }
  }
);
