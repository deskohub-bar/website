import assert from "node:assert/strict";
import test from "node:test";
import { findPilotRunGeneration, pilotGenerationKey, pilotTargetKey } from "./run-proof.mjs";

const runUrl = "https://github.com/Deskohub/deskohub-site/actions/runs/42/attempts/2";
const runPath = "repos/Deskohub/deskohub-site/actions/runs/42";
const sha = "a".repeat(40);
const originDigest = "b".repeat(64);
const flows = "email-campaigns";
const target = pilotTargetKey("8", sha, originDigest, flows);
const generation = pilotGenerationKey("dpl_previewB", "workspace-api-preview-g-1234567890123456", "c".repeat(64));
const run = {
  id: 42,
  run_attempt: 2,
  repository: { id: 1015951989, owner: { id: 361691508 } },
  head_repository: { id: 1015951989 },
  head_branch: "main",
  head_sha: "d".repeat(40),
  path: ".github/workflows/workspace-e2e.yml@main",
  event: "repository_dispatch",
  status: "completed",
  conclusion: "success",
};
const job = {
  run_id: run.id,
  head_sha: run.head_sha,
  name: `Confirm Workspace preview ${target}.${generation}`,
  status: "completed",
  conclusion: "success",
};
const fixture = (changedRun = run, jobs = [job]) => ({
  targetUrl: runUrl,
  target,
  read(path) {
    if (path === runPath) return changedRun;
    assert.equal(path, `${runPath}/attempts/2/jobs?per_page=100`);
    return { jobs };
  },
});

test("requires a successful matching job from the current attempt on the reviewed main workflow", () => {
  assert.equal(findPilotRunGeneration(fixture()), generation);
  for (const invalid of [
    { run_attempt: 3 },
    { head_branch: "feat/pilot" },
    { event: "pull_request_target" },
    { path: ".github/workflows/other.yml@main" },
    { path: ".github/workflows/workspace-e2e.yml@feat/pilot" },
    { repository: { ...run.repository, owner: { id: 1 } } },
    { head_repository: { id: 17 } },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress", conclusion: null },
  ]) {
    assert.equal(findPilotRunGeneration(fixture({ ...run, ...invalid })), undefined);
  }
  for (const invalid of [
    [],
    [job, job],
    [{ ...job, run_id: 17 }],
    [{ ...job, head_sha: sha }],
    [{ ...job, conclusion: "skipped" }],
  ]) {
    assert.equal(findPilotRunGeneration(fixture(run, invalid)), undefined);
  }
});

test("rejects a status replay from a different PR, SHA, immutable deployment, or flow selection", () => {
  for (const key of [
    pilotTargetKey("17", sha, originDigest, flows),
    pilotTargetKey("8", "0".repeat(40), originDigest, flows),
    pilotTargetKey("8", sha, "0".repeat(64), flows),
    pilotTargetKey("8", sha, originDigest, "all"),
  ]) {
    assert.equal(findPilotRunGeneration({ ...fixture(), target: key }), undefined);
  }
  assert.equal(findPilotRunGeneration({ ...fixture(), targetUrl: runUrl.split("/attempts")[0] }), undefined);
  assert.equal(findPilotRunGeneration({ ...fixture(), targetUrl: runUrl.split("/attempts")[0], followLatest: true }), generation);
});
