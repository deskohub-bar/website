import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { Predicate } from "effect";
import { handleWorkspaceAdminApiRequest } from "@/features/admin-cli/workspace-admin-api.server";
import { connectWorkspacePostgresTestDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";

const testDatabase = await connectWorkspacePostgresTestDatabase();

describe.skipIf(!testDatabase)("the CLI route on disposable Postgres", () => {
  test("refuses an OAuth access token shaped like a CLI bearer", async () => {
    // 32 random bytes in base64url: the CLI bearer's 43 characters, so
    // the CLI looks it up instead of rejecting its shape.
    const token = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32))
    ).toString("base64url");

    for (const path of ["/sessions", "/session"]) {
      const response = await handleWorkspaceAdminApiRequest(
        new Request(`https://workspace.deskohub.test/api/v1/cli${path}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      );

      expect(token).toHaveLength(43);
      const body: unknown = await response.json();
      expect([
        response.status,
        Predicate.hasProperty(body, "_tag") ? body._tag : undefined,
      ]).toEqual([401, "CliSessionUnauthorized"]);
    }
  });
});
