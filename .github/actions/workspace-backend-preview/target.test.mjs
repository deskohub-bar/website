import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { targetFromE2EEnvironment } from "./e2e-target.mjs";
import { backendGenerationRequired } from "./paths.mjs";
import {
  classifyPullRequestTarget,
  dispatchTarget,
  pooledNeonUrl,
  pullRequestTarget,
  stageNeonConnection,
  verifyApproval,
  verifyVercel,
} from "./target.mjs";

const sha = "b".repeat(40);
const ref = "feat/backend-pilot";
const deploymentId = "dpl_example";
const repository = { id: 1015951989, owner: { id: 361691508 } };
const projectId = "prj_7FliQBcbBiBwGaO2JLrigicnXCRd";
const teamId = "team_MgMQ4MEWijWnYa1R48C2JU5e";
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "Deskohub/deskohub-site",
  GITHUB_REPOSITORY_ID: String(repository.id),
  GITHUB_REPOSITORY_OWNER_ID: String(repository.owner.id),
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_WORKFLOW_REF:
    "Deskohub/deskohub-site/.github/workflows/workspace-backend-preview.yml@refs/heads/main",
  GITHUB_WORKFLOW_SHA: "a".repeat(40),
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "89",
  GITHUB_RUN_ATTEMPT: "1",
  PREVIEW_OPERATION: "deploy",
  PR_NUMBER: "45",
  PILOT_PR_NUMBER: "45",
  GIT_SHA: sha,
  VERCEL_DEPLOYMENT_ID: deploymentId,
  GH_TOKEN: "stub-github-token",
  VERCEL_TOKEN: "stub-vercel-token",
};

const target = dispatchTarget(env);
const pr = {
  number: 45,
  state: "open",
  draft: false,
  user: { type: "User", login: "developer" },
  base: { repo: repository, ref: "main", sha: "a".repeat(40) },
  head: { repo: repository, ref, sha },
  changed_files: 1,
};

function gitHub({
  record = pr,
  files = [
    [{ filename: "packages/workspace-rpc/package.json", status: "modified" }],
  ],
  branchSha = sha,
} = {}) {
  return async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com");
    switch (url.pathname) {
      case "/repos/Deskohub/deskohub-site/pulls/45":
        return Response.json(record);
      case "/repos/Deskohub/deskohub-site/pulls/45/files":
        return Response.json(files[Number(url.searchParams.get("page")) - 1]);
      case "/repos/Deskohub/deskohub-site/git/ref/heads/feat/backend-pilot":
        return Response.json({
          ref: `refs/heads/${ref}`,
          object: { type: "commit", sha: branchSha },
        });
      default:
        assert.fail("Unexpected GitHub lookup");
    }
  };
}

test("requires a protected main dispatch by the fixed repository for the configured PR", () => {
  assert.equal(target.sha, sha);
  for (const change of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY_OWNER_ID: "123" },
    { GITHUB_REPOSITORY_ID: "123" },
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/heads/feat/wrong" },
    { GITHUB_WORKFLOW_REF: `${env.GITHUB_WORKFLOW_REF}-wrong` },
    { GITHUB_WORKFLOW_SHA: sha },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GIT_SHA: sha.slice(0, 12) },
    { PILOT_PR_NUMBER: "" },
    { PR_NUMBER: "46" },
    { VERCEL_DEPLOYMENT_ID: "https://other.example" },
  ]) {
    assert.throws(() => dispatchTarget({ ...env, ...change }));
  }
});

test("includes provider packages and root build inputs in the shared classifier", () => {
  assert.equal(
    backendGenerationRequired(["apps/deskohub-workspace/app/page.tsx"]),
    false,
  );
  for (const path of [
    "apps/deskohub-workspace-api/Dockerfile",
    "apps/deskohub-workspace/package.json",
    "packages/dotypos/src/client.ts",
    "packages/new/package.json",
    "bun.lock",
    "package.json",
    "turbo.json",
    ".dockerignore",
    "patches/name.patch",
  ])
    assert.equal(backendGenerationRequired([path]), true);
  for (const paths of [
    [],
    [""],
    ["/packages/file"],
    ["apps/deskohub-workspace/../file"],
    ["apps\\file"],
  ]) {
    assert.throws(
      () => backendGenerationRequired(paths),
      /canonical changed paths/,
    );
  }
});

test("serializes every pilot operation without replacing a pending cleanup or saving a cache", () => {
  const yaml = readFileSync(
    new URL("../../workflows/workspace-backend-preview.yml", import.meta.url),
    "utf8",
  );
  assert.match(yaml, /^cache-mode: read$/m);
  assert.match(
    yaml,
    /^concurrency:\n {2}group: workspace-backend-preview\n {2}cancel-in-progress: false\n {2}queue: max\n/m,
  );
  assert.match(
    yaml,
    /if: always\(\) && steps\.lease\.outcome != '' && steps\.lease\.outcome != 'skipped'/,
  );
});

