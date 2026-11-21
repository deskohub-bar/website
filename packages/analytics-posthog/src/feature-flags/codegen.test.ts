import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { PostHogProjectId } from "../identifiers";
import {
  generatePostHogFeatureFlagContract,
  generatePostHogFeatureFlagContractFromDefinitions,
  generatePostHogFeatureFlagSnapshot,
} from "./codegen";
import type { PostHogFeatureFlagDefinition } from "./definitions";

const syntheticEmail = testEmailAddress("synthetic");

const definitions: readonly PostHogFeatureFlagDefinition[] = [
  {
    key: "feature_b",
    payloads: {
      control: '{"privateValue":"must-not-be-generated"}',
    },
    variants: ["control"],
  },
  { key: "feature_a", payloads: {}, variants: [] },
];

const projectId = PostHogProjectId.make("project");

describe("generatePostHogFeatureFlagContract", () => {
  test("writes the contract and snapshot for the flags returned by PostHog", async () => {
    await withOutputFiles(async ({ contract, snapshot }) => {
      const result = await Effect.runPromise(
        generatePostHogFeatureFlagContract({
          apiKey: "synthetic-api-key",
          host: new URL("https://posthog.example"),
          outputFile: contract,
          projectId,
          snapshotFile: snapshot,
        }).pipe(respondWith(definitions))
      );

      expect(result).toEqual({ flagCount: 2, status: "updated" });
      expect(await import(contract)).toHaveProperty(
        "postHogFeatureFlags.keys",
        ["feature_a", "feature_b"]
      );
      expect(await import(snapshot)).toHaveProperty(
        "postHogFeatureFlagSnapshot.constantValues",
        { feature_a: true, feature_b: null }
      );
    });
  });
});

describe("generatePostHogFeatureFlagContractFromDefinitions", () => {
  test("reports render errors through the Effect error channel", async () => {
    await withOutputFiles(async ({ contract, snapshot }) => {
      const result = await Effect.runPromiseExit(
        generatePostHogFeatureFlagContractFromDefinitions({
          definitions: [
            { key: "duplicate", payloads: {}, variants: [] },
            { key: "duplicate", payloads: {}, variants: [] },
          ],
          outputFile: contract,
          snapshotFile: snapshot,
        })
      );

      expect(result._tag).toBe("Failure");
      expect(await Bun.file(contract).exists()).toBeFalse();
      expect(await Bun.file(snapshot).exists()).toBeFalse();
    });
  });
});

describe("generatePostHogFeatureFlagSnapshot", () => {
  test("writes snapshot values for the given contract keys", async () => {
    await withOutputFiles(async ({ snapshot }) => {
      const result = await Effect.runPromise(
        generatePostHogFeatureFlagSnapshot({
          apiKey: "synthetic-api-key",
          host: new URL("https://posthog.example"),
          keys: ["feature_a", "feature_c"],
          projectId,
          snapshotFile: snapshot,
        }).pipe(respondWith(definitions))
      );

      expect(result).toEqual({ flagCount: 2 });
      expect(await import(snapshot)).toHaveProperty(
        "postHogFeatureFlagSnapshot.constantValues",
        { feature_a: true, feature_c: null }
      );
    });
  });
});

/** Answers every PostHog request with one page of `responseDefinitions`. */
const respondWith = (
  responseDefinitions: readonly PostHogFeatureFlagDefinition[]
) =>
  Effect.provideService(
    FetchHttpClient.Fetch,
    Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            count: responseDefinitions.length,
            next: null,
            previous: null,
            results: responseDefinitions.map((definition, index) =>
              makeFeatureFlagResponse(definition, index + 1)
            ),
          }),
          { headers: { "content-type": "application/json" } }
        ),
      { preconnect: globalThis.fetch.preconnect }
    )
  );

interface OutputFiles {
  readonly contract: string;
  readonly snapshot: string;
}

const withOutputFiles = async (
  callback: (files: OutputFiles) => Promise<void>
) => {
  const directory = mkdtempSync(join(import.meta.dir, ".tmp-codegen-test-"));

  try {
    await callback({
      contract: join(directory, "contract.ts"),
      snapshot: join(directory, "snapshot.ts"),
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const makeFeatureFlagResponse = (
  definition: PostHogFeatureFlagDefinition,
  id: number
) => ({
  id,
  key: definition.key,
  filters: {
    aggregation_group_type_index: null,
    groups: [
      {
        aggregation_group_type_index: null,
        properties: [],
        rollout_percentage: 100,
      },
    ],
    multivariate:
      definition.variants.length > 0
        ? { variants: definition.variants.map((key) => ({ key })) }
        : null,
    payloads: definition.payloads,
  },
  active: true,
  archived: false,
  deleted: false,
  created_by: {
    id: 1,
    uuid: "00000000-0000-4000-8000-000000000001",
    email: syntheticEmail,
    hedgehog_config: null,
  },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_called_at: null,
  last_modified_by: {
    id: 1,
    uuid: "00000000-0000-4000-8000-000000000001",
    email: syntheticEmail,
    hedgehog_config: null,
  },
  ensure_experience_continuity: false,
  experiment_set: [],
  experiment_set_metadata: [],
  surveys: null,
  features: [],
  can_edit: true,
  usage_dashboard: 0,
  user_access_level: null,
  status: "ACTIVE",
  is_used_in_replay_settings: false,
  is_eligible_for_experiment: false,
});
