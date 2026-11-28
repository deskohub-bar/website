import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  backendDeploymentId,
  backendGeneration,
  backendPreviewProofFixture,
  backendRevision,
} from "./shared/backend-preview-proof-fixture";
import { findStepByName, parseWorkflow } from "./shared/workflow-contract";
import {
  createWorkflowStepRunner,
  fakeGh,
  type GhFixtures,
  workflowStepRepository as repository,
} from "./shared/workflow-step-runner";

const workflow = parseWorkflow(
  resolve(
    import.meta.dir,
    "../../../.github/workflows/workspace-e2e-pr-sync.yml"
  )
);
const e2eWorkflow = parseWorkflow(
  resolve(import.meta.dir, "../../../.github/workflows/workspace-e2e.yml")
);
const completionWorkflow = parseWorkflow(
  resolve(
    import.meta.dir,
    "../../../.github/workflows/workspace-backend-preview-e2e-status.yml"
  )
);
const completionJob = completionWorkflow.jobs["publish-pilot-status"];
const flowsCli = resolve(
  import.meta.dir,
  "../../../.github/actions/workspace-e2e-flows/cli.mjs"
);
const flowsPublish = resolve(
  import.meta.dir,
  "../../../.github/actions/workspace-e2e-flows/publish-status.mjs"
);
const validateJob = workflow.jobs["validate-pr-e2e-flows"];
const validateStep = findStepByName(
  workflow,
  "Validate PR description E2E flows"
);
const syncJob = workflow.jobs["sync-pr-e2e-flows"];
const syncStep = findStepByName(
  workflow,
  "Sync Workspace E2E flows with PR description"
);

const prNumber = 42;
const headSha = "a".repeat(40);
const earlierSha = "b".repeat(40);
const headRef = "feat/example";
const previewUrl = "https://deskohub-workspace-site-abc123def-team.vercel.app";

const { cleanup, runStep } = createWorkflowStepRunner("workspace-e2e-pr-sync-");
afterAll(cleanup);

const makePr = (body: string) => ({
  body,
  draft: false,
  head: {
    ref: headRef,
    repo: { full_name: repository },
    sha: headSha,
  },
  number: prNumber,
  state: "open",
  user: { login: "author" },
});

const deploymentFixtures = (
  statuses: readonly {
    readonly description: string;
    readonly environment_url?: string;
    readonly state: string;
  }[]
): GhFixtures => ({
  deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
  "deployments/11/statuses": statuses,
});

const runValidate = (
  body: string,
  prOverride: Partial<ReturnType<typeof makePr>> = {}
) =>
  runStep(
    validateStep,
    {
      [`pulls/${prNumber}`]: { ...makePr(body), ...prOverride },
      [`statuses/${headSha}`]: {},
    },
    {
      FLOWS_CLI: flowsCli,
      PR_NUMBER: String(prNumber),
    }
  );

const runSync = ({
  body,
  statuses = [],
  deployment = deploymentFixtures([
    {
      description: "Deployment has completed",
      environment_url: `${previewUrl}/`,
      state: "success",
    },
  ]),
  extraFixtures = {},
  commands = {},
  env = {},
}: {
  readonly body: string;
  readonly statuses?: readonly object[];
  readonly deployment?: GhFixtures;
  readonly extraFixtures?: GhFixtures;
  readonly commands?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
}) =>
  runStep(
    syncStep,
    {
      [`pulls/${prNumber}`]: makePr(body),
      [`commits/${headSha}/statuses`]: statuses,
      [`statuses/${headSha}`]: {},
      ...deployment,
      "": {},
      ...extraFixtures,
    },
    {
      FLOWS_PUBLISH: flowsPublish,
      PR_NUMBER: String(prNumber),
      ...env,
    },
    commands
  );

const statusPosts = (calls: readonly string[]) =>
  calls.filter((call) => call.includes(`/statuses/${headSha}`));

const workflowDispatches = (calls: readonly string[]) =>
  calls.filter((call) => call.startsWith("workflow run workspace-e2e.yml"));

const pilotEnv = { GH_TOKEN: "test-token", PILOT_PR_NUMBER: String(prNumber) };
const pilotFixtures = (
  body: string,
  filename = "bun.lock",
  number = prNumber
): GhFixtures => {
  const repo = { id: 1015951989, owner: { id: 361691508 } };
  const pr = makePr(body);
  const proof = backendPreviewProofFixture(number, headSha, previewUrl);
  return {
    [`pulls/${number}`]: {
      ...pr,
      base: { ref: "main", repo, sha: earlierSha },
      changed_files: 1,
      head: { ...pr.head, repo: { ...pr.head.repo, ...repo } },
      number,
      user: { ...pr.user, type: "User" },
    },
    [`pulls/${number}/files`]: [{ filename, status: "modified" }],
    [`git/ref/heads/${headRef}`]: {
      object: { sha: headSha, type: "commit" },
      ref: `refs/heads/${headRef}`,
    },
    [proof.runPath]: proof.run,
    [proof.jobsPath]: proof.jobs,
  };
};
const proofFixture = backendPreviewProofFixture(prNumber, headSha, previewUrl);
const sourcePending = {
  context: "Workspace E2E",
  creator: { login: "github-actions[bot]" },
  description: "Protected preview E2E is running [flows: email-campaigns]",
  state: "pending",
  target_url: `https://github.com/Deskohub/deskohub-site/${proofFixture.runPath}`,
};
const newerPending = {
  ...sourcePending,
  target_url: "https://github.com/Deskohub/deskohub-site/actions/runs/999999",
};
const newerFailure = {
  ...newerPending,
  state: "failure",
  description: "Protected preview E2E failed [flows: email-campaigns]",
};
const laterSuccessfulRun = 1_000_000;
const laterSuccess = {
  ...sourcePending,
  id: 301,
  state: "success",
  description: "Protected preview E2E passed [flows: email-campaigns]",
  target_url: `https://github.com/Deskohub/deskohub-site/actions/runs/${laterSuccessfulRun}`,
};
const backendProof = (login = "github-actions[bot]") => ({
  ...proofFixture.status,
  creator: { login },
});
const campaignFlows = "## E2E flows\n- email-campaigns\n";
const localCampaignPass = {
  context: "Workspace E2E",
  creator: { login: "github-actions[bot]" },
  description: "Protected preview E2E passed [flows: email-campaigns]",
  state: "success",
};

const runPilotPublisher = (
  stepName: string,
  {
    env = {},
    statuses = [],
    deployment,
  }: {
    readonly env?: Readonly<Record<string, string>>;
    readonly statuses?: readonly object[];
    readonly deployment?: GhFixtures;
  }
) =>
  runStep(
    findStepByName(e2eWorkflow, stepName),
    {
      ...pilotFixtures(campaignFlows),
      ...(deployment ??
        deploymentFixtures([
          {
            description: "Deployment has completed",
            environment_url: previewUrl,
            state: "success",
          },
        ])),
      [`commits/${headSha}/statuses`]: statuses,
      [`statuses/${headSha}`]: {},
    },
    {
      ...pilotEnv,
      FLOWS: "email-campaigns",
      FLOWS_PUBLISH: flowsPublish,
      PR_NUMBER: String(prNumber),
      STATUS_STATE: "success",
      TARGET_SHA: headSha,
      ...env,
    }
  );