test("requires recorded approval by an individual configured for the exact environment", async () => {
  const approvalEnvironment = { id: 9, name: "workspace-backend-preview" };
  const reviewer = { type: "User", id: 7 };
  const rules = [
    { type: "required_reviewers", reviewers: [{ type: "User", reviewer }] },
  ];
  const approval = {
    state: "approved",
    user: reviewer,
    environments: [approvalEnvironment],
  };
  const request =
    ({ protection_rules = rules, reviews = [approval] } = {}) =>
    async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/environments/workspace-backend-preview")) {
        return Response.json({ ...approvalEnvironment, protection_rules });
      }
      assert.ok(path.endsWith("/actions/runs/89/approvals"));
      return Response.json(reviews);
    };
  await verifyApproval(env, request());
  await assert.rejects(
    verifyApproval({ ...env, GITHUB_RUN_ATTEMPT: "2" }, request()),
    /fresh workflow dispatch/,
  );
  for (const change of [
    { protection_rules: [] },
    { reviews: [] },
    { reviews: [{ ...approval, state: "rejected" }] },
    { reviews: [{ ...approval, user: { ...reviewer, id: 8 } }] },
    {
      reviews: [
        { ...approval, environments: [{ ...approvalEnvironment, id: 10 }] },
      ],
    },
  ])
    await assert.rejects(
      verifyApproval(env, request(change)),
      /recorded approval/,
    );
});

test("requires a complete path list and counts both sides of renames", async () => {
  assert.equal(await pullRequestTarget(target, env, gitHub(), true), ref);
  const frontendFile = "apps/deskohub-workspace/new.ts";
  await assert.rejects(
    pullRequestTarget(
      target,
      env,
      gitHub({
        files: [[{ filename: frontendFile, status: "modified" }]],
      }),
      true,
    ),
    /no backend changes/,
  );
  assert.equal(
    await pullRequestTarget(
      target,
      env,
      gitHub({
        files: [
          [
            {
              filename: frontendFile,
              status: "renamed",
              previous_filename: "packages/workspace-backend/old.ts",
            },
          ],
        ],
      }),
      true,
    ),
    ref,
  );
  await assert.rejects(
    pullRequestTarget(
      target,
      env,
      gitHub({
        record: { ...pr, changed_files: 2 },
      }),
      true,
    ),
    /incomplete/,
  );
  const frontendPage = Array.from({ length: 100 }, (_, index) => ({
    filename: `${frontendFile}-${index}`,
  }));
  assert.equal(
    await pullRequestTarget(
      target,
      env,
      gitHub({
        record: { ...pr, changed_files: 101 },
        files: [frontendPage, [{ filename: "bun.lock", status: "modified" }]],
      }),
      true,
    ),
    ref,
  );
});

test("classifies an eligible frontend-only preview without admitting a backend build", async () => {
  const frontend = gitHub({ files: [[{ filename: "apps/deskohub-workspace/new.ts", status: "modified" }]] });
  assert.deepEqual(await classifyPullRequestTarget(target, env, frontend), { headRef: ref, backendRequired: false });
  assert.deepEqual(await classifyPullRequestTarget(target, env, gitHub()), { headRef: ref, backendRequired: true });
});

test("rejects stale, fork, draft and bot heads for deploy", async () => {
  for (const change of [
    { head: { ...pr.head, sha: "c".repeat(40) } },
    { head: { ...pr.head, repo: { ...repository, id: 1 } } },
    { base: { ...pr.base, ref: "release" } },
    { head: { ...pr.head, ref: "HEAD" } },
    { head: { ...pr.head, ref: "e2e/nightly" } },
    { draft: true },
    { state: "closed" },
    { user: { login: "bot[bot]", type: "Bot" } },
  ]) {
    await assert.rejects(
      pullRequestTarget(target, env, gitHub({ record: { ...pr, ...change } })),
    );
  }
  await assert.rejects(
    pullRequestTarget(target, env, gitHub({ branchSha: "c".repeat(40) })),
    /branch no longer/,
  );
  await assert.rejects(
    pullRequestTarget(target, { ...env, GIT_REF: "other" }, gitHub()),
    /eligible internal/,
  );
});

