import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { backendGenerationRequired } from "./paths.mjs";

const repository = "Deskohub/deskohub-site";
const repositoryId = 1015951989;
const ownerId = 361691508;
const main = "refs/heads/main";
const workflowPath = ".github/workflows/workspace-backend-preview.yml";
const teamId = "team_MgMQ4MEWijWnYa1R48C2JU5e";
const projectId = "prj_7FliQBcbBiBwGaO2JLrigicnXCRd";
const deploymentEnvironment = "Preview – deskohub-workspace-site";
const approvalEnvironment = "workspace-backend-preview";

const shaPattern = /^[0-9a-f]{40}$/;
const prNumberPattern = /^[1-9][0-9]{0,8}$/;
const deploymentPattern = /^dpl_[A-Za-z0-9]{1,64}$/;
const branchIdPattern = /^br-[a-z0-9-]{1,70}$/;
const branchRefPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const projectIdPattern = /^[a-z][a-z0-9-]{0,98}[a-z0-9]$/;
const reservedRefs = new Set([
  "main",
  "HEAD",
  "e2e/nightly",
  "AUTO_MERGE",
  "BISECT_HEAD",
  "CHERRY_PICK_HEAD",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "ORIG_HEAD",
  "REBASE_HEAD",
  "REVERT_HEAD",
]);
const protectionScopes = new Set([
  "all",
  "all_except_custom_domains",
  "preview",
  "prod_deployment_urls_and_all_previews",
]);

class PreviewError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new PreviewError(message);
}

function requireFirstAttempt(env) {
  requireCondition(
    env.GITHUB_RUN_ATTEMPT === "1",
    "Start a fresh workflow dispatch for every pilot attempt.",
  );
}

export function dispatchTarget(env) {
  requireCondition(
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REPOSITORY?.toLowerCase() === repository.toLowerCase() &&
      env.GITHUB_REPOSITORY_ID === String(repositoryId) &&
      env.GITHUB_REPOSITORY_OWNER_ID === String(ownerId) &&
      env.GITHUB_REF === main &&
      env.GITHUB_REF_PROTECTED === "true" &&
      env.GITHUB_WORKFLOW_REF === `${repository}/${workflowPath}@${main}` &&
      shaPattern.test(env.GITHUB_WORKFLOW_SHA) &&
      env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA,
    "Expected the reviewed preview workflow on protected main.",
  );
  requireFirstAttempt(env);
  const { PREVIEW_OPERATION, PR_NUMBER, GIT_SHA, VERCEL_DEPLOYMENT_ID } = env;
  requireCondition(
    PREVIEW_OPERATION === "deploy" || PREVIEW_OPERATION === "cleanup",
    "Unknown preview operation.",
  );
  requireCondition(
    prNumberPattern.test(PR_NUMBER) && PR_NUMBER === env.PILOT_PR_NUMBER,
    "The pull request must match the configured pilot.",
  );
  requireCondition(
    shaPattern.test(GIT_SHA),
    "Expected a full lowercase head SHA.",
  );
  requireCondition(
    PREVIEW_OPERATION === "deploy"
      ? deploymentPattern.test(VERCEL_DEPLOYMENT_ID)
      : VERCEL_DEPLOYMENT_ID === "",
    "Deploy needs a Vercel deployment ID. Cleanup leaves it empty.",
  );
  return {
    operation: PREVIEW_OPERATION,
    number: Number(PR_NUMBER),
    sha: GIT_SHA,
    deploymentId: VERCEL_DEPLOYMENT_ID,
  };
}

function canonicalRef(ref) {
  return (
    typeof ref === "string" &&
    branchRefPattern.test(ref) &&
    !reservedRefs.has(ref) &&
    !ref.startsWith("refs/") &&
    spawnSync("git", ["check-ref-format", `refs/heads/${ref}`], {
      stdio: "ignore",
    }).status === 0
  );
}

function fromRepository(repo) {
  return repo?.id === repositoryId && repo.owner?.id === ownerId;
}

