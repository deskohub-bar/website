import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import { backendPreviewProofFixture } from "./shared/backend-preview-proof-fixture";
import { findStepByName, parseWorkflow } from "./shared/workflow-contract";
import {
  createWorkflowStepRunner,
  workflowStepRepository as repository,
} from "./shared/workflow-step-runner";

const workflow = parseWorkflow(
  resolve(import.meta.dir, "../../../.github/workflows/workspace-e2e.yml")
);
const flowsCli = resolve(
  import.meta.dir,
  "../../../.github/actions/workspace-e2e-flows/cli.mjs"
);
const flowsPublish = resolve(
  import.meta.dir,
  "../../../.github/actions/workspace-e2e-flows/publish-status.mjs"
);
const resolveTargetStep = findStepByName(
  workflow,
  "Resolve eligible PR and immutable preview"
);
const targetStep = resolveTargetStep && {
  ...resolveTargetStep,
  env: { ...resolveTargetStep.env, PILOT_PR_NUMBER: "" },
};
const statusStep = findStepByName(workflow, "Decide status without an E2E run");
const finalStep = findStepByName(workflow, "Publish final commit status");
const publishStep = findStepByName(
  workflow,
  "Publish status without an E2E run"
);

const prNumber = 7;
const sha = (digit: string) => digit.repeat(40);
const targetSha = sha("a");
const previewUrl = "https://deskohub-workspace-site-abc123-team.vercel.app";

type Status = {
  readonly context?: string;
  readonly creator?: string;
  readonly description: string;
  readonly state: string;
};

type Scenario = {
  readonly commits: readonly { readonly sha: string; readonly tree: string }[];
  readonly statuses?: Readonly<Record<string, readonly Status[]>>;
};

const { cleanup, runStep } = createWorkflowStepRunner("workspace-e2e-status-");
afterAll(cleanup);

const decideStatus = (
  deployment: string,
  scenario: Scenario,
  overrides: Readonly<Record<string, string>> = {}
) =>
  runStep(
    statusStep,
    {
      [`pulls/${prNumber}/commits`]: scenario.commits.map((commit) => ({
        commit: { tree: { sha: commit.tree } },
        sha: commit.sha,
      })),
      ...Object.fromEntries(
        Object.entries(scenario.statuses ?? {}).map(([commit, statuses]) => [
          `commits/${commit}/statuses`,
          statuses.map((status) => ({
            context: status.context ?? "Workspace E2E",
            creator: { login: status.creator ?? "github-actions[bot]" },
            description: status.description,
            state: status.state,
          })),
        ])
      ),
    },
    {
      DEPLOYMENT: deployment,
      FLOWS: "all",
      FLOWS_CLI: flowsCli,
      PR_NUMBER: String(prNumber),
      RESOLUTION_ERROR: "",
      TARGET_OUTCOME: "success",
      TARGET_SHA: targetSha,
      ...overrides,
    }
  );

const passed = {
  description: "Protected preview E2E passed",
  state: "success",
} as const;
const failed = {
  description: "Protected preview E2E failed",
  state: "failure",
} as const;
const running = {
  description: "Protected preview E2E is running",
  state: "pending",
} as const;
const superseded = {
  description: String(statusStep?.env?.E2E_SUPERSEDED_DESCRIPTION),
  state: "failure",
} as const;

describe("Workspace E2E status without a run", () => {
  test("never carries a pass across a different tree", async () => {
    // PR #729: an older head passed, the next head's deployment failed, and
    // Vercel skipped the empty retrigger on top of it.
    const { outputs, result } = await decideStatus("skipped", {
      commits: [
        { sha: sha("b"), tree: "tree-old" },
        { sha: sha("c"), tree: "tree-new" },
        { sha: targetSha, tree: "tree-new" },
      ],
      statuses: { [sha("b")]: [passed], [sha("c")]: [] },
    });
    expect(result.exitCode).toBe(0);
    expect(outputs.state).toBe("failure");
    expect(outputs.description).toContain("no E2E-tested commit has its tree");
  });

  test("reuses a run on a commit with the identical tree", async () => {
    const { outputs, result } = await decideStatus("skipped", {
      commits: [
        { sha: sha("b"), tree: "tree-same" },
        { sha: targetSha, tree: "tree-same" },
      ],
      statuses: { [sha("b")]: [passed, running] },
    });
    expect(result.exitCode).toBe(0);
    expect(outputs).toMatchObject({
      description: "Same tree as bbbbbbb, which passed E2E",
      state: "success",
    });
  });

  test("ignores statuses an earlier skip carried forward", async () => {
    const { outputs } = await decideStatus("skipped", {
      commits: [
        { sha: sha("b"), tree: "tree-same" },
        { sha: targetSha, tree: "tree-same" },
      ],
      statuses: {
        [sha("b")]: [
          { description: "Workspace unchanged; E2E skipped", state: "success" },
        ],
      },
    });
    expect(outputs.state).toBe("failure");
  });

  test("ignores other contexts and other publishers", async () => {
    const { outputs } = await decideStatus("skipped", {
      commits: [
        { sha: sha("b"), tree: "tree-same" },
        { sha: targetSha, tree: "tree-same" },
      ],
      statuses: {
        [sha("b")]: [
          { ...passed, context: "Workspace E2E allocation" },
          { ...passed, creator: "someone" },
        ],
      },
    });
    expect(outputs.state).toBe("failure");
  });

  test("takes the nearest identical-tree run, including a failure", async () => {
    const { outputs } = await decideStatus("skipped", {
      commits: [
        { sha: sha("b"), tree: "tree-same" },
        { sha: sha("c"), tree: "tree-same" },
        { sha: sha("d"), tree: "tree-same" },
        { sha: targetSha, tree: "tree-same" },
      ],
      statuses: { [sha("b")]: [passed], [sha("c")]: [failed], [sha("d")]: [] },
    });
    expect(outputs).toMatchObject({
      description: "Same tree as ccccccc, which failed E2E",
      state: "failure",
    });
  });

  test("asks for a rerun while the identical-tree run is still running", async () => {
    const { outputs } = await decideStatus("skipped", {
      commits: [
        { sha: sha("b"), tree: "tree-same" },
        { sha: targetSha, tree: "tree-same" },
      ],
      statuses: { [sha("b")]: [running] },
    });
    expect(outputs.state).toBe("failure");
    expect(outputs.description).toContain("rerun this check");
  });

  test("passes over a run a newer head superseded", async () => {
    // The superseded run published "running", then stopped without a result.
    const { outputs, result } = await decideStatus("skipped", {
      commits: [
        { sha: sha("b"), tree: "tree-same" },
        { sha: sha("c"), tree: "tree-same" },
        { sha: targetSha, tree: "tree-same" },
      ],
      statuses: { [sha("b")]: [passed], [sha("c")]: [superseded, running] },
    });
    expect(result.exitCode).toBe(0);
    expect(outputs).toMatchObject({
      description: "Same tree as bbbbbbb, which passed E2E",
      state: "success",
    });
  });

  test("fails with a published description when the target is missing from the PR history", async () => {
    const { outputs, result } = await decideStatus("skipped", {
      commits: [{ sha: sha("b"), tree: "tree-same" }],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing from the matching PR history");
    expect(outputs.state).toBe("failure");
    expect(outputs.description).toContain("missing from this PR's commit list");
  });

  test("fails a failed deployment with an actionable description", async () => {
    const { outputs, result } = await decideStatus("failed", { commits: [] });
    expect(result.exitCode).toBe(0);
    expect(outputs).toMatchObject({
      description:
        "Vercel preview deployment failed; fix or redeploy it to run E2E",
      state: "failure",
    });
  });

  test("keeps every published status description within GitHub's limit", () => {
    const descriptions = [
      ...(statusStep?.run ?? "").matchAll(/decide \w+ ["']([^"']+)["']/g),
      ...(targetStep?.run ?? "").matchAll(
        /fail ["'][^"']+["'] \\\n\s+["']([^"']+)["']/g
      ),
      ...String(publishStep?.env?.STATUS_DESCRIPTION).matchAll(
        /\|\| '([^']+)'/g
      ),
      ["", superseded.description],
    ].map(([, description]) => description ?? "");
    expect(descriptions.length).toBeGreaterThanOrEqual(10);
    for (const description of descriptions) {
      expect(
        description.replace(/\$\{sha:0:7\}/, "0000000").length
      ).toBeLessThanOrEqual(140);
    }
  });

  test("recognizes exactly the descriptions a real run publishes", () => {
    const descriptions = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.String))
    )(String(statusStep?.env?.E2E_RUN_DESCRIPTIONS));
    const publishers = [
      findStepByName(workflow, "Publish pending commit status"),
      findStepByName(workflow, "Publish final commit status"),
    ]
      .map((step) => step?.run ?? "")
      .join("\n");
    for (const description of descriptions) {
      expect(publishers).toContain(description);
    }
    expect(descriptions).toHaveLength(3);
    expect(superseded.description).toBe(
      String(
        findStepByName(workflow, "Publish final commit status")?.env
          ?.SUPERSEDED_DESCRIPTION
      )
    );
  });
});

