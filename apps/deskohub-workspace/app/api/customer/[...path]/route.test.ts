import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import { WorkspaceCustomerApi } from "@deskohub/workspace-customer-api";
import { HttpApi } from "effect/http-api";

mock.module("@/features/customer-api/customer-api.server", () => ({
  handleWorkspaceCustomerApiRequest: async (request: Request) =>
    Response.json({
      method: request.method,
      disconnected: request.signal.aborted,
    }),
}));

test("lets the customer API handler decide what a disconnect stops for every contract method", async () => {
  const handlers = new Map(Object.entries(await import("./route")));
  const methods = new Set<string>();
  HttpApi.reflect(WorkspaceCustomerApi, {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => {
      methods.add(endpoint.method);
    },
  });

  expect(methods.size).toBeGreaterThan(0);
  for (const method of methods) {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`Missing customer API ${method} handler`);

    const request = new Request("https://deskohub.test/api/customer", {
      method,
      signal: AbortSignal.abort(),
    });
    const response = await handler(request);
    expect(await response.json()).toEqual({ method, disconnected: true });
  }
});