function github(path, token, request) {
  return request(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}

async function readJson(response, provider) {
  requireCondition(
    response.ok,
    `${provider} did not return the expected record.`,
  );
  return response.json();
}

export async function verifyApproval(env, request = fetch) {
  // GitHub approval history is scoped to the run, with no attempt identifier.
  requireFirstAttempt(env);
  requireCondition(
    env.GH_TOKEN && /^[1-9][0-9]{0,18}$/.test(env.GITHUB_RUN_ID),
    "The trusted workflow run and its GitHub token are required.",
  );
  const get = async (path) =>
    readJson(await github(path, env.GH_TOKEN, request), "GitHub");
  const [environment, reviews] = await Promise.all([
    get(`environments/${approvalEnvironment}`),
    get(`actions/runs/${env.GITHUB_RUN_ID}/approvals`),
  ]);
  const reviewers = environment.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  )?.reviewers;
  requireCondition(
    environment.name === approvalEnvironment &&
      Number.isSafeInteger(environment.id) &&
      Array.isArray(reviewers) &&
      Array.isArray(reviews) &&
      reviews.some(
        (review) =>
          review.state === "approved" &&
          review.user?.type === "User" &&
          reviewers.some(
            (entry) =>
              entry.type === "User" && entry.reviewer?.id === review.user.id,
          ) &&
          review.environments?.some(
            (entry) =>
              entry.id === environment.id && entry.name === approvalEnvironment,
          ),
      ),
    "The pilot requires a recorded approval by a configured environment owner.",
  );
}

async function* githubPages(path, token, request) {
  const separator = path.includes("?") ? "&" : "?";
  const pageSize = 100;
  for (let page = 1; page <= 100; page += 1) {
    const response = await github(
      `${path}${separator}per_page=${pageSize}&page=${page}`,
      token,
      request,
    );
    const values = await readJson(response, "GitHub");
    requireCondition(
      Array.isArray(values) && values.length <= pageSize,
      "GitHub returned an invalid deployment page.",
    );
    // The URL in a Link header can use GitHub's numeric repository route.
    // Request the next page through the fixed original endpoint instead.
    const hasNext = /;\s*rel="next"/.test(response.headers.get("link") ?? "");
    requireCondition(
      !hasNext || values.length === pageSize,
      "GitHub returned an incomplete deployment page.",
    );
    yield* values;
    if (!hasNext && values.length < pageSize) return;
  }
  throw new PreviewError(
    "GitHub did not return a complete deployment history.",
  );
}

