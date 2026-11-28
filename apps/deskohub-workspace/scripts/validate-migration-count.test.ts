import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import { readJsonFile } from "@/shared/testing/json-file.test-utils";
import { parseWorkflow, workflowStepRuns } from "./shared/workflow-contract";
import { assertValidMigrationCount } from "./validate-migration-count";

describe("assertValidMigrationCount", () => {
  test("allows at most one migration", () => {
    expect(() => assertValidMigrationCount([])).not.toThrow();
    expect(() => assertValidMigrationCount(["0001.sql"])).not.toThrow();
  });

  test("reports every migration when more than one changed", () => {
    expect(() => assertValidMigrationCount(["0001.sql", "0002.sql"])).toThrow(
      "Workspace PRs may introduce at most one Drizzle SQL migration; found 2.\n0001.sql\n0002.sql"
    );
  });
});

test("regenerates Workspace migrations in CI before accepting them", () => {
  const workflow = parseWorkflow(
    resolve(import.meta.dir, "../../../.github/workflows/workspace-tests.yml")
  );
  const turbo = readJsonFile(
    Schema.Struct({
      tasks: Schema.Struct({
        "db:generate": Schema.Struct({
          dependsOn: Schema.Array(Schema.String),
          env: Schema.Array(Schema.String),
        }),
      }),
    }),
    resolve(import.meta.dir, "../turbo.json")
  );

  expect(turbo.tasks["db:generate"].dependsOn).toContain("i18n:compile");
  expect(turbo.tasks["db:generate"].env).toEqual(
    expect.arrayContaining(["DATABASE_URL", "DATABASE_URL_UNPOOLED"])
  );

  const runs = workflowStepRuns(workflow).join("\n");
  expect(runs).toContain("bun turbo db:generate --filter=deskohub-workspace");
  expect(runs).toContain(
    "git add --intent-to-add -- packages/workspace-backend/src/db/migrations"
  );
  expect(runs).toContain(
    "git diff --exit-code -- packages/workspace-backend/src/db/migrations"
  );
});