type DeploymentStatus = {
  readonly description: string;
  readonly state: string;
};

const pullRequest = {
  body: "## Summary\n\nChange\n\n## E2E flows\n- `all`\n",
  draft: false,
  head: { ref: "feature/x", repo: { full_name: repository }, sha: targetSha },
  number: prNumber,
  state: "open",
  user: { login: "author" },
};

const resolveTarget = (
  deployment: string,
  deploymentStatus: DeploymentStatus | null,
  pulls: readonly object[] = [pullRequest],
  overrides: Readonly<Record<string, string>> = {}
) =>
  runStep(
    targetStep,
    {
      deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
      "deployments/11/statuses": deploymentStatus
        ? [{ ...deploymentStatus, environment_url: `${previewUrl}/` }]
        : [],
      [`commits/${targetSha}/pulls`]: pulls,
    },
    {
      EVENT_NAME: "repository_dispatch",
      FLOWS_CLI: flowsCli,
      INCLUDE_NIGHTLY_CASES: "false",
      INPUT_FLOWS: "",
      TARGET_DEPLOYMENT: deployment,
      TARGET_REF: "feature/x",
      TARGET_SHA: targetSha,
      TARGET_URL: previewUrl,
      ...overrides,
    }
  );

const deploymentSucceeded = {
  description: "Deployment has completed",
  state: "success",
} as const;