async function readPullRequestTarget(
  target,
  env,
  request = fetch,
  checkPaths = false,
) {
  requireCondition(env.GH_TOKEN, "GitHub token is missing.");
  const pull = `pulls/${target.number}`;
  const get = async (path) =>
    readJson(await github(path, env.GH_TOKEN, request), "GitHub");
  const readPull = async () => {
    const pr = await get(pull);
    requireCondition(
      pr.number === target.number &&
        pr.state === (target.operation === "deploy" ? "open" : "closed") &&
        (target.operation === "cleanup" || pr.draft === false) &&
        pr.user?.type === "User" &&
        typeof pr.user.login === "string" &&
        !pr.user.login.toLowerCase().endsWith("[bot]") &&
        fromRepository(pr.base?.repo) &&
        pr.base.ref === "main" &&
        fromRepository(pr.head?.repo) &&
        pr.head.sha === target.sha &&
        pr.head.ref !== "main" &&
        canonicalRef(pr.head.ref) &&
        (env.GIT_REF === undefined || env.GIT_REF === pr.head.ref),
      "Expected an eligible internal pilot pull request at its requested head.",
    );
    return pr;
  };

  const pr = await readPull();
  let backendRequired;
  if (checkPaths && target.operation === "deploy") {
    requireCondition(
      Number.isInteger(pr.changed_files) &&
        pr.changed_files > 0 &&
        pr.changed_files <= 3000,
      "GitHub cannot return the complete pull request file list.",
    );
    const paths = [];
    const seen = new Set();
    for (let start = 0; start < pr.changed_files; start += 100) {
      const page = await get(
        `${pull}/files?per_page=100&page=${start / 100 + 1}`,
      );
      requireCondition(
        Array.isArray(page) &&
          page.length === Math.min(100, pr.changed_files - start),
        "GitHub returned an incomplete pull request file list.",
      );
      for (const file of page) {
        requireCondition(
          typeof file.filename === "string" &&
            file.filename.length > 0 &&
            !seen.has(file.filename),
          "GitHub returned an invalid pull request file list.",
        );
        seen.add(file.filename);
        paths.push(file.filename);
        if (file.status === "renamed") {
          requireCondition(
            typeof file.previous_filename === "string" &&
              file.previous_filename.length > 0,
            "GitHub omitted a renamed pull request path.",
          );
          paths.push(file.previous_filename);
        }
      }
    }
    const current = await readPull();
    requireCondition(
      current.head.ref === pr.head.ref &&
        current.base.sha === pr.base.sha &&
        current.changed_files === pr.changed_files,
      "The pull request changed while its file list was being checked.",
    );
    backendRequired = backendGenerationRequired(paths);
  }

  // A closed pull request can outlive its Git branch. Cleanup fences on the
  // closed PR's final head and the generation the deploy CLI recorded.
  if (target.operation === "deploy") {
    const ref = pr.head.ref.split("/").map(encodeURIComponent).join("/");
    const branch = await get(`git/ref/heads/${ref}`);
    requireCondition(
      branch.ref === `refs/heads/${pr.head.ref}` &&
        branch.object?.type === "commit" &&
        branch.object.sha === target.sha,
      "The Git branch no longer matches the requested head.",
    );
  }
  return { headRef: pr.head.ref, backendRequired };
}

export async function pullRequestTarget(target, env, request = fetch, checkPaths = false) {
  const result = await readPullRequestTarget(target, env, request, checkPaths);
  if (checkPaths && target.operation === "deploy") {
    requireCondition(result.backendRequired, "This pull request has no backend changes.");
  }
  return result.headRef;
}

export function classifyPullRequestTarget(target, env, request = fetch) {
  return readPullRequestTarget(target, env, request, true);
}

