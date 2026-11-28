import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import { WorkspaceAdminApi } from "@deskohub/workspace-admin-api";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApi } from "effect/http-api";
import { NextRequest } from "next/server";
import { toWorkspaceWebHandler } from "@/shared/backend/workspace-effect";

let handleApiRequest: (request: Request) => Promise<Response>;

mock.module("@/features/admin-cli/workspace-admin-api.server", () => ({
  handleWorkspaceAdminApiRequest: (request: Request) =>
    handleApiRequest(request),
}));

const contractMethods = () => {
  const methods = new Set<string>();
  HttpApi.reflect(WorkspaceAdminApi, {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => {
      methods.add(endpoint.method);
    },
  });
  return [...methods];
};

describe("admin CLI API route", () => {
  // Next.js answers a method the route module doesn't export with 405 before
  // the API handler runs, so every method the contract uses needs an export.
  test("exports a handler for every method the admin API contract uses", async () => {
    const exported = new Set(Object.keys(await import("./route")));
    const methods = contractMethods();

    expect(methods).not.toHaveLength(0);
    const missing = methods.filter((method) => !exported.has(method));

    expect(missing).toEqual([]);
  });

  test.each([
    ["GET", "interrupted"],
    ["DELETE", "finished"],
    ["PATCH", "finished"],
    ["POST", "finished"],
    ["PUT", "finished"],
  ] as const)(
    "%s work is %s after the CLI client disconnects",
    async (method, expected) => {
      const route = await import("./route");
      const started = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      const outcome = Promise.withResolvers<"finished" | "interrupted">();
      const path = "/api/v1/cli/test-work";
      const body = method === "GET" ? undefined : "test mutation";
      handleApiRequest = toWorkspaceWebHandler(
        HttpRouter.add(
          method,
          path,
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            started.resolve(yield* Effect.orDie(request.text));
            yield* Effect.promise(() => release.promise);
            outcome.resolve("finished");
            return HttpServerResponse.text("done");
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => outcome.resolve("interrupted"))
            )
          )
        )
      );
      const client = new AbortController();
      const response = route[method](
        new NextRequest(`https://workspace.deskohub.test${path}`, {
          method,
          body,
          signal: client.signal,
        })
      );
      const answered = response.catch(() => undefined);

      const received = await Promise.race([
        started.promise,
        answered.then(() => undefined),
      ]);
      client.abort();
      release.resolve();

      expect(received).toBe(body ?? "");
      expect(await outcome.promise).toBe(expected);
      if (expected === "finished") {
        expect(await (await response).text()).toBe("done");
      }
    }
  );
});