const runCompletedPilotPublisher = ({
  conclusion = "success",
  jobs = proofFixture.jobs.jobs,
  live = "current",
  statuses = [sourcePending],
  newerRunAfterWrite = false,
  statusesInitiallyUnavailable = false,
  statusesAfterWrite = [newerPending, sourcePending],
  laterSuccessVerified = false,
  failureDuringRestore = false,
} = {}) => {
  const liveGeneration =
    live === "changed" ? "1".repeat(64) : backendGeneration;
  const laterProof = backendPreviewProofFixture(
    prNumber,
    headSha,
    previewUrl,
    liveGeneration
  );
  const stubFetch = `
const team = "team_MgMQ4MEWijWnYa1R48C2JU5e";
const project = "prj_7FliQBcbBiBwGaO2JLrigicnXCRd";
const origin = ${JSON.stringify(previewUrl)};
const sha = ${JSON.stringify(headSha)};
const revision = ${JSON.stringify(backendRevision)};
const generation = ${JSON.stringify(liveGeneration)};
let proofs = 0;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.origin === origin && url.pathname === "/api/internal/backend-preview") {
    if (${live === "gone"} || (${live === "moves"} && ++proofs >= 3)) return new Response(null, { status: 503 });
    return Response.json({ commitSha: sha, cloudRunRevision: revision, generation, workerTag: "g-0123456789abcdef" }, { headers: {
      "x-deskohub-backend-revision": sha,
      "x-deskohub-cloud-run-revision": revision,
      "x-deskohub-preview-generation": generation,
    } });
  }
  if (url.origin === "https://api.vercel.com") {
    if (url.pathname.startsWith("/v13/deployments/")) return Response.json({
      id: ${JSON.stringify(backendDeploymentId)}, projectId: project, ownerId: team, target: null, public: false,
      readyState: "READY", url: new URL(origin).hostname,
      gitSource: { type: "github", repoId: 1015951989, prId: ${prNumber}, ref: ${JSON.stringify(headRef)}, sha },
    });
    if (url.pathname.startsWith("/v9/projects/")) return Response.json({ id: project, accountId: team, ssoProtection: { deploymentType: "preview" } });
    if (url.pathname.startsWith("/v4/aliases/")) return new Response(null, { status: 404 });
  }
  if (url.origin === "https://api.github.com") {
    const creator = { login: "vercel[bot]" };
    if (url.pathname.endsWith("/deployments")) return Response.json([{ id: 11, creator, sha, environment: "Preview – deskohub-workspace-site" }]);
    if (url.pathname.endsWith("/deployments/11/statuses")) return Response.json([{ id: 12, creator, state: "success", created_at: "2026-11-27T00:00:00Z", environment_url: origin }]);
  }
  throw new Error("Unexpected request to mock provider");
};`;
  return runStep(
    findStepByName(completionWorkflow, "Publish the verified completed pilot"),
    {
      ...pilotFixtures(campaignFlows),
      ...deploymentFixtures([
        {
          description: "Deployment has completed",
          environment_url: previewUrl,
          state: "success",
        },
      ]),
      [proofFixture.runPath]: {
        ...proofFixture.run,
        status: conclusion === "in_progress" ? "in_progress" : "completed",
        conclusion: conclusion === "in_progress" ? null : conclusion,
      },
      [proofFixture.jobsPath]: { jobs },
      [`actions/runs/${laterSuccessfulRun}`]: {
        ...proofFixture.run,
        id: laterSuccessfulRun,
        run_attempt: 2,
      },
      [`actions/runs/${laterSuccessfulRun}/attempts/2/jobs`]: {
        jobs: laterSuccessVerified
          ? laterProof.jobs.jobs.map((job) => ({
              ...job,
              run_id: laterSuccessfulRun,
            }))
          : [],
      },
      [`commits/${headSha}/statuses`]: statuses,
      "newer-status": statusesAfterWrite,
      "after-restore": [
        { ...laterSuccess, id: 400 },
        newerFailure,
        laterSuccess,
        sourcePending,
      ],
      [`statuses/${headSha}`]: { id: 400 },
    },
    {
      ...pilotEnv,
      FLOWS_PUBLISH: flowsPublish,
      NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(stubFetch).toString("base64")}`,
      PILOT_SOURCE_RUN_ID: String(proofFixture.run.id),
      PILOT_SOURCE_RUN_ATTEMPT: "1",
      VERCEL_TOKEN: "synthetic-vercel-fixture",
      VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-preview-fixture",
    },
    newerRunAfterWrite
      ? {
          "gh-fixture-api": fakeGh,
          gh: `#!/usr/bin/env bash
set -euo pipefail
if [[ ${statusesInitiallyUnavailable ? "true" : "false"} == true && "$*" == *"/commits/${headSha}/statuses?"* && ! -e "$GH_FIXTURES/pending-arrived" ]]; then
  exit 1
fi
if [[ "$*" == *"/statuses/${headSha} -f state="*" -f context=Workspace E2E -f "* ]]; then
  if [[ ${failureDuringRestore ? "true" : "false"} == true && "$*" == *" -f target_url=${laterSuccess.target_url}" ]]; then
    cp "$GH_FIXTURES/after-restore.json" "$GH_FIXTURES/commits_${headSha}_statuses.json"
  else
    cp "$GH_FIXTURES/newer-status.json" "$GH_FIXTURES/commits_${headSha}_statuses.json"
  fi
  touch "$GH_FIXTURES/pending-arrived"
fi
exec gh-fixture-api "$@"`,
        }
      : {}
  );
};

describe("Workspace E2E backend proof publishers", () => {
  test("the completion workflow checks out only protected main code", () => {
    expect(completionJob?.if).toContain("github.ref_protected");
    expect(completionJob?.if).toContain(
      "github.event.workflow_run.conclusion == 'success'"
    );
    expect(completionJob?.environment).toBe("workspace-backend-preview-e2e");
    expect(completionJob?.steps?.[0]?.with?.ref).toBe(
      `\${{ github.workflow_sha }}`
    );
    expect(completionJob?.permissions).toEqual({
      actions: "read",
      contents: "read",
      deployments: "read",
      "pull-requests": "read",
      statuses: "write",
    });
  });
  test("defers pilot green until a separate consumer can verify the completed run", async () => {
    const { calls, result } = await runPilotPublisher(
      "Publish final commit status",
      {
        env: {
          BACKEND_PREVIEW_REQUIRED: "true",
          ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        },
      }
    );
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(
      "state=success -f context=Workspace E2E allocation"
    );
  });

  test("a passing local run cannot write backend proof or publish a pilot pass", async () => {
    const { calls, result } = await runPilotPublisher(
      "Publish final commit status",
      {
        statuses: [localCampaignPass, backendProof()],
      }
    );
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(
      posts.some((post) => post.includes("context=Workspace backend preview"))
    ).toBe(false);
    expect(posts[0]).toContain("state=failure -f context=Workspace E2E");
    expect(posts[0]).toContain(
      "Run email-campaigns E2E against this Workspace backend preview"
    );
  });

  test("publishes pilot coverage for a successful completed run and its exact current generation", async () => {
    const { calls, result } = await runCompletedPilotPublisher();
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain(
      "Protected preview E2E passed [flows: email-campaigns]"
    );
    expect(posts[1]).toContain(
      "state=success -f context=Workspace backend preview"
    );
    expect(posts[1]).toContain(`description=${backendProof().description}`);
    expect(posts[0]).toContain(`target_url=${sourcePending.target_url}`);
    expect(posts[1]).toContain(`target_url=${proofFixture.status.target_url}`);
  });

  test("does not overwrite pending coverage owned by a different E2E run", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      statuses: [newerPending, sourcePending],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
  });

  test("ignores a delayed completion when a failure follows its pending status", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      statuses: [newerFailure, sourcePending],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
  });

  test("uses current proof to resolve a failure that predates the source run", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      statuses: [sourcePending, newerFailure],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)[0]).toContain(
      "state=success -f context=Workspace E2E"
    );
  });

  test("restores a foreign failure if it interleaves with pilot status publication", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      newerRunAfterWrite: true,
      statusesAfterWrite: [newerFailure, sourcePending],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain("state=success -f context=Workspace E2E");
    expect(posts[1]).toContain("state=failure -f context=Workspace E2E");
    expect(posts[1]).toContain(`description=${newerFailure.description}`);
    expect(posts[1]).toContain(`target_url=${newerFailure.target_url}`);
  });

  test.each([
    { initialState: "failure", statusesInitiallyUnavailable: true },
    { initialState: "success", statusesInitiallyUnavailable: false },
  ])(
    "repairs a tentative $initialState with the newest verified success above an older failure",
    async ({ initialState, statusesInitiallyUnavailable }) => {
      const { calls, result } = await runCompletedPilotPublisher({
        newerRunAfterWrite: true,
        statusesInitiallyUnavailable,
        statusesAfterWrite: [laterSuccess, newerFailure, sourcePending],
        laterSuccessVerified: true,
      });
      expect(result.exitCode).toBe(0);
      const posts = statusPosts(calls);
      expect(posts).toHaveLength(2);
      expect(posts[0]).toContain(
        `state=${initialState} -f context=Workspace E2E`
      );
      expect(posts[1]).toContain("state=success -f context=Workspace E2E");
      expect(posts[1]).toContain(`description=${laterSuccess.description}`);
      expect(posts[1]).toContain(`target_url=${laterSuccess.target_url}`);
    }
  );

  test("does not restore a newer mutable success without its matching trusted job", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      statuses: [laterSuccess, newerFailure, sourcePending],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.includes("state=failure"))).toBe(true);
  });

  test("preserves a newer verified result on a different live generation", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      live: "changed",
      newerRunAfterWrite: true,
      statusesAfterWrite: [laterSuccess, newerFailure, sourcePending],
      laterSuccessVerified: true,
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain("state=failure -f context=Workspace E2E");
    expect(posts[1]).toContain("state=success -f context=Workspace E2E");
    expect(posts[1]).toContain(`target_url=${laterSuccess.target_url}`);
  });

  test("leaves a settled newer verified generation alone", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      live: "changed",
      statuses: [laterSuccess, newerFailure, sourcePending],
      laterSuccessVerified: true,
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
  });

  test("ignores its own restoration when a newer failure appears in the same status read", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      live: "changed",
      newerRunAfterWrite: true,
      statusesAfterWrite: [laterSuccess, sourcePending],
      laterSuccessVerified: true,
      failureDuringRestore: true,
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(3);
    expect(posts[0]).toContain(`target_url=${sourcePending.target_url}`);
    expect(posts[1]).toContain("state=success -f context=Workspace E2E");
    expect(posts[1]).toContain(`target_url=${laterSuccess.target_url}`);
    expect(posts[2]).toContain("state=failure -f context=Workspace E2E");
    expect(posts[2]).toContain(`description=${newerFailure.description}`);
    expect(posts[2]).toContain(`target_url=${newerFailure.target_url}`);
  });

  test("restores ownership even when both failure status descriptions match", async () => {
    const later = {
      ...newerFailure,
      description:
        "Run email-campaigns E2E against this Workspace backend preview",
    };
    const { calls, result } = await runCompletedPilotPublisher({
      live: "gone",
      newerRunAfterWrite: true,
      statusesAfterWrite: [later, sourcePending],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain(`description=${later.description}`);
    expect(posts[0]).toContain(`target_url=${sourcePending.target_url}`);
    expect(posts[1]).toContain(`description=${later.description}`);
    expect(posts[1]).toContain(`target_url=${later.target_url}`);
  });

  test("requires source pending history to order the completed pilot", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      statuses: [],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
  });

  test.each([
    {
      caseName: "success",
      live: "current",
      statusesInitiallyUnavailable: false,
      state: "success",
    },
    {
      caseName: "missing generation",
      live: "gone",
      statusesInitiallyUnavailable: false,
      state: "failure",
    },
    {
      caseName: "unavailable status history",
      live: "current",
      statusesInitiallyUnavailable: true,
      state: "failure",
    },
  ])(
    "restores the newer pending owner when it interleaves with $caseName",
    async ({ live, statusesInitiallyUnavailable, state }) => {
      const { calls, result } = await runCompletedPilotPublisher({
        newerRunAfterWrite: true,
        live,
        statusesInitiallyUnavailable,
      });
      expect(result.exitCode).toBe(0);
      const posts = statusPosts(calls);
      expect(posts).toHaveLength(2);
      expect(posts[0]).toContain(`state=${state} -f context=Workspace E2E`);
      expect(posts[1]).toContain("state=pending -f context=Workspace E2E");
      expect(posts[1]).toContain(`description=${newerPending.description}`);
      expect(posts[1]).toContain(`target_url=${newerPending.target_url}`);
    }
  );

  test.each(["failure", "cancelled", "in_progress"])(
    "rejects a successful confirmation job from a %s workflow run",
    async (conclusion) => {
      const { calls, result } = await runCompletedPilotPublisher({
        conclusion,
      });
      expect(result.exitCode).toBe(0);
      expect(statusPosts(calls)).toHaveLength(0);
    }
  );

  test.each(["gone", "changed"])(
    "blocks completed success while the live backend generation is %s",
    async (live) => {
      const { calls, result } = await runCompletedPilotPublisher({ live });
      expect(result.exitCode).toBe(0);
      expect(statusPosts(calls)).toHaveLength(2);
      expect(
        statusPosts(calls).every((post) => post.includes("state=failure"))
      ).toBe(true);
    }
  );

  test("repairs a tentative success if the backend disappears during status publication", async () => {
    const { calls, result } = await runCompletedPilotPublisher({
      live: "moves",
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts[0]).toContain("state=success -f context=Workspace E2E");
    expect(posts[1]).toContain("state=failure -f context=Workspace E2E");
    expect(posts[2]).toContain(
      "state=failure -f context=Workspace backend preview"
    );
  });

  test("rejects a successful same-tree fallback for a skipped pilot deployment", async () => {
    const { calls, result } = await runPilotPublisher(
      "Publish status without an E2E run",
      {
        deployment: deploymentFixtures([
          { description: "Skipped - Not affected", state: "inactive" },
        ]),
        env: {
          STATUS_DESCRIPTION:
            "Same tree as bbbbbbb, which passed E2E [flows: email-campaigns]",
          STATUS_REASON: "deployment-skipped",
        },
        statuses: [backendProof()],
      }
    );
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(statusPosts(calls)[0]).toContain(
      "Deploy the exact protected Vercel preview"
    );
  });
});

describe("Workspace E2E PR flows sync workflow contract", () => {
  test("validates every open PR including drafts, forks, Dependabot, and synchronize pushes without checking out PR code", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.on?.pull_request_target?.types).toEqual([
      "opened",
      "edited",
      "reopened",
      "ready_for_review",
      "synchronize",
    ]);
    expect(validateJob?.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(syncJob?.needs).toBe("validate-pr-e2e-flows");
    expect(syncJob?.permissions).toEqual({
      actions: "write",
      contents: "read",
      deployments: "read",
      "pull-requests": "read",
      statuses: "write",
    });

    for (const job of [validateJob, syncJob]) {
      const checkouts = (job?.steps ?? []).filter((step) =>
        (step.uses ?? "").startsWith("actions/checkout@")
      );
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with?.ref).toContain("github.workflow_sha");
      expect(checkouts[0]?.with?.["persist-credentials"]).toBe(false);
      expect(
        String(checkouts[0]?.with?.["sparse-checkout"]).trim().split("\n")
      ).toEqual(
        job === syncJob
          ? [
              ".github/actions/workspace-e2e-flows",
              ".github/actions/workspace-backend-preview",
            ]
          : [".github/actions/workspace-e2e-flows"]
      );
    }
    expect(syncStep?.env?.PILOT_PR_NUMBER).toContain(
      "vars.WORKSPACE_BACKEND_PREVIEW_PR"
    );

    const validateCondition = String(validateJob?.if);
    for (const guard of [
      "github.repository_id == '1015951989'",
      "github.event.pull_request.state == 'open'",
    ]) {
      expect(validateCondition).toContain(guard);
    }
    expect(validateCondition).not.toContain("draft");
    expect(validateCondition).not.toContain("dependabot");

    const syncCondition = String(syncJob?.if);
    for (const guard of [
      "github.repository_id == '1015951989'",
      "github.event.action != 'synchronize'",
      "github.event.pull_request.state == 'open'",
      "github.event.pull_request.draft == false",
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.event.pull_request.user.login != 'dependabot[bot]'",
      "!startsWith(github.event.pull_request.head.ref, 'dependabot/')",
      "needs.validate-pr-e2e-flows.outputs.eligible_internal == 'true'",
    ]) {
      expect(syncCondition).toContain(guard);
    }
  });

  test.each([
    [
      "fork PR",
      {
        head: { ref: headRef, repo: { full_name: "fork/repo" }, sha: headSha },
      },
    ],
    ["draft PR", { draft: true }],
    ["Dependabot PR", { user: { login: "dependabot[bot]" } }],
  ])(
    "validates ## E2E flows on %s without ever granting success or dispatching sync",
    async (_label, override) => {
      const invalid = await runValidate("## Summary\nMissing flows", override);
      expect(invalid.result.exitCode).not.toBe(0);
      expect(statusPosts(invalid.calls)).toHaveLength(1);
      expect(statusPosts(invalid.calls)[0]).toContain("state=failure");
      expect(statusPosts(invalid.calls)[0]).toContain(
        "Invalid or missing ## E2E flows"
      );

      const validNone = await runValidate("## E2E flows\n- none\n", override);
      expect(validNone.result.exitCode).toBe(0);
      expect(validNone.outputs.eligible_internal).toBe("false");
      expect(statusPosts(validNone.calls)).toEqual([]);
    }
  );

  test.each([
    [
      "fork PR",
      {
        head: { ref: headRef, repo: { full_name: "fork/repo" }, sha: headSha },
      },
    ],
    ["draft PR", { draft: true }],
    ["Dependabot PR", { user: { login: "dependabot[bot]" } }],
  ])(
    "sync exits cleanly without posting statuses for an ineligible %s",
    async (_label, override) => {
      const { calls, result } = await runStep(
        syncStep,
        {
          [`pulls/${prNumber}`]: {
            ...makePr("## E2E flows\n- all\n"),
            ...override,
          },
        },
        {
          FLOWS_PUBLISH: flowsPublish,
          PR_NUMBER: String(prNumber),
        }
      );
      expect(result.exitCode).toBe(0);
      expect(statusPosts(calls)).toEqual([]);
      expect(workflowDispatches(calls)).toEqual([]);
    }
  );
});

describe("Workspace E2E PR flows sync step", () => {
  test("fails closed and marks Workspace E2E failed when ## E2E flows is missing or invalid", async () => {
    const { calls, result } = await runSync({
      body: "## Summary\nForgot E2E flows",
    });
    expect(result.exitCode).not.toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    expect(posts[0]).toContain("Invalid or missing ## E2E flows");
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("marks Workspace E2E passed as skipped when PR declares none and preview succeeded", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `none`\n",
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=success");
    expect(posts[0]).toContain("Protected preview E2E skipped [flows: none]");
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("blocks a backend pilot PR edit to none even with exact proof", async () => {
    const body = "## E2E flows\n- none\n";
    const { calls, result } = await runSync({
      body,
      env: pilotEnv,
      extraFixtures: pilotFixtures(body),
      statuses: [backendProof(), localCampaignPass],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(statusPosts(calls)[0]).toContain("Add email-campaigns");
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("still accepts none when the configured pilot has only frontend changes", async () => {
    const body = "## E2E flows\n- none\n";
    const { calls, result } = await runSync({
      body,
      env: pilotEnv,
      extraFixtures: pilotFixtures(body, "apps/deskohub-workspace/proxy.ts"),
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=success");
    expect(statusPosts(calls)[0]).toContain("Protected preview E2E skipped");
  });

  test("cannot skip Workspace E2E from another PR at the same backend pilot SHA", async () => {
    const pilotNumber = prNumber + 1;
    const { calls, result } = await runSync({
      body: "## E2E flows\n- none\n",
      env: { ...pilotEnv, PILOT_PR_NUMBER: String(pilotNumber) },
      extraFixtures: pilotFixtures(campaignFlows, "bun.lock", pilotNumber),
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test.each([
    ["missing", []],
    ["an old mutable status", [{ ...backendProof(), target_url: "" }]],
    ["from a different actor", [backendProof("contributor")]],
  ])("dispatches the pilot lane when proof is %s", async (_name, proof) => {
    const { calls, result } = await runSync({
      body: campaignFlows,
      env: pilotEnv,
      extraFixtures: pilotFixtures(campaignFlows),
      statuses: [...proof, localCampaignPass],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(workflowDispatches(calls)).toHaveLength(1);
    expect(workflowDispatches(calls)[0]).toContain("flows=email-campaigns");
  });

  test("requires a fresh pilot run when reconciling historical proof at the same deployment", async () => {
    const { calls, result } = await runSync({
      body: campaignFlows,
      env: pilotEnv,
      extraFixtures: pilotFixtures(campaignFlows),
      statuses: [
        {
          ...localCampaignPass,
          description: "Earlier validation failed",
          state: "failure",
        },
        backendProof(),
        localCampaignPass,
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(workflowDispatches(calls)).toHaveLength(1);
  });

  test("rejects replay of trusted proof after a new deployment of the same SHA", async () => {
    const { calls, result } = await runSync({
      body: campaignFlows,
      env: pilotEnv,
      extraFixtures: pilotFixtures(campaignFlows),
      deployment: deploymentFixtures([
        {
          description: "Deployment has completed",
          environment_url:
            "https://deskohub-workspace-site-another123-team.vercel.app",
          state: "success",
        },
      ]),
      statuses: [backendProof(), localCampaignPass],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(workflowDispatches(calls)).toHaveLength(1);
  });

  test("keeps the pilot lane in a dispatch when a PR edit adds another flow", async () => {
    const body = `${campaignFlows}- admin\n`;
    const { calls, result } = await runSync({
      body,
      env: pilotEnv,
      extraFixtures: pilotFixtures(body),
      statuses: [backendProof(), localCampaignPass],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(workflowDispatches(calls)).toHaveLength(1);
    expect(workflowDispatches(calls)[0]).toContain(
      "flows=admin,email-campaigns"
    );
  });

  test("requires classification before changing a pilot status to success", async () => {
    const { calls, result } = await runSync({
      body: campaignFlows,
      env: pilotEnv,
      statuses: [backendProof(), localCampaignPass],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(statusPosts(calls)[0]).toContain(
      "could not verify backend preview eligibility"
    );
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("gives a newer failed deployment status precedence over older success for both none and passed flows", async () => {
    const failedAfterSuccess = deploymentFixtures([
      { description: "Deployment has failed", state: "failure" },
      {
        description: "Deployment has completed",
        environment_url: `${previewUrl}/`,
        state: "success",
      },
    ]);

    const noneRun = await runSync({
      body: "## E2E flows\n- none\n",
      deployment: failedAfterSuccess,
    });
    expect(noneRun.result.exitCode).toBe(0);
    expect(statusPosts(noneRun.calls)).toHaveLength(1);
    expect(statusPosts(noneRun.calls)[0]).toContain("state=failure");
    expect(statusPosts(noneRun.calls)[0]).toContain(
      "Vercel preview deployment failed"
    );

    const passedRun = await runSync({
      body: "## E2E flows\n- admin\n",
      deployment: failedAfterSuccess,
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          state: "success",
        },
      ],
    });
    expect(passedRun.result.exitCode).toBe(0);
    expect(statusPosts(passedRun.calls)).toHaveLength(1);
    expect(statusPosts(passedRun.calls)[0]).toContain("state=failure");
    expect(statusPosts(passedRun.calls)[0]).toContain(
      "Vercel preview deployment failed"
    );
  });

  test("never restores an older pass over an active pending rerun for that flow", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- admin\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E is running [flows: admin]",
          state: "pending",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("dispatches only missing real-run flows when coverage is split between local and carried passes", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- account\n- admin\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Same tree as bbbbbbb, which passed E2E [flows: account]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    const dispatches = workflowDispatches(calls);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain("flows=account");
    expect(dispatches[0]).not.toContain("flows=none");
  });

  test("never restores green when a newer run failed a flow that had passed earlier", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- admin\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E failed [flows: admin]",
          state: "failure",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    const dispatches = workflowDispatches(calls);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain("flows=admin");
  });

  test("preserves same-tree provenance when restoring carried coverage after an edit", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- admin\n",
      deployment: deploymentFixtures([
        { description: "Skipped - Not affected", state: "inactive" },
      ]),
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Same tree as bbbbbbb lacks required E2E flows; deploy its Workspace preview",
          state: "failure",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as bbbbbbb, which passed E2E [flows: admin]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=success");
    expect(posts[0]).toContain(
      "description=Same tree as bbbbbbb, which passed E2E [flows: admin]"
    );
    expect(posts[0]).not.toContain("Protected preview E2E passed");
  });

  test("fails Workspace E2E and dispatches only newly added flows when PR body widens after a pass", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n- `email-campaigns`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    const dispatches = workflowDispatches(calls);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain(`sha=${headSha}`);
    expect(dispatches[0]).toContain(`url=${previewUrl}`);
    expect(dispatches[0]).toContain(`ref=${headRef}`);
    expect(dispatches[0]).toContain("flows=email-campaigns");
  });

  test("does nothing when all requested flows already passed on this SHA", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Protected preview E2E passed [flows: admin,email-campaigns]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("does not cancel or re-dispatch when an in-progress run already covers the requested flows", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E is running [flows: admin]",
          state: "pending",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("fails and dispatches full unpassed flow list when a new flow is added mid-run", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n- `email-campaigns`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E is running [flows: admin]",
          state: "pending",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    const dispatches = workflowDispatches(calls);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain("flows=admin,email-campaigns");
  });

  test("reuses a genuine partial pass on a same-tree commit and fails when requested flows are missing", async () => {
    const covered = await runSync({
      body: "## E2E flows\n- `admin`\n",
      deployment: deploymentFixtures([
        { description: "Skipped - Not affected", state: "inactive" },
      ]),
      extraFixtures: {
        [`pulls/${prNumber}/commits`]: [
          { commit: { tree: { sha: "tree-1" } }, sha: earlierSha },
          { commit: { tree: { sha: "tree-1" } }, sha: headSha },
        ],
        [`commits/${earlierSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description:
              "Protected preview E2E partial; more flows required [flows: admin]",
            state: "failure",
          },
        ],
      },
    });
    expect(covered.result.exitCode).toBe(0);
    expect(statusPosts(covered.calls)).toHaveLength(1);
    expect(statusPosts(covered.calls)[0]).toContain("state=success");
    expect(statusPosts(covered.calls)[0]).toContain(
      "Same tree as bbbbbbb, which passed E2E [flows: admin]"
    );

    const uncovered = await runSync({
      body: "## E2E flows\n- `admin`\n- `email-campaigns`\n",
      deployment: deploymentFixtures([
        { description: "Skipped - Not affected", state: "inactive" },
      ]),
      extraFixtures: {
        [`pulls/${prNumber}/commits`]: [
          { commit: { tree: { sha: "tree-1" } }, sha: earlierSha },
          { commit: { tree: { sha: "tree-1" } }, sha: headSha },
        ],
        [`commits/${earlierSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E passed [flows: admin]",
            state: "success",
          },
        ],
      },
    });
    expect(uncovered.result.exitCode).toBe(0);
    expect(statusPosts(uncovered.calls)).toHaveLength(1);
    expect(statusPosts(uncovered.calls)[0]).toContain("state=failure");
    expect(statusPosts(uncovered.calls)[0]).toContain(
      "lacks required E2E flows"
    );
    expect(workflowDispatches(uncovered.calls)).toEqual([]);
  });

  test("restores pending with the active run's original target_url and lets that run publish its final pass", async () => {
    const activeRunUrl = `https://github.com/${repository}/actions/runs/200`;
    const statefulGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
state_file="$GH_FIXTURES/state.txt"
[[ -f "$state_file" ]] || echo "before" > "$state_file"
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  echo '{"number":${prNumber},"state":"open","draft":false,"user":{"login":"author"},"head":{"ref":"${headRef}","sha":"${headSha}","repo":{"full_name":"${repository}"}},"body":"## E2E flows\\n- admin\\n"}'
  exit 0
fi
if [[ "$*" == *"/deployments/11/statuses"* ]]; then
  echo '[{"state":"success","description":"Deployment has completed","environment_url":"${previewUrl}/"}]'
  exit 0
fi
if [[ "$*" == *"/deployments"* ]]; then
  echo '[{"id":11,"creator":{"login":"vercel[bot]"}}]'
  exit 0
fi
if [[ "$*" == *"/commits/${headSha}/statuses"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo '[[{"id":10,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Invalid or missing ## E2E flows in PR description; list valid flows, all, or none"},{"id":9,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"}]]'
  else
    echo '[[{"id":12,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"},{"id":11,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"pending","description":"Protected preview E2E is running [flows: admin]","target_url":"${activeRunUrl}"},{"id":9,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"}]]'
  fi
  exit 0
fi
if [[ "$*" == *"/statuses/${headSha}"* ]]; then
  echo "after" > "$state_file"
  echo '{"id":12}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const { calls, result } = await runSync({
      body: "## E2E flows\n- admin\n",
      commands: { gh: statefulGh },
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain("state=success");
    expect(posts[1]).toContain("state=pending");
    expect(posts[1]).toContain(
      "description=Protected preview E2E is running [flows: admin]"
    );
    expect(posts[1]).toContain(`target_url=${activeRunUrl}`);

    // Now replay the active run (#200) completing: because pending preserved
    // run #200's target_url, publish-final-status recognizes ownership and
    // publishes success rather than leaving the check pending.
    const e2eWorkflow = parseWorkflow(
      resolve(import.meta.dir, "../../../.github/workflows/workspace-e2e.yml")
    );
    const finalStep = findStepByName(
      e2eWorkflow,
      "Publish final commit status"
    );
    const completed = await runStep(
      finalStep,
      {
        [`pulls/${prNumber}`]: makePr("## E2E flows\n- admin\n"),
        ...deploymentFixtures([
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ]),
        [`commits/${headSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E is running [flows: admin]",
            id: 13,
            state: "pending",
            target_url: activeRunUrl,
          },
        ],
        [`statuses/${headSha}`]: { id: 14 },
      },
      {
        ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        ALLOCATION_SHARD: "1",
        FLOWS: "admin",
        FLOWS_PUBLISH: flowsPublish,
        GITHUB_RUN_ID: "200",
        PR_NUMBER: String(prNumber),
        STATUS_STATE: "success",
        TARGET_SHA: headSha,
      }
    );
    expect(completed.result.exitCode).toBe(0);
    const finalE2EPosts = statusPosts(completed.calls).filter(
      (call) =>
        call.includes("context=Workspace E2E") &&
        !call.includes("context=Workspace E2E allocation")
    );
    expect(finalE2EPosts).toHaveLength(1);
    expect(finalE2EPosts[0]).toContain("state=success");
    expect(finalE2EPosts[0]).toContain(
      "description=Protected preview E2E passed [flows: admin]"
    );
  });

  test("excludes tentative success on retry AND across a second sync when a real failure interleaves", async () => {
    const statefulGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
state_file="$GH_FIXTURES/state.txt"
[[ -f "$state_file" ]] || echo "before" > "$state_file"
if [[ "$*" == "workflow run workspace-e2e.yml"* ]]; then
  exit 0
fi
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  echo '{"number":${prNumber},"state":"open","draft":false,"user":{"login":"author"},"head":{"ref":"${headRef}","sha":"${headSha}","repo":{"full_name":"${repository}"}},"body":"## E2E flows\\n- admin\\n"}'
  exit 0
fi
if [[ "$*" == *"/deployments/11/statuses"* ]]; then
  echo '[{"state":"success","description":"Deployment has completed","environment_url":"${previewUrl}/"}]'
  exit 0
fi
if [[ "$*" == *"/deployments"* ]]; then
  echo '[{"id":11,"creator":{"login":"vercel[bot]"}}]'
  exit 0
fi
if [[ "$*" == *"/commits/${headSha}/statuses"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo '[[{"id":10,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Invalid or missing ## E2E flows in PR description; list valid flows, all, or none"},{"id":9,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"}]]'
  else
    echo '[[{"id":12,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E restored [flows: admin]","target_url":"https://github.com/${repository}/actions/runs/99"},{"id":11,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Protected preview E2E failed [flows: admin]","target_url":"https://github.com/${repository}/actions/runs/205"},{"id":9,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"}]]'
  fi
  exit 0
fi
if [[ "$*" == *"/statuses/${headSha}"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo "after" > "$state_file"
    echo '{"id":12}'
  else
    echo '{"id":13}'
  fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const { calls, result } = await runSync({
      body: "## E2E flows\n- admin\n",
      commands: { gh: statefulGh },
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain("state=success");
    expect(posts[0]).toContain(
      "description=Protected preview E2E restored [flows: admin]"
    );
    expect(posts[1]).toContain("state=failure");
    expect(posts[1]).toContain("starting Workspace E2E for missing flows");
    const dispatches = workflowDispatches(calls);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain("flows=admin");

    // Now invoke a SECOND fresh sync reading the persisted history before the
    // dispatched rerun starts: it must NOT trust the first sync's tentative
    // `restored` status as a real run pass.
    const secondSync = await runSync({
      body: "## E2E flows\n- admin\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "PR E2E flows changed; starting Workspace E2E for missing flows",
          id: 13,
          state: "failure",
          target_url: `https://github.com/${repository}/actions/runs/99`,
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E restored [flows: admin]",
          id: 12,
          state: "success",
          target_url: `https://github.com/${repository}/actions/runs/99`,
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E failed [flows: admin]",
          id: 11,
          state: "failure",
          target_url: `https://github.com/${repository}/actions/runs/205`,
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          id: 9,
          state: "success",
          target_url: `https://github.com/${repository}/actions/runs/80`,
        },
      ],
    });
    expect(secondSync.result.exitCode).toBe(0);
    const secondPosts = statusPosts(secondSync.calls);
    expect(secondPosts.at(-1)).toContain("state=failure");
    expect(secondPosts.some((post) => post.includes("state=success"))).toBe(
      false
    );
    expect(workflowDispatches(secondSync.calls)).toHaveLength(1);
    expect(workflowDispatches(secondSync.calls)[0]).toContain("flows=admin");
  });

  test("undoes tentative restored success when preview changes to in_progress mid-sync and does not restore a metadata-terminated run to pending", async () => {
    const statefulGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
state_file="$GH_FIXTURES/state.txt"
[[ -f "$state_file" ]] || echo "ready" > "$state_file"
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  echo '{"number":${prNumber},"state":"open","draft":false,"user":{"login":"author"},"head":{"ref":"${headRef}","sha":"${headSha}","repo":{"full_name":"${repository}"}},"body":"## E2E flows\\n- admin\\n"}'
  exit 0
fi
if [[ "$*" == *"/deployments/11/statuses"* ]]; then
  if [[ "$(cat "$state_file")" == "ready" ]]; then
    echo '[{"state":"success","description":"Deployment has completed","environment_url":"${previewUrl}/"}]'
  else
    echo '[{"state":"in_progress","description":"Deployment in progress"}]'
  fi
  exit 0
fi
if [[ "$*" == *"/deployments"* ]]; then
  echo '[{"id":11,"creator":{"login":"vercel[bot]"}}]'
  exit 0
fi
if [[ "$*" == *"/commits/${headSha}/statuses"* ]]; then
  echo '[[{"id":10,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Invalid or missing ## E2E flows in PR description; list valid flows, all, or none"},{"id":9,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"}]]'
  exit 0
fi
if [[ "$*" == *"/statuses/${headSha}"* ]]; then
  echo "building" > "$state_file"
  echo '{"id":12}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const previewChanged = await runSync({
      body: "## E2E flows\n- admin\n",
      commands: { gh: statefulGh },
    });
    expect(previewChanged.result.exitCode).toBe(0);
    const changedPosts = statusPosts(previewChanged.calls);
    expect(changedPosts).toHaveLength(2);
    expect(changedPosts[0]).toContain("state=success");
    expect(changedPosts[1]).toContain("state=pending");
    expect(changedPosts[1]).toContain("Waiting for Vercel preview to");

    // A run that terminated with a metadata failure must NOT be restored to
    // pending when the PR body is later fixed; sync must dispatch a new run.
    const completedMetadataFailure = await runSync({
      body: "## E2E flows\n- admin\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Invalid or missing ## E2E flows in PR description; list valid flows, all, or none",
          id: 20,
          state: "failure",
          target_url: `https://github.com/${repository}/actions/runs/200`,
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E is running [flows: admin]",
          id: 19,
          state: "pending",
          target_url: `https://github.com/${repository}/actions/runs/200`,
        },
      ],
    });
    expect(completedMetadataFailure.result.exitCode).toBe(0);
    const metaPosts = statusPosts(completedMetadataFailure.calls);
    expect(metaPosts).toHaveLength(1);
    expect(metaPosts[0]).toContain("state=failure");
    expect(workflowDispatches(completedMetadataFailure.calls)).toHaveLength(1);
    expect(workflowDispatches(completedMetadataFailure.calls)[0]).toContain(
      "flows=admin"
    );
  });

  test("restores pending preserving run identity when reselecting a flow still running underneath another pass", async () => {
    const activeRunUrl = `https://github.com/${repository}/actions/runs/200`;
    const { calls, result } = await runSync({
      body: "## E2E flows\n- admin\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: webkit]",
          state: "success",
          target_url: `https://github.com/${repository}/actions/runs/300`,
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E is running [flows: admin]",
          state: "pending",
          target_url: activeRunUrl,
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin,webkit]",
          state: "success",
          target_url: `https://github.com/${repository}/actions/runs/100`,
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=pending");
    expect(posts[0]).toContain(
      "description=Protected preview E2E is running [flows: admin]"
    );
    expect(posts[0]).toContain(`target_url=${activeRunUrl}`);
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("does not restore coverage while the current deployment is in_progress and honors head failures on skipped previews", async () => {
    const inProgressDeployment = await runSync({
      body: "## E2E flows\n- admin\n",
      deployment: deploymentFixtures([
        { description: "Deployment in progress", state: "in_progress" },
      ]),
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          state: "success",
        },
      ],
    });
    expect(inProgressDeployment.result.exitCode).toBe(0);
    expect(statusPosts(inProgressDeployment.calls)).toEqual([]);

    const headFailedSkipped = await runSync({
      body: "## E2E flows\n- admin\n",
      deployment: deploymentFixtures([
        { description: "Skipped - Not affected", state: "inactive" },
      ]),
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E failed [flows: admin]",
          state: "failure",
        },
      ],
      extraFixtures: {
        [`pulls/${prNumber}/commits`]: [
          { commit: { tree: { sha: "tree-1" } }, sha: earlierSha },
          { commit: { tree: { sha: "tree-1" } }, sha: headSha },
        ],
        [`commits/${earlierSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E passed [flows: admin]",
            state: "success",
          },
        ],
      },
    });
    expect(headFailedSkipped.result.exitCode).toBe(0);
    const posts = statusPosts(headFailedSkipped.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    expect(posts[0]).toContain("Protected preview E2E failed on this commit");
  });

  test("rejects carried coverage hiding a real head failure, keeps unresolved exact-preview failures, and accepts a genuine concurrent pass", async () => {
    // 1. Carried `admin,webkit` above a real `admin` failure must NOT satisfy
    // reselecting `admin`; sync must fail and dispatch `admin`.
    const carriedAboveFail = await runSync({
      body: "## E2E flows\n- admin\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Same tree as bbbbbbb, which passed E2E [flows: admin,webkit]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E failed [flows: admin]",
          state: "failure",
        },
      ],
    });
    expect(carriedAboveFail.result.exitCode).toBe(0);
    expect(statusPosts(carriedAboveFail.calls)).toHaveLength(1);
    expect(statusPosts(carriedAboveFail.calls)[0]).toContain("state=failure");
    expect(workflowDispatches(carriedAboveFail.calls)).toHaveLength(1);
    expect(workflowDispatches(carriedAboveFail.calls)[0]).toContain(
      "flows=admin"
    );

    // 2. An unresolved exact-preview mismatch failure must NOT be cleared by an
    // unrelated succeeded preview deployment on the same SHA — even across an
    // intervening PR validation failure — nor by a matching URL whose recorded
    // deployment outcome differs from the failed event's expected outcome.
    const previewUrlTag = createHash("sha256")
      .update(previewUrl)
      .digest("hex")
      .slice(0, 8);

    const unresolvedMismatch = await runSync({
      body: "## E2E flows\n- none\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: success:00000000]",
          state: "failure",
        },
      ],
    });
    expect(unresolvedMismatch.result.exitCode).toBe(0);
    expect(statusPosts(unresolvedMismatch.calls)).toEqual([]);

    const mismatchUnderValidationFailure = await runSync({
      body: "## E2E flows\n- none\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Invalid or missing ## E2E flows in PR description; list valid flows, all, or none",
          state: "failure",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: success:00000000]",
          state: "failure",
        },
      ],
    });
    expect(mismatchUnderValidationFailure.result.exitCode).toBe(0);
    const restoredMismatchPosts = statusPosts(
      mismatchUnderValidationFailure.calls
    );
    expect(restoredMismatchPosts).toHaveLength(1);
    expect(restoredMismatchPosts[0]).toContain("state=failure");
    expect(restoredMismatchPosts[0]).toContain("[preview: success:00000000]");

    const wrongOutcomeSameUrl = await runSync({
      body: "## E2E flows\n- none\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: `No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: failed:${previewUrlTag}]`,
          state: "failure",
        },
      ],
    });
    expect(wrongOutcomeSameUrl.result.exitCode).toBe(0);
    expect(statusPosts(wrongOutcomeSameUrl.calls)).toEqual([]);

    const matchingOutcomeSameUrl = await runSync({
      body: "## E2E flows\n- none\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: `No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: success:${previewUrlTag}]`,
          state: "failure",
        },
      ],
    });
    expect(matchingOutcomeSameUrl.result.exitCode).toBe(0);
    expect(statusPosts(matchingOutcomeSameUrl.calls)).toHaveLength(1);
    expect(statusPosts(matchingOutcomeSameUrl.calls)[0]).toContain(
      "state=success"
    );
    expect(statusPosts(matchingOutcomeSameUrl.calls)[0]).toContain(
      "Protected preview E2E skipped [flows: none]"
    );

    // An older preview's `skipped-none` sitting on top of a newer preview's
    // unresolved mismatch must NOT clear that mismatch: sync restores failure.
    const olderSuccessOverNewerMismatch = await runSync({
      body: "## E2E flows\n- none\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E skipped [flows: none]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: failed:deadbeef]",
          state: "failure",
        },
      ],
    });
    expect(olderSuccessOverNewerMismatch.result.exitCode).toBe(0);
    const olderSuccessPosts = statusPosts(olderSuccessOverNewerMismatch.calls);
    expect(olderSuccessPosts).toHaveLength(1);
    expect(olderSuccessPosts[0]).toContain("state=failure");
    expect(olderSuccessPosts[0]).toContain("[preview: failed:deadbeef]");

    // If sync reads an outstanding mismatch, and before its failure write lands
    // the exact matching deployment appears and its publisher posts
    // `skipped-none`, post-write CAS must reinstate `skipped-none` rather than
    // leaving the stale failure on top.
    const statefulMismatchRecoveryGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
state_file="$GH_FIXTURES/state.txt"
[[ -f "$state_file" ]] || echo "before" > "$state_file"
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  echo '{"number":${prNumber},"state":"open","draft":false,"user":{"login":"author"},"head":{"ref":"${headRef}","sha":"${headSha}","repo":{"full_name":"${repository}"}},"body":"## E2E flows\\n- none\\n"}'
  exit 0
fi
if [[ "$*" == *"/deployments/11/statuses"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo '[{"state":"success","description":"Deployment has completed","environment_url":"https://deskohub-workspace-site-other-team.vercel.app/"}]'
  else
    echo '[{"state":"success","description":"Deployment has completed","environment_url":"${previewUrl}/"}]'
  fi
  exit 0
fi
if [[ "$*" == *"/deployments"* ]]; then
  echo '[{"id":11,"creator":{"login":"vercel[bot]"}}]'
  exit 0
fi
if [[ "$*" == *"/commits/${headSha}/statuses"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo '[[{"id":20,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Invalid or missing ## E2E flows in PR description; list valid flows, all, or none"},{"id":19,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: success:${previewUrlTag}]"}]]'
  else
    echo '[[{"id":22,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: success:${previewUrlTag}]","target_url":"https://github.com/${repository}/actions/runs/99"},{"id":21,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E skipped [flows: none]","target_url":"https://github.com/${repository}/actions/runs/260"},{"id":20,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Invalid or missing ## E2E flows in PR description; list valid flows, all, or none"},{"id":19,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: success:${previewUrlTag}]"}]]'
  fi
  exit 0
fi
if [[ "$*" == *"/statuses/${headSha}"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo "after" > "$state_file"
    echo '{"id":22}'
  else
    echo '{"id":23}'
  fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const mismatchRecovered = await runSync({
      body: "## E2E flows\n- none\n",
      commands: { gh: statefulMismatchRecoveryGh },
    });
    expect(mismatchRecovered.result.exitCode).toBe(0);
    const recoveredPosts = statusPosts(mismatchRecovered.calls);
    expect(recoveredPosts).toHaveLength(2);
    expect(recoveredPosts[0]).toContain("state=failure");
    expect(recoveredPosts[0]).toContain(`[preview: success:${previewUrlTag}]`);
    expect(recoveredPosts[1]).toContain("state=success");
    expect(recoveredPosts[1]).toContain(
      "description=Protected preview E2E skipped [flows: none]"
    );

    // PR sync must stay blocked while two eligible PRs still share the head,
    // and dispatch newly requested flows (or clear `none`) once one PR closes.
    const ambiguityStatus = {
      context: "Workspace E2E",
      creator: { login: "github-actions[bot]" },
      description: "More than one open PR has this head; E2E needs exactly one",
      state: "failure",
    };
    const syncStillAmbiguous = await runSync({
      body: "## E2E flows\n- admin\n",
      extraFixtures: {
        [`commits/${headSha}/pulls`]: [
          makePr("## E2E flows\n- admin\n"),
          { ...makePr("## E2E flows\n- admin\n"), number: prNumber + 1 },
        ],
      },
      statuses: [ambiguityStatus],
    });
    expect(syncStillAmbiguous.result.exitCode).toBe(0);
    expect(statusPosts(syncStillAmbiguous.calls)).toEqual([]);
    expect(workflowDispatches(syncStillAmbiguous.calls)).toEqual([]);

    const syncAmbiguityClearedDispatch = await runSync({
      body: "## E2E flows\n- admin\n",
      extraFixtures: {
        [`commits/${headSha}/pulls`]: [
          makePr("## E2E flows\n- admin\n"),
          {
            ...makePr("## E2E flows\n- admin\n"),
            number: prNumber + 1,
            state: "closed",
          },
        ],
      },
      statuses: [ambiguityStatus],
    });
    expect(syncAmbiguityClearedDispatch.result.exitCode).toBe(0);
    expect(statusPosts(syncAmbiguityClearedDispatch.calls)).toHaveLength(1);
    expect(statusPosts(syncAmbiguityClearedDispatch.calls)[0]).toContain(
      "state=failure"
    );
    expect(workflowDispatches(syncAmbiguityClearedDispatch.calls)).toHaveLength(
      1
    );
    expect(workflowDispatches(syncAmbiguityClearedDispatch.calls)[0]).toContain(
      "flows=admin"
    );

    // Multi-page `commits/<sha>/pulls`: PR sync must paginate and stay blocked
    // when a second eligible PR sits on page 2 or a later page fails to read.
    const multiPageSyncGh = (
      mode: "ambiguous" | "error"
    ) => `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
if [[ "$*" == *"/commits/${headSha}/pulls"* ]]; then
  if [[ "$*" != *"--paginate"* || "$*" != *"--slurp"* ]]; then
    echo "expected paginated commits/pulls lookup: $*" >&2
    exit 1
  fi
  if [[ "${mode}" == "error" ]]; then
    echo "HTTP 502 on page 2" >&2
    exit 1
  fi
  echo '[[${JSON.stringify(makePr("## E2E flows\n- none\n"))}],[${JSON.stringify({ ...makePr("## E2E flows\n- none\n"), number: prNumber + 1 })}]]'
  exit 0
fi
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  echo '${JSON.stringify(makePr("## E2E flows\n- none\n"))}'
  exit 0
fi
if [[ "$*" == *"/commits/${headSha}/statuses"* ]]; then
  echo '[[${JSON.stringify(ambiguityStatus)}]]'
  exit 0
fi
if [[ "$*" == *"/deployments/11/statuses"* ]]; then
  echo '[{"state":"success","description":"Deployment has completed","environment_url":"${previewUrl}/"}]'
  exit 0
fi
if [[ "$*" == *"/deployments"* ]]; then
  echo '[{"id":11,"creator":{"login":"vercel[bot]"}}]'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const syncPage2Ambiguous = await runSync({
      body: "## E2E flows\n- none\n",
      commands: { gh: multiPageSyncGh("ambiguous") },
    });
    expect(syncPage2Ambiguous.result.exitCode).toBe(0);
    expect(statusPosts(syncPage2Ambiguous.calls)).toEqual([]);

    const syncPage2Error = await runSync({
      body: "## E2E flows\n- none\n",
      commands: { gh: multiPageSyncGh("error") },
    });
    expect(syncPage2Error.result.exitCode).toBe(0);
    expect(statusPosts(syncPage2Error.calls)).toEqual([]);

    // 3. Restoring carried coverage must cite only the commit that actually
    // passed the surviving flows and must never merge distinct carried sources
    // under a single source SHA.
    const carriedProvenanceAfterHeadFail = await runSync({
      body: "## E2E flows\n- webkit\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E failed [flows: admin]",
          state: "failure",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as ccccccc, which passed E2E [flows: admin]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as bbbbbbb, which passed E2E [flows: webkit]",
          state: "success",
        },
      ],
    });
    expect(carriedProvenanceAfterHeadFail.result.exitCode).toBe(0);
    const provenancePosts = statusPosts(carriedProvenanceAfterHeadFail.calls);
    expect(provenancePosts).toHaveLength(1);
    expect(provenancePosts[0]).toContain("state=success");
    expect(provenancePosts[0]).toContain(
      "description=Same tree as bbbbbbb, which passed E2E [flows: webkit]"
    );
    expect(provenancePosts[0]).not.toContain("ccccccc");

    const splitCarriedSources = await runSync({
      body: "## E2E flows\n- admin\n- webkit\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as ccccccc, which passed E2E [flows: admin]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as bbbbbbb, which passed E2E [flows: webkit]",
          state: "success",
        },
      ],
    });
    expect(splitCarriedSources.result.exitCode).toBe(0);
    const splitPosts = statusPosts(splitCarriedSources.calls);
    expect(splitPosts).toHaveLength(1);
    expect(splitPosts[0]).toContain("state=failure");
    expect(workflowDispatches(splitCarriedSources.calls)).toHaveLength(1);
    expect(workflowDispatches(splitCarriedSources.calls)[0]).toContain(
      "flows=admin,webkit"
    );

    // 4. When sync tentatively restores `admin` and a genuine `admin` pass from
    // another run lands concurrently, post-write verification must accept it
    // without overwriting the check with a race failure.
    const statefulConcurrentPassGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