function vercel(path, token, request) {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", teamId);
  return request(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function verifyVercel(target, env, request = fetch) {
  requireCondition(
    env.VERCEL_TOKEN && env.GH_TOKEN,
    "Preview metadata credentials are missing.",
  );
  const expectedOrigin = URL.canParse(target.expectedOrigin ?? "")
    ? new URL(target.expectedOrigin)
    : undefined;
  requireCondition(
    target.deploymentId !== undefined
      ? deploymentPattern.test(target.deploymentId)
      : expectedOrigin !== undefined &&
          expectedOrigin.origin === target.expectedOrigin &&
          expectedOrigin.protocol === "https:" &&
          /^[a-z0-9-]+\.vercel\.app$/.test(expectedOrigin.hostname) &&
          !expectedOrigin.hostname.includes("-git-"),
    "Expected an immutable Vercel deployment ID or origin.",
  );
  const deploymentLookup = target.deploymentId ?? expectedOrigin.hostname;
  const [deployment, project] = await Promise.all([
    vercel(
      `/v13/deployments/${deploymentLookup}?withGitRepoInfo=true`,
      env.VERCEL_TOKEN,
      request,
    ).then((response) => readJson(response, "Vercel")),
    vercel(`/v9/projects/${projectId}`, env.VERCEL_TOKEN, request).then(
      (response) => readJson(response, "Vercel"),
    ),
  ]);
  requireCondition(
    deploymentPattern.test(deployment.id) &&
      (!target.deploymentId || deployment.id === target.deploymentId) &&
      deployment.projectId === projectId &&
      deployment.ownerId === teamId &&
      deployment.target === null &&
      deployment.public === false &&
      !deployment.customEnvironment &&
      deployment.readyState === "READY" &&
      deployment.gitSource?.type === "github" &&
      String(deployment.gitSource.repoId) === String(repositoryId) &&
      (deployment.gitSource.prId ?? target.number) === target.number &&
      deployment.gitSource.ref === env.GIT_REF &&
      deployment.gitSource.sha === target.sha &&
      typeof deployment.url === "string" &&
      /^[a-z0-9-]+\.vercel\.app$/.test(deployment.url) &&
      !deployment.url.includes("-git-"),
    "Vercel did not return the exact READY Git preview deployment.",
  );
  requireCondition(
    project.id === projectId &&
      project.accountId === teamId &&
      protectionScopes.has(project.ssoProtection?.deploymentType),
    "Vercel Authentication must protect Workspace previews.",
  );

  const origin = `https://${deployment.url}`;
  requireCondition(
    !target.expectedOrigin || origin === target.expectedOrigin,
    "Vercel returned an origin other than the exact E2E target.",
  );
  const aliasResponse = await vercel(
    `/v4/aliases/${deployment.url}`,
    env.VERCEL_TOKEN,
    request,
  );
  if (aliasResponse.status !== 404) {
    const alias = await readJson(aliasResponse, "Vercel");
    requireCondition(
      alias.alias === deployment.url &&
        alias.deploymentId === deployment.id &&
        !Object.values(alias.protectionBypass ?? {}).some(
          (entry) => entry?.scope === "alias-protection-override",
        ),
      "Vercel reports a protection exception or a different target for the preview URL.",
    );
  }
  const query = new URLSearchParams({
    sha: target.sha,
    environment: deploymentEnvironment,
  });
  for await (const record of githubPages(
    `deployments?${query}`,
    env.GH_TOKEN,
    request,
  )) {
    if (
      record.creator?.login !== "vercel[bot]" ||
      record.sha !== target.sha ||
      record.environment !== deploymentEnvironment ||
      !Number.isSafeInteger(record.id)
    )
      continue;
    let latest;
    for await (const status of githubPages(
      `deployments/${record.id}/statuses`,
      env.GH_TOKEN,
      request,
    )) {
      if (status.creator?.login !== "vercel[bot]") continue;
      requireCondition(
        Number.isSafeInteger(status.id) &&
          Number.isFinite(Date.parse(status.created_at)),
        "GitHub returned an invalid Vercel deployment status.",
      );
      if (
        !latest ||
        Date.parse(status.created_at) > Date.parse(latest.created_at) ||
        (status.created_at === latest.created_at && status.id > latest.id)
      )
        latest = status;
    }
    if (
      latest?.state === "success" &&
      [origin, `${origin}/`].includes(latest.environment_url)
    )
      return { deploymentId: deployment.id };
  }
  throw new PreviewError(
    "The exact Vercel preview has no current successful GitHub deployment record.",
  );
}

function neon(path, token, request) {
  return request(`https://console.neon.tech/api/v2/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).then((response) => readJson(response, "Neon"));
}

export async function verifyNeon(env, request = fetch) {
  const { NEON_PROJECT_ID, NEON_API_KEY, APPROVED_NEON_BRANCH_ID } = env;
  requireCondition(
    NEON_PROJECT_ID &&
      projectIdPattern.test(NEON_PROJECT_ID) &&
      branchIdPattern.test(APPROVED_NEON_BRANCH_ID) &&
      NEON_API_KEY,
    "An approved Neon project, branch, and preview credential are required.",
  );
  const project = `projects/${NEON_PROJECT_ID}`;
  const { branch } = await neon(
    `${project}/branches/${APPROVED_NEON_BRANCH_ID}`,
    NEON_API_KEY,
    request,
  );
  requireCondition(
    branch?.id === APPROVED_NEON_BRANCH_ID &&
      branch.project_id === NEON_PROJECT_ID &&
      branch.name === `preview/${env.GIT_REF}` &&
      branch.default === false &&
      branch.primary !== true &&
      branchIdPattern.test(branch.parent_id),
    "Neon did not return the approved non-default preview branch.",
  );
  const { endpoints } = await neon(
    `${project}/branches/${branch.id}/endpoints`,
    NEON_API_KEY,
    request,
  );
  requireCondition(
    Array.isArray(endpoints),
    "Neon did not return the preview branch endpoints.",
  );
  const writers = endpoints.filter(
    (endpoint) => endpoint.type === "read_write",
  );
  const endpoint = writers[0];
  requireCondition(
    writers.length === 1 &&
      endpoint.branch_id === branch.id &&
      endpoint.project_id === NEON_PROJECT_ID &&
      /^ep-[a-z0-9-]+$/.test(endpoint.id) &&
      typeof endpoint.host === "string" &&
      endpoint.host.startsWith(`${endpoint.id}.`) &&
      /^[a-z0-9.-]+\.neon\.tech$/.test(endpoint.host),
    "Neon did not return a unique read-write endpoint for the approved preview branch.",
  );
  return {
    branchId: branch.id,
    endpointId: endpoint.id,
    pooledHost: endpoint.host.replace(".", "-pooler."),
  };
}

export async function pooledNeonUrl(env, request = fetch) {
  const { branchId, endpointId, pooledHost } = await verifyNeon(env, request);
  const query = new URLSearchParams({
    branch_id: branchId,
    endpoint_id: endpointId,
    database_name: "neondb",
    role_name: "neondb_owner",
    pooled: "true",
  });
  const { uri } = await neon(
    `projects/${env.NEON_PROJECT_ID}/connection_uri?${query}`,
    env.NEON_API_KEY,
    request,
  );
  requireCondition(
    typeof uri === "string" && !/[\r\n]/.test(uri),
    "Neon returned an invalid pooled connection URI.",
  );
  const url = new URL(uri);
  requireCondition(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname === pooledHost &&
      url.username === "neondb_owner" &&
      url.password &&
      url.pathname === "/neondb" &&
      url.searchParams.get("sslmode") === "require" &&
      !url.hash,
    "Neon returned an invalid pooled connection URI.",
  );
  return { branchId, uri };
}

export function stageNeonConnection(uri, env, log = console.log) {
  const password = new URL(uri).password;
  for (const value of new Set([uri, password, decodeURIComponent(password)])) {
    log(
      `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  }
  const directory = mkdtempSync(join(env.RUNNER_TEMP, "workspace-neon-"));
  const file = join(directory, "connection");
  try {
    writeFileSync(file, uri, { mode: 0o600, flag: "wx" });
    appendFileSync(env.GITHUB_OUTPUT, `database_file=${file}\n`);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function mainCommand(command, env) {
  const target = dispatchTarget(env);
  switch (command) {
    case "config":
      requireCondition(
        branchIdPattern.test(env.APPROVED_NEON_BRANCH_ID),
        "The pilot Neon branch ID is missing.",
      );
      if (target.operation === "deploy") {
        requireCondition(
          env.NEON_PROJECT_ID &&
            projectIdPattern.test(env.NEON_PROJECT_ID) &&
            /^[1-9][0-9]*$/.test(env.PREVIEW_SIGNING_SECRET_VERSION),
          "The pilot Neon project or signing secret version is missing.",
        );
      }
      break;
    case "approval":
      await verifyApproval(env);
      break;
    case "resolve": {
      const ref = await pullRequestTarget(target, env, fetch, true);
      appendFileSync(env.GITHUB_OUTPUT, `head_ref=${ref}\n`);
      break;
    }
    case "recheck":
      await pullRequestTarget(target, env);
      break;
    case "vercel":
      await verifyVercel(target, env);
      break;
    case "neon-recheck":
      await verifyNeon(env);
      break;
    case "neon": {
      const { uri } = await pooledNeonUrl(env);
      stageNeonConnection(uri, env);
      break;
    }
    default:
      throw new PreviewError("Unknown preview validation command.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await mainCommand(process.argv[2], process.env);
  } catch (error) {
    // HTTP and URL parsing errors can carry a protected origin or credential.
    console.error(
      error instanceof PreviewError
        ? error.message
        : "Preview validation failed.",
    );
    process.exitCode = 1;
  }
}
