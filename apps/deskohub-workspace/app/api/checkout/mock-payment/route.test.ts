import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import { env } from "@/env";
import { GET, POST } from "./route";

test.each(["nexi", "mock", "fallback"] as const)(
  "returns 404 from the hosted payment route in production with mode %s",
  async (mode) => {
    const previous = {
      VERCEL_ENV: env.VERCEL_ENV,
      WORKSPACE_PAYMENT_PROVIDER: env.WORKSPACE_PAYMENT_PROVIDER,
      VERCEL_AUTOMATION_BYPASS_SECRET: env.VERCEL_AUTOMATION_BYPASS_SECRET,
    };
    Object.assign(env, {
      VERCEL_ENV: "production",
      WORKSPACE_PAYMENT_PROVIDER: mode,
      VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-test-protection",
    });
    try {
      const url = new URL(
        "https://workspace.example.test/api/checkout/mock-payment"
      );
      url.searchParams.set(
        "paymentId",
        "mock-00000000-0000-4000-8000-000000000000"
      );
      url.searchParams.set("token", "0".repeat(64));
      const formData = mock(() =>
        Promise.reject(new Error("Body must remain unread."))
      );
      const request = Object.assign(new Request(url, { method: "POST" }), {
        formData,
      });

      expect((await GET(new Request(url))).status).toBe(404);
      expect((await POST(request)).status).toBe(404);
      expect(formData).not.toHaveBeenCalled();
    } finally {
      Object.assign(env, previous);
    }
  }
);