state_file="$GH_FIXTURES/state.txt"
[[ -f "$state_file" ]] || echo "before" > "$state_file"
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  echo '{"number":${prNumber},"state":"open","draft":false,"user":{"login":"author"},"head":{"ref":"${headRef}","sha":"${headSha}","repo":{"full_name":"${repository}"}},"body":"## E2E flows\\n- admin\\n"}'
  exit 0
fi
if [[ "$*" == *"/deployments/11/statuses"* ]]; then
  echo '[{"state":"success","description":"Deployment has completed","environment_url":"${previewUrl}/"}]'
  exit 0
fi
if [[ "$*" == *"/deployments"* ]]; then
  echo '[{"id":11,"creator":{"login":"vercel[bot]"}}]'
  exit 0
fi
if [[ "$*" == *"/commits/${headSha}/statuses"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo '[[{"id":10,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Invalid or missing ## E2E flows in PR description; list valid flows, all, or none"},{"id":9,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"}]]'
  else
    echo '[[{"id":12,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E restored [flows: admin]","target_url":"https://github.com/${repository}/actions/runs/99"},{"id":11,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]","target_url":"https://github.com/${repository}/actions/runs/250"}]]'
  fi
  exit 0
fi
if [[ "$*" == *"/statuses/${headSha}"* ]]; then
  echo "after" > "$state_file"
  echo '{"id":12}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const concurrentPass = await runSync({
      body: "## E2E flows\n- admin\n",
      commands: { gh: statefulConcurrentPassGh },
    });
    expect(concurrentPass.result.exitCode).toBe(0);
    const concurrentPosts = statusPosts(concurrentPass.calls);
    expect(concurrentPosts).toHaveLength(1);
    expect(concurrentPosts[0]).toContain("state=success");
    expect(workflowDispatches(concurrentPass.calls)).toEqual([]);
  });
});