test("cleanup requires the closed current PR head and allows the branch to have been deleted", async () => {
  const cleanup = dispatchTarget({
    ...env,
    PREVIEW_OPERATION: "cleanup",
    VERCEL_DEPLOYMENT_ID: "",
  });
  const request = async (input) => {
    assert.ok(new URL(input).pathname.endsWith("/pulls/45"));
    return Response.json({ ...pr, state: "closed", draft: true });
  };
  assert.equal(await pullRequestTarget(cleanup, env, request), ref);
  await assert.rejects(pullRequestTarget(cleanup, env, gitHub()));
  await assert.rejects(
    pullRequestTarget({ ...cleanup, sha: "c".repeat(40) }, env, request),
  );
});

const host = "workspace-example.vercel.app";
const deployment = {
  id: deploymentId,
  projectId,
  ownerId: teamId,
  target: null,
  public: false,
  readyState: "READY",
  url: host,
  gitSource: { type: "github", repoId: repository.id, ref, sha },
};
const project = {
  id: projectId,
  accountId: teamId,
  ssoProtection: { deploymentType: "preview" },
};
const deploymentEnvironment = "Preview – deskohub-workspace-site";

function vercel({
  record = deployment,
  settings = project,
  registered = true,
  alias,
  paginate = false,
  incomplete = false,
  newerState,
} = {}) {
  return async (input, options) => {
    const url = new URL(input);
    if (url.origin === "https://api.vercel.com") {
      assert.equal(url.searchParams.get("teamId"), teamId);
      assert.equal(options.headers.Authorization, `Bearer ${env.VERCEL_TOKEN}`);
      if (url.pathname === `/v13/deployments/${deploymentId}` || url.pathname === `/v13/deployments/${host}`) {
        assert.equal(url.searchParams.get("withGitRepoInfo"), "true");
        return Response.json(record);
      }
      if (url.pathname === `/v4/aliases/${host}`) {
        return alias
          ? Response.json(alias)
          : new Response(null, { status: 404 });
      }
      assert.equal(url.pathname, `/v9/projects/${projectId}`);
      return Response.json(settings);
    }
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(options.headers.Authorization, `Bearer ${env.GH_TOKEN}`);
    assert.equal(url.searchParams.get("per_page"), "100");
    if (paginate && url.searchParams.get("page") === "1") {
      return Response.json(
        Array.from({ length: incomplete ? 99 : 100 }, (_, id) => ({ id })),
        {
          headers: {
            link: '<https://api.github.com/repositories/1015951989/fixed?page=2>; rel="next"',
          },
        },
      );
    }
    assert.equal(url.searchParams.get("page"), paginate ? "2" : "1");
    if (url.pathname.endsWith("/deployments")) {
      assert.equal(url.searchParams.get("sha"), sha);
      return Response.json([
        {
          id: 67,
          creator: { login: "vercel[bot]" },
          sha,
          environment: deploymentEnvironment,
        },
      ]);
    }
    assert.ok(url.pathname.endsWith("/deployments/67/statuses"));
    const status = {
      id: 89,
      created_at: "2026-11-27T00:00:00Z",
      creator: { login: "vercel[bot]" },
      state: "success",
      environment_url: registered
        ? `https://${host}`
        : "https://other.vercel.app",
    };
    return Response.json(
      newerState
        ? [status, { ...status, id: 90, state: newerState }]
        : [status],
    );
  };
}

test("matches the exact READY, protected Vercel Git preview by ID, project, repo, ref and SHA", async () => {
  const previewEnv = { ...env, GIT_REF: ref };
  await verifyVercel(target, previewEnv, vercel());
  for (const change of [
    { id: "dpl_other" },
    { projectId: "prj_other" },
    { ownerId: "team_other" },
    { target: "production" },
    { public: true },
    { readyState: "BUILDING" },
    { gitSource: { ...deployment.gitSource, repoId: 1 } },
    { gitSource: { ...deployment.gitSource, ref: "other" } },
    { gitSource: { ...deployment.gitSource, sha: "c".repeat(40) } },
    { url: "workspace-git-branch.vercel.app" },
  ])
    await assert.rejects(
      verifyVercel(
        target,
        previewEnv,
        vercel({ record: { ...deployment, ...change } }),
      ),
    );
  await assert.rejects(
    verifyVercel(
      target,
      previewEnv,
      vercel({ settings: { ...project, ssoProtection: null } }),
    ),
    /Authentication/,
  );
  await assert.rejects(
    verifyVercel(
      target,
      previewEnv,
      vercel({
        alias: {
          alias: host,
          deploymentId,
          protectionBypass: { stub: { scope: "alias-protection-override" } },
        },
      }),
    ),
    /protection exception/,
  );
  await assert.rejects(
    verifyVercel(target, previewEnv, vercel({ registered: false })),
    /deployment record/,
  );
});

