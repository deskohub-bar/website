import { createHash } from "node:crypto";
import { workflowStepRunId } from "./workflow-step-runner";

const previewDigest = (url: string) =>
  createHash("sha256").update(url).digest("hex");

export const backendDeploymentId = "dpl_testPreview";
export const backendRevision = "workspace-api-preview-g-0123456789abcdef";
export const backendGeneration = "e".repeat(64);

export function backendPreviewProofFixture(
  pr: number,
  sha: string,
  origin: string,
  runtimeGeneration = backendGeneration
) {
  const target = previewDigest(
    JSON.stringify([String(pr), sha, previewDigest(origin), "email-campaigns"])
  ).slice(0, 32);
  const generation = previewDigest(
    JSON.stringify([backendDeploymentId, backendRevision, runtimeGeneration])
  ).slice(0, 32);
  const binding = `${target}.${generation}`;
  const id = Number(workflowStepRunId);
  const headSha = "0".repeat(40);
  const repo = { id: 1015951989, owner: { id: 361691508 } };
  const run = {
    id,
    run_attempt: 1,
    repository: repo,
    head_repository: repo,
    head_branch: "main",
    head_sha: headSha,
    path: ".github/workflows/workspace-e2e.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  };
  const jobs = {
    jobs: [
      {
        name: `Confirm Workspace preview ${binding}`,
        run_id: id,
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
      },
    ],
  };
  const runPath = `actions/runs/${id}`;
  const jobsPath = `${runPath}/attempts/1/jobs`;
  const status = {
    context: "Workspace backend preview",
    creator: { login: "github-actions[bot]" },
    description: `Workspace backend preview E2E passed for PR #${pr} [${generation}]`,
    target_url: `https://github.com/Deskohub/deskohub-site/${runPath}/attempts/1`,
    state: "success",
  };
  return { status, run, jobs, runPath, jobsPath };
}
