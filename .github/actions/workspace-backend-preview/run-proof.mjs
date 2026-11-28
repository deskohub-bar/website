import { createHash } from "node:crypto";

const repositoryId = 1015951989;
const ownerId = 361691508;
const workflowPath = /^\.github\/workflows\/workspace-e2e\.yml(?:@(?:refs\/heads\/)?main)?$/;
const integer = /^[1-9][0-9]{0,14}$/;
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const workspaceRuns = "https://github.com/Deskohub/deskohub-site/actions/runs";

const digest = (values) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);

export function pilotTargetKey(pr, sha, originDigest, flows) {
  if (!integer.test(pr) || !hex40.test(sha) || !hex64.test(originDigest) || !flows) {
    throw new Error("Invalid Workspace preview proof target");
  }
  return digest([String(pr), sha, originDigest, flows]);
}

export function pilotGenerationKey(deploymentId, revision, generation) {
  if (
    !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId) ||
    !/^workspace-api-preview-g-[0-9a-f]{16}$/.test(revision) ||
    !hex64.test(generation)
  ) {
    throw new Error("Invalid Workspace preview proof generation");
  }
  return digest([deploymentId, revision, generation]);
}

export const pilotRunUrl = (runId, attempt) => `${workspaceRuns}/${runId}/attempts/${attempt}`;

export function findPilotRunGeneration({ targetUrl, target, read, followLatest = false }) {
  const runUrl = /^https:\/\/github\.com\/Deskohub\/deskohub-site\/actions\/runs\/([1-9][0-9]{0,14})(?:\/attempts\/([1-9][0-9]{0,14}))?$/.exec(targetUrl ?? "");
  if (!runUrl || !/^[0-9a-f]{32}$/.test(target)) return undefined;

  const [, runId, requestedAttempt] = runUrl;
  if (!requestedAttempt && !followLatest) return undefined;
  const path = `repos/Deskohub/deskohub-site/actions/runs/${runId}`;
  const run = read(path);
  const attempt = String(run?.run_attempt ?? "");
  if (
    String(run?.id) !== runId ||
    !integer.test(attempt) ||
    (requestedAttempt && attempt !== requestedAttempt) ||
    run.repository?.id !== repositoryId ||
    run.repository?.owner?.id !== ownerId ||
    run.head_repository?.id !== repositoryId ||
    run.head_branch !== "main" ||
    !hex40.test(run.head_sha) ||
    !workflowPath.test(run.path) ||
    !["workflow_dispatch", "repository_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) return undefined;

  const { jobs } = read(`${path}/attempts/${attempt}/jobs?per_page=100`) ?? {};
  if (!Array.isArray(jobs)) return undefined;
  const prefix = `Confirm Workspace preview ${target}.`;
  const matches = jobs.filter((job) => typeof job?.name === "string" && job.name.startsWith(prefix));
  const [job] = matches;
  const generation = job?.name.slice(prefix.length);
  return matches.length === 1 && /^[0-9a-f]{32}$/.test(generation) &&
    String(job.run_id) === runId &&
    job.head_sha === run.head_sha &&
    job.status === "completed" &&
    job.conclusion === "success" ? generation : undefined;
}