describe("Workspace E2E target resolution", () => {
  test("accepts a failed deployment only with a failed exact-SHA status", async () => {
    const accepted = await resolveTarget("failed", {
      description: "Deployment has failed",
      state: "failure",
    });
    expect(accepted.result.exitCode).toBe(0);
    expect(accepted.outputs).toMatchObject({
      deployment: "failed",
      eligible: "true",
      pr_number: String(prNumber),
    });

    const rejected = await resolveTarget("failed", deploymentSucceeded);
    expect(rejected.result.exitCode).not.toBe(0);
    expect(rejected.outputs.url).toBeUndefined();
  });

  test("accepts a skip only with Vercel's skipped status", async () => {
    const accepted = await resolveTarget("skipped", {
      description: "Skipped - Not affected",
      state: "inactive",
    });
    expect(accepted.outputs.deployment).toBe("skipped");

    const rejected = await resolveTarget("skipped", {
      description: "Deployment has failed",
      state: "failure",
    });
    expect(rejected.result.exitCode).not.toBe(0);
    expect(rejected.outputs.url).toBeUndefined();
  });

  test("rejects deployment states it does not handle", async () => {
    const { outputs, result } = await resolveTarget("canceled", {
      description: "Deployment has been canceled",
      state: "inactive",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsupported Vercel deployment state");
    expect(outputs.eligible).toBeUndefined();
  });

  test("leaves an event for a superseded head ineligible before reading its preview", async () => {
    // A late event for an older head: the PR has moved on, so the run never
    // reaches the E2E job and its concurrency group, which alone cancels.
    const { calls, outputs, result } = await resolveTarget(
      "success",
      deploymentSucceeded,
      [{ ...pullRequest, head: { ...pullRequest.head, sha: sha("f") } }]
    );
    expect(result.exitCode).toBe(0);
    expect(outputs).toEqual({ eligible: "false" });
    expect(calls.some((call) => call.includes("/deployments"))).toBe(false);
  });

  test("keeps the eligible head and a recovery description when its preview record is missing", async () => {
    const { outputs, result } = await resolveTarget("success", null);
    expect(result.exitCode).not.toBe(0);
    expect(outputs).toMatchObject({
      eligible: "true",
      pr_number: String(prNumber),
      sha: targetSha,
    });
    expect(outputs.resolution_error).toContain("re-run the failed jobs");
    expect(outputs.url).toBeUndefined();
  });

  test("records a failure when more than one eligible PR has the head", async () => {
    const { outputs, result } = await resolveTarget(
      "success",
      deploymentSucceeded,
      [pullRequest, { ...pullRequest, number: prNumber + 1 }]
    );
    expect(result.exitCode).not.toBe(0);
    expect(outputs.eligible).toBe("true");
    expect(outputs.resolution_error).toContain("More than one open PR");
    expect(outputs.pr_number).toBeUndefined();
  });
});

const nightlyBranch = String(targetStep?.env?.NIGHTLY_BRANCH);

const resolveNightlyTarget = ({
  eventName = "workflow_dispatch",
  includeNightlyCases = "true",
  mainRelation = "ahead",
  nightlyHead = targetSha,
  pulls = [],
}: {
  readonly eventName?: string;
  readonly includeNightlyCases?: "false" | "true";
  readonly mainRelation?: string;
  readonly nightlyHead?: string;
  readonly pulls?: readonly object[];
} = {}) =>
  runStep(
    targetStep,
    {
      [`commits/${targetSha}/pulls`]: pulls,
      [`compare/${targetSha}...main`]: { status: mainRelation },
      deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
      "deployments/11/statuses": [
        { ...deploymentSucceeded, environment_url: `${previewUrl}/` },
      ],
      [`git/ref/heads/${nightlyBranch}`]: { object: { sha: nightlyHead } },
    },
    {
      EVENT_NAME: eventName,
      FLOWS_CLI: flowsCli,
      INCLUDE_NIGHTLY_CASES: includeNightlyCases,
      INPUT_FLOWS: "",
      TARGET_DEPLOYMENT: "success",
      TARGET_REF: nightlyBranch,
      TARGET_SHA: targetSha,
      TARGET_URL: previewUrl,
    }
  );

describe("Workspace E2E nightly target resolution", () => {
  test("accepts the nightly branch head on main without a PR", async () => {
    const { outputs, result } = await resolveNightlyTarget();
    expect(result.exitCode).toBe(0);
    expect(outputs).toEqual({
      deployment: "success",
      eligible: "true",
      flows: "all",
      head_ref: nightlyBranch,
      install_webkit: "true",
      nightly: "true",
      nightly_cases: "true",
      run_e2e: "true",
      sha: targetSha,
      url: previewUrl,
    });
  });

  test("runs only the default cases on a nightly target that doesn't ask for more", async () => {
    const { outputs, result } = await resolveNightlyTarget({
      includeNightlyCases: "false",
    });
    expect(result.exitCode).toBe(0);
    expect(outputs.nightly).toBe("true");
    expect(outputs.nightly_cases).toBeUndefined();
  });

  test("refuses nightly cases for a PR target before it resolves the PR", async () => {
    // D38: nightly cases test main only, so this dispatch fails without
    // marking the PR eligible, which would publish its required status.
    const { calls, outputs, result } = await resolveTarget(
      "success",
      deploymentSucceeded,
      [pullRequest],
      { EVENT_NAME: "workflow_dispatch", INCLUDE_NIGHTLY_CASES: "true" }
    );
    expect(result.exitCode).not.toBe(0);
    expect(outputs).toEqual({});
    expect(calls).toEqual([]);
  });

  test("never passes nightly cases to the suite without a validated nightly target", () => {
    expect(
      findStepByName(workflow, "Run checkout E2E")?.env
        ?.WORKSPACE_E2E_NIGHTLY_CASES
    ).toBe(
      `\${{ needs.resolve-target.outputs.nightly == 'true' && needs.resolve-target.outputs.nightly_cases == 'true' && 'true' || '' }}`
    );
    expect(workflow.jobs["resolve-target"]?.outputs?.nightly_cases).toBe(
      `\${{ steps.target.outputs.nightly_cases }}`
    );
  });

  test("accepts main's own head", async () => {
    const { result } = await resolveNightlyTarget({
      mainRelation: "identical",
    });
    expect(result.exitCode).toBe(0);
  });

  test("refuses a SHA the nightly branch no longer points at", async () => {
    const { outputs, result } = await resolveNightlyTarget({
      nightlyHead: sha("f"),
    });
    expect(result.exitCode).not.toBe(0);
    expect(outputs.nightly).toBe("true");
    expect(outputs.url).toBeUndefined();
  });

  test("refuses a nightly branch head outside main", async () => {
    const { outputs, result } = await resolveNightlyTarget({
      mainRelation: "diverged",
    });
    expect(result.exitCode).not.toBe(0);
    expect(outputs.url).toBeUndefined();
  });

  test("leaves Vercel's own nightly branch events ineligible", async () => {
    // Only the nightly workflow's dispatch tests the branch, after it has
    // waited for the preview.
    for (const pulls of [
      [],
      [{ ...pullRequest, head: { ...pullRequest.head, ref: nightlyBranch } }],
    ]) {
      const { outputs, result } = await resolveNightlyTarget({
        eventName: "repository_dispatch",
        includeNightlyCases: "false",
        pulls,
      });
      expect(result.exitCode).toBe(0);
      expect(outputs).toEqual({ eligible: "false" });
    }
  });

  test("publishes no PR status for a nightly target", () => {
    const nightlyOff = "needs.resolve-target.outputs.nightly != 'true'";
    expect(statusStep?.if).toContain("steps.target.outputs.nightly != 'true'");
    for (const job of [
      "cancel-superseded-run",
      "publish-final-status",
      "publish-status-without-run",
    ]) {
      expect(workflow.jobs[job]?.if).toContain(nightlyOff);
    }
    for (const name of [
      "Stop unless this SHA is still the PR head",
      "Release the lease unless this SHA is still the PR head",
      "Publish allocation status",
      "Publish pending commit status",
    ]) {
      expect(findStepByName(workflow, name)?.if).toBe(nightlyOff);
    }
    expect(workflow.jobs["resolve-target"]?.outputs?.nightly).toContain(
      "steps.target.outputs.nightly"
    );
  });
});

describe("Workspace E2E status after a failed resolution", () => {
  // The publishing job's expression falls back to this generic failure.
  const [, fallbackDescription = ""] =
    /\|\| '([^']+)'/.exec(String(publishStep?.env?.STATUS_DESCRIPTION)) ?? [];

  const publishedStatus = async (
    target: Awaited<ReturnType<typeof resolveTarget>>
  ) => {
    const decided = await runStep(
      statusStep,
      {},
      {
        DEPLOYMENT: target.outputs.deployment ?? "",
        FLOWS: target.outputs.flows ?? "",
        FLOWS_CLI: flowsCli,
        PR_NUMBER: target.outputs.pr_number ?? "",
        RESOLUTION_ERROR: target.outputs.resolution_error ?? "",
        RESOLUTION_ERROR_KIND: target.outputs.resolution_error_kind ?? "",
        TARGET_OUTCOME: target.result.exitCode === 0 ? "success" : "failure",
        TARGET_SHA: target.outputs.sha ?? "",
      }
    );
    expect(decided.result.exitCode).toBe(0);
    const published = await runStep(
      publishStep,
      { [`statuses/${targetSha}`]: [] },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: target.outputs.pr_number ?? "",
        STATUS_DESCRIPTION: decided.outputs.description ?? fallbackDescription,
        STATUS_REASON: decided.outputs.reason ?? "",
        STATUS_STATE: decided.outputs.state ?? "failure",
        TARGET_SHA: target.outputs.sha ?? "",
      }
    );
    expect(published.result.exitCode).toBe(0);
    return published.calls;
  };

  test("publishes the recovery description for a missing preview record", async () => {
    const calls = await publishedStatus(await resolveTarget("success", null));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`repos/${repository}/statuses/${targetSha}`);
    expect(calls[0]).toContain("state=failure");
    expect(calls[0]).toContain("context=Workspace E2E");
    expect(calls[0]).toContain(
      "No Vercel deployment record matches this preview yet"
    );
    expect(calls[0]).toMatch(/\[preview: success:[0-9a-f]{8}\]/);

    // A failed event whose URL only has a successful deployment record must
    // also fail closed and persist the expected `failed` outcome in its tag.
    const failedOutcomeMismatch = await publishedStatus(
      await resolveTarget("failed", deploymentSucceeded)
    );
    expect(failedOutcomeMismatch).toHaveLength(1);
    expect(failedOutcomeMismatch[0]).toContain("state=failure");
    expect(failedOutcomeMismatch[0]).toMatch(/\[preview: failed:[0-9a-f]{8}\]/);
  });

  test("publishes a failure when the target step failed without a description", async () => {
    const target = await resolveTarget("success", deploymentSucceeded);
    const calls = await publishedStatus({
      ...target,
      outputs: { eligible: "true", sha: targetSha },
      result: { ...target.result, exitCode: 1 },
    });
    expect(calls[0]).toContain("state=failure");
    expect(fallbackDescription).toContain("re-run the failed jobs");
    expect(calls[0]).toContain(`description=${fallbackDescription}`);
  });

  test("routes every eligible head without an E2E run to the status publisher", () => {
    const resolveJob = workflow.jobs["resolve-target"];
    expect(resolveJob?.outputs?.eligible).toContain("steps.target.outputs");
    expect(resolveJob?.outputs?.status_description).toContain(
      "steps.status-without-run.outputs.description"
    );
    expect(resolveJob?.outputs?.status_state).toContain(
      "steps.status-without-run.outputs.state"
    );
    expect(statusStep?.if).toContain("!cancelled()");
    expect(statusStep?.if).toContain("steps.target.outcome != 'success'");
    const withoutRun = workflow.jobs["publish-status-without-run"]?.if ?? "";
    expect(withoutRun).toContain("!cancelled()");
    expect(withoutRun).toContain("needs.resolve-target.result != 'success'");
    // The final-status job owns only heads whose resolution succeeded.
    expect(workflow.jobs["publish-final-status"]?.if).toContain(
      "needs.resolve-target.result == 'success'"
    );
  });
});

