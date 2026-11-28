import "@/shared/testing/workspace-test-env";

import { beforeEach, expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { mockAdministratorAccess } from "@/features/administrators/server/administrator-access.test-utils";
import type { AdminPassListInput } from "@/features/passes/admin/pass-list-contract";

const access = mockAdministratorAccess("admin-pass-search");
const release = await import(
  "@/features/passes/backend/cowork-passes-release-gate"
);
const { CoworkPassesReleaseGate } = release;
let open = false;
let gateReads = 0;

mock.module("@/features/passes/backend/cowork-passes-release-gate", () => ({
  ...release,
  CoworkPassesReleaseGateForRun: Layer.unwrap(
    Effect.sync(() => {
      gateReads++;
      return CoworkPassesReleaseGate.fromDecision(open);
    })
  ),
}));

const seen: AdminPassListInput[] = [];
const page = {
  passes: [],
  total: 0,
  hasNextPage: false,
  searchIncomplete: false,
};
mock.module("@/features/passes/admin/pass-reads", () => ({
  listAdminPasses: (input: AdminPassListInput) =>
    Effect.sync(() => {
      seen.push(input);
      return page;
    }),
}));
mock.module("@/features/passes/admin/pass-page-data.server", () => ({
  adminPassReadsLayer: Layer.empty,
}));

const { POST } = await import("./route");

const request = (body: string) =>
  POST(
    new Request("https://deskohub.test/en-US/admin/passes/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );

beforeEach(() => {
  access.reset();
  open = false;
  gateReads = 0;
  seen.length = 0;
});

test("authorizes staff before evaluating the pass flag or querying", async () => {
  access.set("not-administrator");
  open = true;
  expect((await request("{}")).status).toBe(404);
  expect(gateReads).toBe(0);
  expect(seen).toEqual([]);
});

test("does not parse the private search or query when the pass flag is closed", async () => {
  expect((await request("invalid JSON")).status).toBe(404);
  expect(gateReads).toBe(1);
  expect(seen).toEqual([]);
});

test("validates filters before querying and returns a private response", async () => {
  open = true;
  expect((await request('{"status":"unsupported"}')).status).toBe(400);
  expect(seen).toEqual([]);
  const query = testEmailAddress("admin-pass-search");
  const input = { query, product: "entry-pack", page: 2 };
  const response = await request(JSON.stringify(input));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(await response.json()).toEqual(page);
  expect(seen).toEqual([input]);
});
