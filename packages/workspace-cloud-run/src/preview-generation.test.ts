import { expect, test } from "bun:test";
import {
  previewBackendBranchTag,
  previewDatabaseEndpoint,
  previewRuntimeGeneration,
  taggedCloudRunOrigin,
} from "./preview-generation";

test("derives a deterministic tag and keeps the base service as the audience", () => {
  const origin = "https://workspace-api-preview-123.europe-west1.run.app";
  const tag = previewBackendBranchTag("feature/generation");
  expect(tag).toMatch(/^b-[a-z0-9]{12}$/);
  expect(taggedCloudRunOrigin(origin, tag)).toBe(
    `https://${tag}---workspace-api-preview-123.europe-west1.run.app`
  );
  expect(taggedCloudRunOrigin(`${origin}/rpc`, tag)).toBeUndefined();
  expect(
    taggedCloudRunOrigin(`https://user@${origin.slice(8)}`, tag)
  ).toBeUndefined();
  expect(
    taggedCloudRunOrigin("https://workspace-api-preview.example.com", tag)
  ).toBeUndefined();
  expect(taggedCloudRunOrigin(origin, "../bad")).toBeUndefined();
  expect(
    taggedCloudRunOrigin(`https://${"a".repeat(53)}.run.app`, tag)
  ).toBeUndefined();
});

test("binds both Neon URL formats to one endpoint without credential material", () => {
  const domain = "c-2.eu-central-1.aws.neon.tech";
  const database = previewDatabaseEndpoint(
    `postgresql://direct:password@ep-test.${domain}/neondb`
  );
  expect(database).toMatch(/^[0-9a-f]{64}$/);
  expect(
    previewDatabaseEndpoint(
      `postgresql://pooled:another@ep-test-pooler.${domain}/neondb?sslmode=require`
    )
  ).toBe(database);
  expect(
    previewDatabaseEndpoint(`postgresql://ep-other.${domain}/neondb`)
  ).not.toBe(database);
  expect(
    previewDatabaseEndpoint("postgresql://localhost/neondb")
  ).toBeUndefined();
  for (const key of ["dbname", "host", "hostaddr", "options", "port"]) {
    expect(
      previewDatabaseEndpoint(
        `postgresql://ep-test.${domain}/neondb?${key}=other`
      )
    ).toBeUndefined();
  }
});

test("changes the generation for every immutable preview identity component", () => {
  const binding = {
    commitSha: "a".repeat(40),
    deploymentId: "dpl_abc",
    branchTag: previewBackendBranchTag("feature/a"),
    databaseEndpoint: "a".repeat(64),
  };
  const generation = previewRuntimeGeneration(binding);
  expect(previewRuntimeGeneration(binding)).toBe(generation);
  for (const changed of [
    { commitSha: "b".repeat(40) },
    { deploymentId: "dpl_def" },
    { branchTag: previewBackendBranchTag("feature/b") },
    { databaseEndpoint: "b".repeat(64) },
  ]) {
    expect(previewRuntimeGeneration({ ...binding, ...changed })).not.toBe(
      generation
    );
  }
});