describe("Workspace E2E selective PR flows", () => {
  test("fails closed when the PR description lacks a valid ## E2E flows section", async () => {
    const { outputs, result } = await resolveTarget(
      "success",
      deploymentSucceeded,
      [{ ...pullRequest, body: "## Summary\nMissing flows" }]
    );
    expect(result.exitCode).not.toBe(0);
    expect(outputs.eligible).toBe("true");
    expect(outputs.resolution_error).toContain("## E2E flows");
  });

  test("resolves a subset PR flow list and skips WebKit unless webkit is requested", async () => {
    const subset = await resolveTarget("success", deploymentSucceeded, [
      { ...pullRequest, body: "## E2E flows\n- `email-campaigns`\n- admin\n" },
    ]);
    expect(subset.result.exitCode).toBe(0);
    expect(subset.outputs).toMatchObject({
      flows: "admin,email-campaigns",
      install_webkit: "false",
      run_e2e: "true",
    });

    const withWebkit = await resolveTarget("success", deploymentSucceeded, [
      { ...pullRequest, body: "## E2E flows\n- webkit\n" },
    ]);
    expect(withWebkit.result.exitCode).toBe(0);
    expect(withWebkit.outputs).toMatchObject({
      flows: "webkit",
      install_webkit: "true",
      run_e2e: "true",
    });
  });

  test("skips running E2E when PR declares none and publishes a skipped success status", async () => {
    const resolved = await resolveTarget("success", deploymentSucceeded, [
      { ...pullRequest, body: "## E2E flows\n- `none`\n" },
    ]);
    expect(resolved.result.exitCode).toBe(0);
    expect(resolved.outputs).toMatchObject({
      flows: "none",
      install_webkit: "false",
      run_e2e: "false",
    });

    const decided = await decideStatus(
      "success",
      { commits: [] },
      {
        FLOWS: "none",
      }
    );
    expect(decided.result.exitCode).toBe(0);
    expect(decided.outputs).toMatchObject({
      description: "Protected preview E2E skipped [flows: none]",
      state: "success",
    });
  });

  test("fails a skipped deployment when the same-tree commit passed only a smaller flow subset", async () => {
    const { outputs, result } = await decideStatus(
      "skipped",
      {
        commits: [
          { sha: sha("b"), tree: "tree-same" },
          { sha: targetSha, tree: "tree-same" },
        ],
        statuses: {
          [sha("b")]: [
            {
              description: "Protected preview E2E passed [flows: admin]",
              state: "success",
            },
          ],
        },
      },
      { FLOWS: "admin,email-campaigns" }
    );
    expect(result.exitCode).toBe(0);
    expect(outputs.state).toBe("failure");
    expect(outputs.description).toContain("lacks required E2E flows");
  });

  test("reuses a genuine partial pass from a same-tree commit when it covers the requested flows", async () => {
    const covered = await decideStatus(
      "skipped",
      {
        commits: [
          { sha: sha("b"), tree: "tree-same" },
          { sha: targetSha, tree: "tree-same" },
        ],
        statuses: {
          [sha("b")]: [
            {
              description:
                "Protected preview E2E partial; more flows required [flows: admin]",
              state: "failure",
            },
          ],
        },
      },
      { FLOWS: "admin" }
    );
    expect(covered.result.exitCode).toBe(0);
    expect(covered.outputs).toMatchObject({
      description: "Same tree as bbbbbbb, which passed E2E [flows: admin]",
      state: "success",
    });

    const uncovered = await decideStatus(
      "skipped",
      {
        commits: [
          { sha: sha("b"), tree: "tree-same" },
          { sha: targetSha, tree: "tree-same" },
        ],
        statuses: {
          [sha("b")]: [
            {
              description:
                "Protected preview E2E partial; more flows required [flows: admin]",
              state: "failure",
            },
          ],
        },
      },
      { FLOWS: "admin,email-campaigns" }
    );
    expect(uncovered.result.exitCode).toBe(0);
    expect(uncovered.outputs.state).toBe("failure");
    expect(uncovered.outputs.description).toContain("lacks required E2E flows");
    expect(uncovered.outputs.description).not.toContain("which failed E2E");
  });

  test("unions newly passed flows with prior passing flows on the same SHA in publish-final-status", async () => {
    const { calls, result } = await runStep(
      finalStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- `admin`\n- `email-campaigns`\n",
          head: { sha: targetSha },
        },
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`commits/${targetSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E passed [flows: admin]",
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        ALLOCATION_SHARD: "1",
        FLOWS: "email-campaigns",
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(result.exitCode).toBe(0);
    const e2ePost = calls.find(
      (call) =>
        call.includes(`statuses/${targetSha}`) &&
        call.includes("context=Workspace E2E") &&
        !call.includes("context=Workspace E2E allocation")
    );
    expect(e2ePost).toContain("state=success");
    expect(e2ePost).toContain(
      "description=Protected preview E2E passed [flows: admin,email-campaigns]"
    );
  });

  test("fails closed on manual workflow_dispatch when the PR description is invalid or conflicts with flows=none", async () => {
    const invalidBody = await resolveTarget(
      "success",
      deploymentSucceeded,
      [{ ...pullRequest, body: "## Summary\nNo flows section" }],
      { EVENT_NAME: "workflow_dispatch", INPUT_FLOWS: "admin" }
    );
    expect(invalidBody.result.exitCode).not.toBe(0);
    expect(invalidBody.outputs.resolution_error).toContain("## E2E flows");

    const noneConflict = await resolveTarget(
      "success",
      deploymentSucceeded,
      [{ ...pullRequest, body: "## E2E flows\n- admin\n" }],
      { EVENT_NAME: "workflow_dispatch", INPUT_FLOWS: "none" }
    );
    expect(noneConflict.result.exitCode).not.toBe(0);
    expect(noneConflict.outputs.resolution_error).toContain("flows=none");
    expect(noneConflict.outputs.resolution_error_kind).toBe(
      "manual-none-conflict"
    );

    // Even when an earlier `admin` pass exists, publishing a conflicting manual
    // `flows=none` dispatch must keep the failure while the PR still requests
    // `admin`, and only clear once the PR selection itself changes to `none`.
    const keptConflict = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- admin\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E passed [flows: admin]",
            state: "success",
          },
        ],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: noneConflict.outputs.resolution_error ?? "",
        STATUS_REASON: "manual-none-conflict",
        STATUS_STATE: "failure",
        TARGET_SHA: targetSha,
      }
    );
    expect(keptConflict.result.exitCode).toBe(0);
    const conflictPosts = keptConflict.calls.filter((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(conflictPosts.at(-1)).toContain("state=failure");
    expect(conflictPosts.at(-1)).toContain("flows=none");
  });

  test("publishes partial failure when PR flows widened mid-run and later unions partial coverage to pass", async () => {
    const deploymentOk = {
      deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
      "deployments/11/statuses": [
        {
          description: "Deployment has completed",
          environment_url: `${previewUrl}/`,
          state: "success",
        },
      ],
    };
    const partialRun = await runStep(
      finalStep,
      {
        ...deploymentOk,
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- admin\n- email-campaigns\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [],
        [`statuses/${targetSha}`]: {},
      },
      {
        ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        ALLOCATION_SHARD: "1",
        FLOWS: "admin",
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(partialRun.result.exitCode).toBe(0);
    const partialPost = partialRun.calls.find(
      (call) =>
        call.includes(`statuses/${targetSha}`) &&
        call.includes("context=Workspace E2E") &&
        !call.includes("context=Workspace E2E allocation")
    );
    expect(partialPost).toContain("state=failure");
    expect(partialPost).toContain(
      "description=Protected preview E2E partial; more flows required [flows: admin]"
    );

    const completionRun = await runStep(
      finalStep,
      {
        ...deploymentOk,
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- admin\n- email-campaigns\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description:
              "Protected preview E2E partial; more flows required [flows: admin]",
            state: "failure",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        ALLOCATION_SHARD: "1",
        FLOWS: "email-campaigns",
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(completionRun.result.exitCode).toBe(0);
    const completePost = completionRun.calls.find(
      (call) =>
        call.includes(`statuses/${targetSha}`) &&
        call.includes("context=Workspace E2E") &&
        !call.includes("context=Workspace E2E allocation")
    );
    expect(completePost).toContain("state=success");
    expect(completePost).toContain(
      "description=Protected preview E2E passed [flows: admin,email-campaigns]"
    );
  });

  test("refuses to publish success when deployment state cannot be read", async () => {
    const finalUnreadable = await runStep(
      finalStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- admin\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [],
        [`statuses/${targetSha}`]: {},
      },
      {
        ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        ALLOCATION_SHARD: "1",
        FLOWS: "admin",
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(finalUnreadable.result.exitCode).toBe(0);
    const finalPost = finalUnreadable.calls.find(
      (call) =>
        call.includes(`statuses/${targetSha}`) &&
        call.includes("context=Workspace E2E") &&
        !call.includes("context=Workspace E2E allocation")
    );
    expect(finalPost).toContain("state=failure");
    expect(finalPost).toContain("deployment state could not be verified");

    const withoutRunUnreadable = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(withoutRunUnreadable.result.exitCode).toBe(0);
    const withoutRunPost = withoutRunUnreadable.calls.find((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(withoutRunPost).toContain("state=failure");
    expect(withoutRunPost).toContain("deployment state could not be verified");
  });

  test("reconciles live PR body and preview state before publish-status-without-run posts success", async () => {
    const editedAwayFromNone = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- admin\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(editedAwayFromNone.result.exitCode).toBe(0);
    const post = editedAwayFromNone.calls.find((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(post).toContain("state=failure");
    expect(post).toContain("PR E2E flows changed");

    const failedDeployment = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          { description: "Deployment has failed", state: "failure" },
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(failedDeployment.result.exitCode).toBe(0);
    const failedPost = failedDeployment.calls.find((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(failedPost).toContain("state=failure");
    expect(failedPost).toContain("Vercel preview deployment failed");
  });

  test("catches an interleaved PR invalidation and validation failure during publish-final-status", async () => {
    // Controlled interleaving: read 1 returns a valid PR body (`admin`), then
    // before post 1 finishes, the PR body is invalidated and validation posts
    // failure. Post-write verification must detect the race and publish failure
    // last so Workspace E2E never stays green.
    const statefulGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
state_file="$GH_FIXTURES/state.txt"
[[ -f "$state_file" ]] || echo "before" > "$state_file"
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo '{"head":{"sha":"${targetSha}"},"body":"## E2E flows\\n- admin\\n"}'
  else
    echo '{"head":{"sha":"${targetSha}"},"body":"## Summary\\nRemoved flows"}'
  fi
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
if [[ "$*" == *"/commits/${targetSha}/statuses"* ]]; then
  if [[ "$(cat "$state_file")" == "before" ]]; then
    echo '[[]]'
  else
    echo '[[{"id":200,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"},{"id":199,"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"failure","description":"Invalid or missing ## E2E flows in PR description; list valid flows, all, or none"}]]'
  fi
  exit 0
fi
if [[ "$*" == *"/statuses/${targetSha}"* ]]; then
  echo "after" > "$state_file"
  echo '{"id":200}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const { calls, result } = await runStep(
      finalStep,
      {},
      {
        ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        ALLOCATION_SHARD: "1",
        FLOWS: "admin",
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      },
      { gh: statefulGh }
    );
    expect(result.exitCode).toBe(0);
    const e2ePosts = calls.filter(
      (call) =>
        call.includes(`statuses/${targetSha}`) &&
        call.includes("context=Workspace E2E") &&
        !call.includes("context=Workspace E2E allocation")
    );
    expect(e2ePosts.length).toBeGreaterThanOrEqual(2);
    expect(e2ePosts.at(-1)).toContain("state=failure");
    expect(e2ePosts.at(-1)).toContain("Invalid or missing ## E2E flows");
  });

  test("refuses success when the newest deployment is in_progress above an older success or head history is unreadable", async () => {
    const unresolvedDeployment = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [],
        deployments: [
          { creator: { login: "vercel[bot]" }, id: 12 },
          { creator: { login: "vercel[bot]" }, id: 11 },
        ],
        "deployments/12/statuses": [
          { description: "Deployment in progress", state: "in_progress" },
        ],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(unresolvedDeployment.result.exitCode).toBe(0);
    const unresolvedPost = unresolvedDeployment.calls.find((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(unresolvedPost).toContain("state=failure");
    expect(unresolvedPost).toContain("deployment state could not be verified");

    const unreadableCarried = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- admin\n",
          head: { sha: targetSha },
        },
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          { description: "Skipped - Not affected", state: "inactive" },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION:
          "Same tree as bbbbbbb, which passed E2E [flows: admin]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(unreadableCarried.result.exitCode).toBe(0);
    const carriedPost = unreadableCarried.calls.find((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(carriedPost).toContain("state=failure");
    expect(carriedPost).toContain("could not verify commit statuses");

    const unreadableAllFlows = await runStep(
      finalStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- all\n",
          head: { sha: targetSha },
        },
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        ALLOCATION_DESCRIPTION: "Workspace E2E shard released",
        ALLOCATION_SHARD: "1",
        FLOWS: "all",
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(unreadableAllFlows.result.exitCode).toBe(0);
    const allPost = unreadableAllFlows.calls.find(
      (call) =>
        call.includes(`statuses/${targetSha}`) &&
        call.includes("context=Workspace E2E") &&
        !call.includes("context=Workspace E2E allocation")
    );
    expect(allPost).toContain("state=failure");
    expect(allPost).toContain("could not verify commit statuses");
  });

  test("reconciles a delayed no-run failure to none after the PR description was fixed", async () => {
    const delayedFailure = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E skipped [flows: none]",
            state: "success",
          },
        ],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION:
          "Invalid or missing ## E2E flows in PR description; list valid flows, all, or none",
        STATUS_REASON: "invalid-pr-flows",
        STATUS_STATE: "failure",
        TARGET_SHA: targetSha,
      }
    );
    expect(delayedFailure.result.exitCode).toBe(0);
    const posts = delayedFailure.calls.filter((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(posts.at(-1)).toContain("state=success");
    expect(posts.at(-1)).toContain(
      "description=Protected preview E2E skipped [flows: none]"
    );
  });

  test("never clears a preview-record-mismatch failure using an unrelated succeeded deployment", async () => {
    const mismatch = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION:
          "No Vercel deployment record matches this preview yet; re-run the failed jobs of this Workspace E2E run",
        STATUS_REASON: "preview-record-mismatch",
        STATUS_STATE: "failure",
        TARGET_SHA: targetSha,
      }
    );
    expect(mismatch.result.exitCode).toBe(0);
    const posts = mismatch.calls.filter((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    expect(posts[0]).toContain(
      "No Vercel deployment record matches this preview yet"
    );

    // A delayed `skipped-none` publisher for an older successful preview A must
    // NOT overwrite an unresolved preview-record-mismatch posted for a newer
    // preview B on the same SHA.
    const delayedOlderPreview = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description:
              "No Vercel deployment record matches this preview yet; re-run the failed jobs [preview: failed:deadbeef]",
            state: "failure",
          },
        ],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(delayedOlderPreview.result.exitCode).toBe(0);
    const delayedPosts = delayedOlderPreview.calls.filter((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(delayedPosts).toEqual([]);

    // Historical PR-ambiguity failures must block while two eligible PRs still
    // share the head, and clear once one PR closes and fresh resolution
    // confirms a single eligible PR on the same SHA.
    const ambiguityFailure = {
      context: "Workspace E2E",
      creator: { login: "github-actions[bot]" },
      description: "More than one open PR has this head; E2E needs exactly one",
      state: "failure",
    };
    const stillAmbiguous = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/pulls`]: [
          pullRequest,
          { ...pullRequest, number: prNumber + 1 },
        ],
        [`commits/${targetSha}/statuses`]: [ambiguityFailure],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(stillAmbiguous.result.exitCode).toBe(0);
    expect(
      stillAmbiguous.calls.filter((call) =>
        call.includes(`statuses/${targetSha}`)
      )
    ).toEqual([]);

    const ambiguityCleared = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/pulls`]: [
          pullRequest,
          { ...pullRequest, number: prNumber + 1, state: "closed" },
        ],
        [`commits/${targetSha}/statuses`]: [ambiguityFailure],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(ambiguityCleared.result.exitCode).toBe(0);
    const clearedPosts = ambiguityCleared.calls.filter((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(clearedPosts).toHaveLength(1);
    expect(clearedPosts[0]).toContain("state=success");
    expect(clearedPosts[0]).toContain(
      "description=Protected preview E2E skipped [flows: none]"
    );

    // Multi-page `commits/<sha>/pulls` and branch-specific `pulls`: each page
    // is fetched and parsed independently via `gh api -i` + `Link: rel="next"`.
    // - A second eligible PR on page 2 keeps ambiguity unresolved in BOTH
    //   target resolution and publish-status-without-run.
    // - When page 1 matches the branch and SHA and page 2 returns HTTP 502
    //   (even with a truncated/non-JSON error body AND when the other PR
    //   lookup also fails), the resolver preserves page 1's verified match so
    //   publish-status-without-run overwrites a prior green status with failure.
    // - A successful empty branch lookup (`[]`) honors `eligible=false` so an
    //   unrelated branch sharing the same SHA leaves the healthy PR untouched.
    const multiPageGh = (
      secondPageMode:
        | "ambiguous"
        | "branch-fallback-page2-502"
        | "page1-then-502"
        | "unrelated-branch"
    ) => `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
if [[ "$*" == *"/commits/${targetSha}/pulls"* ]]; then
  if [[ "$*" == *"--slurp"* ]]; then
    echo '[[${JSON.stringify(pullRequest)}],[${JSON.stringify({ ...pullRequest, number: prNumber + 1 })}]]'
    exit 0
  fi
  if [[ "${secondPageMode}" == "branch-fallback-page2-502" || "${secondPageMode}" == "unrelated-branch" ]]; then
    printf 'HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n<html>502 Bad Gateway'
    echo "gh: 502 Bad Gateway (HTTP 502)" >&2
    exit 1
  fi
  if [[ "$*" == *"page=2"* ]]; then
    if [[ "${secondPageMode}" == "page1-then-502" ]]; then
      printf 'HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n[{"truncated":'
      echo "gh: 502 Bad Gateway (HTTP 502)" >&2
      exit 1
    fi
    printf 'HTTP/2.0 200 OK\\r\\n\\r\\n[%s]' '${JSON.stringify({ ...pullRequest, number: prNumber + 1 })}'
    exit 0
  fi
  printf 'HTTP/2.0 200 OK\\r\\nLink: <https://api.github.com/repos/${repository}/commits/${targetSha}/pulls?per_page=100&page=2>; rel="next"\\r\\n\\r\\n[%s]' '${JSON.stringify(pullRequest)}'
  exit 0
fi
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  echo '{"body":"## E2E flows\\n- none\\n","head":{"sha":"${targetSha}"}}'
  exit 0
fi
if [[ "$*" == *"repos/${repository}/pulls"* ]]; then
  if [[ "${secondPageMode}" == "page1-then-502" ]]; then
    printf 'HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n<html>502'
    echo "gh: 502 Bad Gateway (HTTP 502)" >&2
    exit 1
  fi
  if [[ "${secondPageMode}" == "branch-fallback-page2-502" && "$*" == *"head=owner:${pullRequest.head.ref}"* ]]; then
    if [[ "$*" == *"page=2"* ]]; then
      printf 'HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n{"message":"Bad Gateway"'
      echo "gh: 502 Bad Gateway (HTTP 502)" >&2
      exit 1
    fi
    printf 'HTTP/2.0 200 OK\\r\\nLink: <https://api.github.com/repos/${repository}/pulls?state=open&head=owner:${pullRequest.head.ref}&per_page=100&page=2>; rel="next"\\r\\n\\r\\n[%s]' '${JSON.stringify(pullRequest)}'
    exit 0
  fi
  printf 'HTTP/2.0 200 OK\\r\\n\\r\\n[]'
  exit 0
fi
if [[ "$*" == *"/commits/${targetSha}/statuses"* ]]; then
  if [[ "${secondPageMode}" == "ambiguous" ]]; then
    echo '[[${JSON.stringify(ambiguityFailure)}]]'
  else
    echo '[[{"context":"Workspace E2E","creator":{"login":"github-actions[bot]"},"state":"success","description":"Protected preview E2E passed [flows: admin]"}]]'
  fi
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
if [[ "$*" == *"/statuses/${targetSha}"* ]]; then
  echo '{"id":500}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
    const page2Target = await runStep(
      targetStep,
      {},
      {
        EVENT_NAME: "repository_dispatch",
        FLOWS_CLI: flowsCli,
        INCLUDE_NIGHTLY_CASES: "false",
        INPUT_FLOWS: "",
        TARGET_DEPLOYMENT: "success",
        TARGET_REF: pullRequest.head.ref,
        TARGET_SHA: targetSha,
        TARGET_URL: previewUrl,
      },
      { gh: multiPageGh("ambiguous") }
    );
    expect(page2Target.result.exitCode).not.toBe(0);
    expect(page2Target.outputs.resolution_error_kind).toBe("ambiguous-pr");

    // Failed preview + HTTP 502 on page 2 (both on commit-to-PR lookup while
    // branch fallback also fails, and on page 2 of branch fallback) starting
    // from a prior green status: resolve-target must preserve page 1's verified
    // branch-and-SHA match and publish-status-without-run must overwrite the
    // prior green status with failure.
    for (const mode of [
      "page1-then-502",
      "branch-fallback-page2-502",
    ] as const) {
      const failedTarget = await runStep(
        targetStep,
        {},
        {
          EVENT_NAME: "repository_dispatch",
          FLOWS_CLI: flowsCli,
          INCLUDE_NIGHTLY_CASES: "false",
          INPUT_FLOWS: "",
          TARGET_DEPLOYMENT: "failed",
          TARGET_REF: pullRequest.head.ref,
          TARGET_SHA: targetSha,
          TARGET_URL: previewUrl,
        },
        { gh: multiPageGh(mode) }
      );
      expect(failedTarget.result.exitCode).not.toBe(0);
      expect(failedTarget.outputs.eligible).toBe("true");
      expect(failedTarget.outputs.sha).toBe(targetSha);
      expect(failedTarget.outputs.resolution_error_kind).toBe(
        "pr-lookup-failed"
      );

      const decided = await runStep(
        statusStep,
        {},
        {
          DEPLOYMENT: failedTarget.outputs.deployment ?? "",
          FLOWS: failedTarget.outputs.flows ?? "",
          FLOWS_CLI: flowsCli,
          PR_NUMBER: failedTarget.outputs.pr_number ?? "",
          RESOLUTION_ERROR: failedTarget.outputs.resolution_error ?? "",
          RESOLUTION_ERROR_KIND:
            failedTarget.outputs.resolution_error_kind ?? "",
          TARGET_OUTCOME: "failure",
          TARGET_SHA: failedTarget.outputs.sha ?? "",
        }
      );
      expect(decided.result.exitCode).toBe(0);
      expect(decided.outputs.state).toBe("failure");

      const published = await runStep(
        publishStep,
        {},
        {
          FLOWS_PUBLISH: flowsPublish,
          PR_NUMBER: failedTarget.outputs.pr_number ?? "",
          STATUS_DESCRIPTION: decided.outputs.description ?? "",
          STATUS_REASON: decided.outputs.reason ?? "",
          STATUS_STATE: decided.outputs.state ?? "failure",
          TARGET_SHA: failedTarget.outputs.sha ?? "",
        },
        { gh: multiPageGh(mode) }
      );
      expect(published.result.exitCode).toBe(0);
      const failurePosts = published.calls.filter((call) =>
        call.includes(`statuses/${targetSha}`)
      );
      expect(failurePosts).toHaveLength(1);
      expect(failurePosts[0]).toContain("state=failure");
      expect(failurePosts[0]).toContain("could not verify PR state");
    }

    // Two branches sharing a SHA: when commit-to-PR lookup fails and the
    // branch-specific lookup for an unrelated branch returns `[]`, resolver
    // must honor the empty branch lookup (`eligible=false`, exit 0) and leave
    // the healthy PR's green status untouched with zero status posts.
    const unrelatedBranch = await runStep(
      targetStep,
      {},
      {
        EVENT_NAME: "repository_dispatch",
        FLOWS_CLI: flowsCli,
        INCLUDE_NIGHTLY_CASES: "false",
        INPUT_FLOWS: "",
        TARGET_DEPLOYMENT: "failed",
        TARGET_REF: "feat/unrelated-branch",
        TARGET_SHA: targetSha,
        TARGET_URL: previewUrl,
      },
      { gh: multiPageGh("unrelated-branch") }
    );
    expect(unrelatedBranch.result.exitCode).toBe(0);
    expect(unrelatedBranch.outputs).toEqual({ eligible: "false" });
    expect(
      unrelatedBranch.calls.filter((call) =>
        call.includes(`statuses/${targetSha}`)
      )
    ).toEqual([]);

    // A single HTTP 200 PR-list page exceeding Node's default 1 MiB
    // `execFileSync` buffer (24 PRs with 48,000-character bodies, one eligible
    // PR requesting `admin`) must be read completely without truncation and
    // resolve the eligible PR's requested flows.
    const largeFillerBody = `${"x".repeat(48_000)}\n## E2E flows\n- none\n`;
    const largePagePrs = [
      ...Array.from({ length: 23 }, (_, index) => ({
        ...pullRequest,
        body: largeFillerBody,
        number: prNumber + 100 + index,
        state: "closed",
      })),
      {
        ...pullRequest,
        body: `${"y".repeat(48_000)}\n## E2E flows\n- admin\n`,
      },
    ];
    const largePageJson = JSON.stringify(largePagePrs);
    expect(Buffer.byteLength(largePageJson, "utf8")).toBeGreaterThan(
      1024 * 1024
    );
    const largePageGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
if [[ "$*" == *"/commits/${targetSha}/pulls"* ]]; then
  printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'
  cat "$GH_FIXTURES/large_pulls.json"
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
    const largePageTarget = await runStep(
      targetStep,
      { large_pulls: largePagePrs },
      {
        EVENT_NAME: "repository_dispatch",
        FLOWS_CLI: flowsCli,
        INCLUDE_NIGHTLY_CASES: "false",
        INPUT_FLOWS: "",
        TARGET_DEPLOYMENT: "success",
        TARGET_REF: pullRequest.head.ref,
        TARGET_SHA: targetSha,
        TARGET_URL: previewUrl,
      },
      { gh: largePageGh }
    );
    expect(largePageTarget.result.exitCode).toBe(0);
    expect(largePageTarget.outputs).toMatchObject({
      eligible: "true",
      flows: "admin",
      install_webkit: "false",
      pr_number: String(prNumber),
      run_e2e: "true",
      sha: targetSha,
      url: previewUrl,
    });

    const page2Publish = await runStep(
      publishStep,
      {},
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      },
      { gh: multiPageGh("ambiguous") }
    );
    expect(page2Publish.result.exitCode).toBe(0);
    expect(
      page2Publish.calls.filter((call) =>
        call.includes(`statuses/${targetSha}`)
      )
    ).toEqual([]);

    const unreadablePage2Publish = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- none\n",
          head: { sha: targetSha },
        },
        [`commits/${targetSha}/statuses`]: [ambiguityFailure],
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          {
            description: "Deployment has completed",
            environment_url: `${previewUrl}/`,
            state: "success",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION: "Protected preview E2E skipped [flows: none]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(unreadablePage2Publish.result.exitCode).toBe(0);
    expect(
      unreadablePage2Publish.calls.filter((call) =>
        call.includes(`statuses/${targetSha}`)
      )
    ).toEqual([]);
  });

  test.each([
    {
      fixedFlow: "none",
      pilot: false,
      initialBody: "## Summary\nMissing flows",
      passingStatus: "Protected preview E2E skipped [flows: none]",
    },
    {
      fixedFlow: "email-campaigns",
      pilot: true,
      initialBody: "## E2E flows\n- none\n",
      passingStatus: "Protected preview E2E restored [flows: email-campaigns]",
    },
  ])(
    "reconciles a delayed metadata failure that raced with a concurrent fix to $fixedFlow",
    async ({ fixedFlow, pilot, initialBody, passingStatus }) => {
      const repo = {
        full_name: repository,
        id: 1015951989,
        owner: { id: 361691508 },
      };
      const headRef = pullRequest.head.ref;
      const pr = {
        ...pullRequest,
        base: { ref: "main", repo, sha: sha("b") },
        changed_files: 1,
        head: { ...pullRequest.head, repo },
        user: { ...pullRequest.user, type: "User" },
      };
      const proof = backendPreviewProofFixture(prNumber, targetSha, previewUrl);
      const statuses = pilot
        ? [
            proof.status,
            {
              context: "Workspace E2E",
              creator: { login: "github-actions[bot]" },
              description:
                "Protected preview E2E passed [flows: email-campaigns]",
              state: "success",
            },
          ]
        : [];
      const statefulGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_FIXTURES/calls.log"
state_file="$GH_FIXTURES/state.txt"
[[ -f "$state_file" ]] || echo "invalid" > "$state_file"
if [[ "$*" == *"/pulls/${prNumber}/files"* ]]; then
  echo '[{"filename":"bun.lock","status":"modified"}]'
  exit 0
fi
if [[ "$*" == *"/git/ref/heads/${headRef}"* ]]; then
  echo '{"object":{"sha":"${targetSha}","type":"commit"},"ref":"refs/heads/${headRef}"}'
  exit 0
fi
if [[ "$*" == *"/pulls/${prNumber}"* ]]; then
  if [[ "$(cat "$state_file")" == "invalid" ]]; then
    cat "$GH_FIXTURES/initial.json"
  else
    cat "$GH_FIXTURES/fixed.json"
  fi
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
if [[ "$*" == *"/commits/${targetSha}/statuses"* ]]; then
  cat "$GH_FIXTURES/statuses.json"
  exit 0
fi
if [[ "$*" == *" repos/Deskohub/deskohub-site/${proof.jobsPath}?"* ]]; then
  cat "$GH_FIXTURES/jobs.json"
  exit 0
fi
if [[ "$*" == *" repos/Deskohub/deskohub-site/${proof.runPath}" ]]; then
  cat "$GH_FIXTURES/run.json"
  exit 0
fi
if [[ "$*" == *"/statuses/${targetSha}"* ]]; then
  if [[ "$*" == *"state=failure"* ]]; then
    echo "fixed" > "$state_file"
    echo '{"id":401}'
  else
    echo '{"id":402}'
  fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
      const { calls, result } = await runStep(
        publishStep,
        {
          initial: { ...pr, body: initialBody },
          fixed: { ...pr, body: `## E2E flows\n- ${fixedFlow}\n` },
          statuses: [statuses],
          run: proof.run,
          jobs: proof.jobs,
        },
        {
          FLOWS_PUBLISH: flowsPublish,
          GH_TOKEN: "test-token",
          PILOT_PR_NUMBER: pilot ? String(prNumber) : "",
          PR_NUMBER: String(prNumber),
          STATUS_DESCRIPTION:
            "Invalid or missing ## E2E flows in PR description; list valid flows, all, or none",
          STATUS_REASON: "invalid-pr-flows",
          STATUS_STATE: "failure",
          TARGET_SHA: targetSha,
        },
        { gh: statefulGh }
      );
      expect(result.exitCode).toBe(0);
      const posts = calls.filter((call) =>
        call.includes(`statuses/${targetSha}`)
      );
      if (pilot) {
        expect(posts.length).toBeGreaterThan(0);
        expect(posts.every((post) => post.includes("state=failure"))).toBe(
          true
        );
        return;
      }
      expect(posts, calls.join("\n")).toHaveLength(2);
      expect(posts[0]).toContain("state=failure");
      expect(posts[1]).toContain("state=success");
      expect(posts[1]).toContain(`description=${passingStatus}`);
      expect(
        calls
          .slice(calls.indexOf(posts[0]) + 1, calls.indexOf(posts[1]))
          .some((call) => call.endsWith(`/pulls/${prNumber}`))
      ).toBe(true);
    }
  );

  test("strips head-failed flows from outgoing carried same-tree statuses", async () => {
    const carried = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- webkit\n",
          head: { sha: targetSha },
        },
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          { description: "Skipped - Not affected", state: "inactive" },
        ],
        [`commits/${targetSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E failed [flows: admin]",
            state: "failure",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION:
          "Same tree as bbbbbbb, which passed E2E [flows: admin,webkit]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(carried.result.exitCode).toBe(0);
    const posts = carried.calls.filter((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=success");
    expect(posts[0]).toContain(
      "description=Same tree as bbbbbbb, which passed E2E [flows: webkit]"
    );
    expect(posts[0]).not.toContain("admin");

    // Delayed carried write after the PR head already moved must STILL strip
    // flows that failed on targetSha.
    const movedHeadCarried = await runStep(
      publishStep,
      {
        [`pulls/${prNumber}`]: {
          body: "## E2E flows\n- all\n",
          head: { sha: sha("f") },
        },
        deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
        "deployments/11/statuses": [
          { description: "Skipped - Not affected", state: "inactive" },
        ],
        [`commits/${targetSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E failed [flows: admin]",
            state: "failure",
          },
        ],
        [`statuses/${targetSha}`]: {},
      },
      {
        FLOWS_PUBLISH: flowsPublish,
        PR_NUMBER: String(prNumber),
        STATUS_DESCRIPTION:
          "Same tree as bbbbbbb, which passed E2E [flows: admin,webkit]",
        STATUS_STATE: "success",
        TARGET_SHA: targetSha,
      }
    );
    expect(movedHeadCarried.result.exitCode).toBe(0);
    const movedPosts = movedHeadCarried.calls.filter((call) =>
      call.includes(`statuses/${targetSha}`)
    );
    expect(movedPosts).toHaveLength(1);
    expect(movedPosts[0]).toContain(
      "description=Same tree as bbbbbbb, which passed E2E [flows: webkit]"
    );
    expect(movedPosts[0]).not.toContain("admin");
  });
});