test("looks up the E2E origin and confirms its exact deployment ID", async () => {
  assert.throws(() => targetFromE2EEnvironment({ TARGET_SHA: sha }), /validated pilot PR/);
  const originTarget = { ...targetFromE2EEnvironment({ TARGET_SHA: sha, PR_NUMBER: "45" }), expectedOrigin: `https://${host}` };
  const environment = { ...env, GIT_REF: ref };
  assert.deepEqual(await verifyVercel(originTarget, environment, vercel()), { deploymentId });
  await assert.rejects(
    verifyVercel(originTarget, environment, vercel({ record: { ...deployment, url: "wrong-preview.vercel.app" } })),
    /origin other than the exact E2E target/
  );
});

test("finds the exact deployment and status on later pages and rejects a superseded success", async () => {
  const previewEnv = { ...env, GIT_REF: ref };
  await verifyVercel(target, previewEnv, vercel({ paginate: true }));
  await assert.rejects(
    verifyVercel(
      target,
      previewEnv,
      vercel({ paginate: true, incomplete: true }),
    ),
    /incomplete deployment page/,
  );
  await assert.rejects(
    verifyVercel(
      target,
      previewEnv,
      vercel({ paginate: true, newerState: "inactive" }),
    ),
    /current successful/,
  );
});

test("resolves only the approved non-default Neon branch and its pooled URI", async () => {
  const branchId = "br-preview-pilot";
  const uri =
    "postgresql://neondb_owner:synthetic-password@ep-preview-pooler.eu-west-1.aws.neon.tech/neondb?sslmode=require";
  const previewEnv = {
    ...env,
    GIT_REF: ref,
    APPROVED_NEON_BRANCH_ID: branchId,
    NEON_PROJECT_ID: "preview-project",
    NEON_API_KEY: "stub-neon-key",
  };
  const endpointId = "ep-preview";
  const endpoint = {
    id: endpointId,
    type: "read_write",
    branch_id: branchId,
    project_id: previewEnv.NEON_PROJECT_ID,
    host: "ep-preview.eu-west-1.aws.neon.tech",
  };
  const request =
    (change, endpoints = [endpoint], connectionUri = uri) =>
    async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, "https://console.neon.tech");
      assert.equal(
        options.headers.Authorization,
        `Bearer ${previewEnv.NEON_API_KEY}`,
      );
      if (url.pathname.endsWith(`/branches/${branchId}`)) {
        return Response.json({
          branch: {
            id: branchId,
            project_id: previewEnv.NEON_PROJECT_ID,
            name: `preview/${ref}`,
            default: false,
            primary: false,
            parent_id: "br-main",
            ...change,
          },
        });
      }
      if (url.pathname.endsWith(`/branches/${branchId}/endpoints`))
        return Response.json({ endpoints });
      assert.ok(url.pathname.endsWith("/connection_uri"));
      assert.equal(url.searchParams.get("branch_id"), branchId);
      assert.equal(url.searchParams.get("endpoint_id"), endpointId);
      assert.equal(url.searchParams.get("pooled"), "true");
      return Response.json({ uri: connectionUri });
    };
  assert.deepEqual(await pooledNeonUrl(previewEnv, request()), {
    branchId,
    uri,
  });
  for (const change of [
    { id: "br-other" },
    { project_id: "other-project" },
    { name: "preview/other" },
    { default: true },
    { primary: true },
    { parent_id: null },
  ]) {
    await assert.rejects(
      pooledNeonUrl(previewEnv, request(change)),
      /approved non-default/,
    );
  }
  await assert.rejects(
    pooledNeonUrl(
      previewEnv,
      request({}, [{ ...endpoint, type: "read_only" }]),
    ),
    /unique read-write/,
  );
  await assert.rejects(
    pooledNeonUrl(previewEnv, request({}, [endpoint, endpoint])),
    /unique read-write/,
  );
  await assert.rejects(
    pooledNeonUrl(
      previewEnv,
      request({}, [endpoint], uri.replace("ep-preview", "ep-other")),
    ),
    /invalid pooled/,
  );
});

test("writes the masked pooled URI only to a private file", () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-neon-test-"));
  const output = join(directory, "output");
  const uri =
    "postgresql://neondb_owner:stub%2Fsecret@ep-preview-pooler.test.neon.tech/neondb";
  const logs = [];
  try {
    stageNeonConnection(
      uri,
      { RUNNER_TEMP: directory, GITHUB_OUTPUT: output },
      (command) => logs.push(command),
    );
    const line = readFileSync(output, "utf8");
    assert.match(line, /^database_file=[^\n]+\n$/);
    assert.ok(!line.includes("stub"));
    const file = line.trim().slice("database_file=".length);
    assert.equal(readFileSync(file, "utf8"), uri);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(logs, [
      `::add-mask::${uri.replace("%", "%25")}`,
      "::add-mask::stub%252Fsecret",
      "::add-mask::stub/secret",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
