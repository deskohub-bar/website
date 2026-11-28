#!/usr/bin/env node
/**
 * Coordinated status reconciler and CAS publisher for `Workspace E2E`.
 *
 * Every writer that can publish `Workspace E2E` (`publish-final-status`,
 * `publish-status-without-run`, and `sync-pr-e2e-flows`) runs through this
 * helper so that:
 * 1. Success requires affirmative live evidence of PR head, valid `## E2E flows`,
 *    the current Vercel deployment's current status (never falling through from
 *    an unresolved deployment or treating lookup failure as valid), readable
 *    head commit-status history, and un-invalidated flow coverage. A backend
 *    pilot also needs a proof tied to its PR, commit, and current deployment.
 * 2. Restored passes use `Protected preview E2E restored` (`kind: "restored"`)
 *    rather than `Protected preview E2E passed`, so persisted tentative writes
 *    from a restoration can never be mistaken by a subsequent process for a
 *    real `test-e2e` run result.
 * 3. Every `success` write (and every mutable metadata failure write) performs
 *    post-write verification against fresh PR, deployment, and commit-status
 *    reads while excluding all tentative writes from this process. A tentative
 *    `success` is NEVER left in place unless post-write verification
 *    affirmatively confirms it; otherwise the applicable pending, undo, or
 *    failure decision is published (preserving any `dispatchAction` and
 *    preserving the active run's original `target_url` when restoring pending).
 * 4. Outgoing carried (`same-tree-passed`) statuses filter out every flow that
 *    failed or is actively running on the head SHA so a carried status never
 *    advertises a head-failed or in-flight flow.
 * 5. Delayed no-run failures only reconcile into success when their preserved
 *    `STATUS_REASON` is explicitly a reconcilable metadata or deployment-state
 *    reason (`invalid-pr-flows`, `manual-none-conflict`, `deployment-failed`,
 *    `deployment-skipped`), never clearing exact-preview resolution errors from
 *    an unrelated deployment.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { classifyPullRequestTarget } from "../workspace-backend-preview/target.mjs";
import {
  classifyE2EStatusDescription,
  diffFlowIds,
  findCoveringCarriedSource,
  formatE2EStatusDescription,
  parseFlowsInput,
  parsePrBodyE2EFlows,
  summarizeCommitStatuses,
  unionFlowIds,
  WORKSPACE_E2E_FLOW_IDS,
  WORKSPACE_E2E_SUPERSEDED_DESCRIPTION,
} from "./flows.mjs";
import { runGhCapture } from "./gh.mjs";

const INVALID_FLOWS_DESCRIPTION =
  "Invalid or missing ## E2E flows in PR description; list valid flows, all, or none";
const DEPLOYMENT_FAILED_DESCRIPTION =
  "Vercel preview deployment failed; fix or redeploy it to run E2E";
const DEPLOYMENT_UNAVAILABLE_DESCRIPTION =
  "Vercel preview deployment state could not be verified; re-run the failed jobs";
const PR_UNAVAILABLE_DESCRIPTION =
  "Workspace E2E could not verify PR state; re-run the failed jobs";
const STATUSES_UNAVAILABLE_DESCRIPTION =
  "Workspace E2E could not verify commit statuses; re-run the failed jobs";
const RACE_FAILURE_DESCRIPTION =
  "Workspace E2E status raced with concurrent updates; re-run this check";
const WAITING_FOR_PREVIEW_DESCRIPTION =
  "Waiting for Vercel preview to resolve E2E";
const BACKEND_PREVIEW_CONTEXT = "Workspace backend preview";
const BACKEND_PREVIEW_FLOW = "email-campaigns";
const BACKEND_PREVIEW_CLASSIFICATION_UNAVAILABLE =
  "Workspace E2E could not verify backend preview eligibility";
const BACKEND_PREVIEW_FLOW_REQUIRED =
  "Add email-campaigns to the pilot E2E flows before dispatch";
const BACKEND_PREVIEW_DEPLOYMENT_REQUIRED =
  "Deploy the exact protected Vercel preview before running the backend pilot";
const BACKEND_PREVIEW_PROOF_REQUIRED =
  "Run email-campaigns E2E against this Workspace backend preview";
const PREVIEW_ENVIRONMENT =
  process.env.PREVIEW_ENVIRONMENT || "Preview – deskohub-workspace-site";
const MAX_CAS_ATTEMPTS = 3;

const RECONCILABLE_NO_RUN_REASONS = new Set([
  "invalid-pr-flows",
  "manual-none-conflict",
  "deployment-failed",
  "deployment-skipped",
]);

const repoSlug = process.env.GITHUB_REPOSITORY ?? "";
const repoApi = `repos/${repoSlug}`;
const runUrl = `${process.env.GITHUB_SERVER_URL ?? ""}/${repoSlug}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
const pilotPrNumber = process.env.PILOT_PR_NUMBER ?? "";

const appendSummary = (line) => {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`, "utf8");
  }
};

const ghExec = (args) => runGhCapture(args);

const ghApiJson = (args, { slurp = false } = {}) => {
  const fullArgs = [
    "api",
    ...(slurp ? ["--paginate", "--slurp"] : []),
    "-H",
    "Accept: application/vnd.github+json",
    ...args,
  ];
  const res = ghExec(fullArgs);
  if (!res.ok) return { ok: false, error: res.stderr };
  try {
    const parsed = JSON.parse(res.stdout || "null");
    if (slurp) {
      if (
        !Array.isArray(parsed) ||
        parsed.some((page) => !Array.isArray(page))
      ) {
        return { ok: false, error: "Unexpected paginated response shape" };
      }
      return {
        ok: true,
        data: parsed.flat(),
      };
    }
    return { ok: true, data: parsed };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const fetchPr = (prNumber) => ghApiJson([`${repoApi}/pulls/${prNumber}`]);

const fetchCommitStatuses = (sha) =>
  ghApiJson([`${repoApi}/commits/${sha}/statuses?per_page=100`], {
    slurp: true,
  });

const fetchPrCommits = (prNumber) =>
  ghApiJson([`${repoApi}/pulls/${prNumber}/commits?per_page=100`], {
    slurp: true,
  });

const fetchCommitPulls = (sha) =>
  ghApiJson([`${repoApi}/commits/${sha}/pulls?per_page=100`], {
    slurp: true,
  });

const isEligibleInternalPr = (pr) =>
  pr?.state === "open" &&
  pr?.draft === false &&
  pr?.head?.repo?.full_name === repoSlug &&
  pr?.user?.login !== "dependabot[bot]" &&
  !String(pr?.head?.ref ?? "").startsWith("dependabot/");

const createSingleEligiblePrChecker = (sha, prNumber) => {
  let checked = false;
  let result = false;
  return () => {
    if (checked) return result;
    checked = true;
    if (!prNumber) {
      result = false;
      return false;
    }
    const pullsRes = fetchCommitPulls(sha);
    if (!pullsRes.ok || !Array.isArray(pullsRes.data)) {
      result = false;
      return false;
    }
    const eligible = pullsRes.data.filter(
      (entry) =>
        isEligibleInternalPr(entry) && String(entry?.head?.sha ?? "") === sha
    );
    result =
      eligible.length === 1 &&
      String(eligible[0]?.number ?? "") === String(prNumber);
    return result;
  };
};

const normalizePreviewUrl = (url) => String(url ?? "").replace(/\/+$/, "");

const previewUrlDigest = (url) =>
  createHash("sha256").update(normalizePreviewUrl(url)).digest("hex");

const previewUrlTag = (url) => previewUrlDigest(url).slice(0, 8);

const backendProofDescription = (generation) =>
  `Workspace backend preview E2E passed for PR #${pilotPrNumber} [${generation}]`;

const readPilotRun = (path) => {
  const result = ghApiJson([path]);
  return result.ok ? result.data : undefined;
};

const readBackendPreviewRequirement = async (prNumber, sha) => {
  if (!pilotPrNumber) return "not-required";
  const isPilot = prNumber === pilotPrNumber;
  if (!isPilot) {
    // The required status is shared by every PR with this head commit.
    const pilot = fetchPr(pilotPrNumber);
    if (!pilot.ok || !pilot.data) return "unavailable";
    if (!isEligibleInternalPr(pilot.data) || pilot.data.head.sha !== sha) {
      return "not-required";
    }
  }
  try {
    const { backendRequired } = await classifyPullRequestTarget(
      { operation: "deploy", number: Number(pilotPrNumber), sha },
      process.env,
      async (url) => {
        // Use the publisher's GitHub reader for the classifier's API requests.
        const { pathname, search } = new URL(url);
        const result = ghApiJson([`${pathname.slice(1)}${search}`]);
        return { ok: result.ok, json: async () => result.data };
      }
    );
    if (!backendRequired) return "not-required";
    return isPilot ? "required" : "pilot-owned";
  } catch {
    return "unavailable";
  }
};

const backendPreviewBlock = (snapshot, parsedPr, hasLiveProof = false) => {
  if (snapshot.backendPreviewRequirement === "not-required") return null;
  if (snapshot.backendPreviewRequirement === "unavailable") {
    return BACKEND_PREVIEW_CLASSIFICATION_UNAVAILABLE;
  }
  if (!(parsedPr.ok && parsedPr.selected.includes(BACKEND_PREVIEW_FLOW))) {
    return BACKEND_PREVIEW_FLOW_REQUIRED;
  }
  if (snapshot.deployment.state !== "success") {
    return BACKEND_PREVIEW_DEPLOYMENT_REQUIRED;
  }
  // A historical result cannot prove that the generation still exists. Only
  // the trusted completion workflow can supply a fresh verified binding.
  return hasLiveProof ? null : BACKEND_PREVIEW_PROOF_REQUIRED;
};

const PREVIEW_MISMATCH_TAG_PATTERN =
  /^No Vercel deployment record matches this preview yet.*\[preview:\s*(success|skipped|failed):([0-9a-f]{8})\]$/;

const deploymentStatusMatchesOutcome = (status, expectedOutcome) => {
  if (expectedOutcome === "skipped") {
    return (
      status?.state === "inactive" &&
      status?.description === "Skipped - Not affected"
    );
  }
  if (expectedOutcome === "failed") {
    return status?.state === "failure" || status?.state === "error";
  }
  if (expectedOutcome === "success") {
    return status?.state === "success";
  }
  return false;
};

/**
 * Scans `Workspace E2E` commit statuses from newest to oldest for any
 * unresolved exact-preview or target-resolution failure.
 *
 * - Tagged preview mismatches (`[preview: <outcome>:<tag>]`) are NEVER cleared
 *   by an unrelated `skipped-none`, `passed`, or `carried-passed` status (for
 *   example from a delayed publisher for an older preview on the same SHA);
 *   they clear ONLY when a GitHub deployment record on this SHA satisfies the
 *   resolver's exact URL-and-state predicate.
 * - PR ambiguity failures (`More than one open PR has this head...`) clear ONLY
 *   when a fresh live query of `commits/<sha>/pulls` confirms exactly one
 *   eligible open internal PR matches this SHA and PR number.
 * - Untagged preview mismatches and invalid-URL failures stay unresolved.
 */
const findUnresolvedExactPreviewFailure = (
  statuses,
  deployment,
  hasSingleEligiblePr = () => false
) => {
  const relevant = (Array.isArray(statuses) ? statuses : []).filter(
    (status) =>
      status &&
      status.context === "Workspace E2E" &&
      status.creator?.login === "github-actions[bot]"
  );

  for (const status of relevant) {
    if (status.state !== "failure" && status.state !== "error") {
      continue;
    }

    const desc = String(status.description ?? "");
    const tagMatch = PREVIEW_MISMATCH_TAG_PATTERN.exec(desc);
    if (tagMatch) {
      const expectedOutcome = tagMatch[1];
      const expectedTag = tagMatch[2];
      if (!deployment.matchesExactPreview(expectedOutcome, expectedTag)) {
        return { description: desc, expectedOutcome, expectedTag };
      }
      continue;
    }

    if (desc.startsWith("More than one open PR has this head")) {
      if (!hasSingleEligiblePr()) {
        return { description: desc };
      }
      continue;
    }

    if (
      desc.startsWith("No Vercel deployment record matches this preview yet") ||
      desc.startsWith("The event named no immutable Vercel preview URL")
    ) {
      return { description: desc };
    }
  }

  return null;
};

/**
 * Resolves the current (newest) Vercel deployment's current (newest) status
 * for `sha`. Never falls through from an unresolved (`in_progress`, `queued`,
 * `pending`) current deployment or status to an older deployment or status.
 * Also provides `matchesExactPreview(expectedOutcome, expectedTag)` applying
 * the same URL-and-state predicate as `resolve-target` across this SHA's
 * Vercel deployments so sync can check whether a rejected preview record now
 * exists with the expected outcome.
 */
const fetchDeploymentState = (sha) => {
  const neverMatches = () => false;
  const deploymentsRes = ghApiJson([
    "--method",
    "GET",
    `${repoApi}/deployments`,
    "-f",
    `sha=${sha}`,
    "-f",
    `environment=${PREVIEW_ENVIRONMENT}`,
    "-f",
    "per_page=100",
  ]);
  if (!deploymentsRes.ok || !Array.isArray(deploymentsRes.data)) {
    return {
      state: "unavailable",
      previewUrl: "",
      matchesExactPreview: neverMatches,
    };
  }
  const vercelDeployments = deploymentsRes.data.filter(
    (entry) => entry?.creator?.login === "vercel[bot]" && entry?.id != null
  );
  if (vercelDeployments.length === 0) {
    return {
      state: "pending",
      previewUrl: "",
      matchesExactPreview: neverMatches,
    };
  }
  const currentDeployment = vercelDeployments[0];
  const statusesRes = ghApiJson([
    `${repoApi}/deployments/${currentDeployment.id}/statuses`,
  ]);
  if (!statusesRes.ok || !Array.isArray(statusesRes.data)) {
    return {
      state: "unavailable",
      previewUrl: "",
      matchesExactPreview: neverMatches,
    };
  }

  const statusesByDeploymentId = new Map([
    [currentDeployment.id, statusesRes.data],
  ]);
  const matchesExactPreview = (expectedOutcome, expectedTag) => {
    for (const entry of vercelDeployments) {
      let entryStatuses = statusesByDeploymentId.get(entry.id);
      if (entryStatuses === undefined) {
        const res = ghApiJson([`${repoApi}/deployments/${entry.id}/statuses`]);
        if (!res.ok || !Array.isArray(res.data)) {
          return false;
        }
        entryStatuses = res.data;
        statusesByDeploymentId.set(entry.id, entryStatuses);
      }
      const matched = entryStatuses.some((status) => {
        const envUrl = normalizePreviewUrl(status?.environment_url);
        return (
          envUrl !== "" &&
          deploymentStatusMatchesOutcome(status, expectedOutcome) &&
          previewUrlTag(envUrl) === expectedTag
        );
      });
      if (matched) {
        return true;
      }
    }
    return false;
  };

  if (statusesRes.data.length === 0) {
    return {
      state: "pending",
      previewUrl: "",
      matchesExactPreview,
    };
  }
  const currentStatus = statusesRes.data[0];
  const envUrl = normalizePreviewUrl(currentStatus?.environment_url);
  if (currentStatus?.state === "success" && envUrl !== "") {
    return {
      state: "success",
      previewUrl: envUrl,
      matchesExactPreview,
    };
  }
  if (
    currentStatus?.state === "inactive" &&
    currentStatus?.description === "Skipped - Not affected"
  ) {
    return {
      state: "skipped",
      previewUrl: "",
      matchesExactPreview,
    };
  }
  if (currentStatus?.state === "failure" || currentStatus?.state === "error") {
    return {
      state: "failed",
      previewUrl: "",
      matchesExactPreview,
    };
  }
  return {
    state: "pending",
    previewUrl: "",
    matchesExactPreview,
  };
};

const postCommitStatus = (sha, { context, state, description, targetUrl }) => {
  const res = ghApiJson([
    "--method",
    "POST",
    `${repoApi}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${context}`,
    "-f",
    `description=${description}`,
    "-f",
    `target_url=${targetUrl}`,
  ]);
  if (!res.ok) {
    throw new Error(
      `Failed to publish ${context} status (${state}): ${res.error}`
    );
  }
  return res.data;
};

const toCanonicalFlows = (flowIds) => {
  if (flowIds.length === 0) return "none";
  if (flowIds.length === WORKSPACE_E2E_FLOW_IDS.length) return "all";
  return flowIds.join(",");
};

/**
 * Removes every tentative status posted by THIS process during the current CAS
 * loop so no retry can ever treat its own tentative write as proof of a pass.
 */
const stripTentativePosts = (statuses, tentativePosts) => {
  if (!Array.isArray(statuses) || statuses.length === 0) return [];
  if (tentativePosts.length === 0) return statuses;
  const remainingTentative = [...tentativePosts];
  const filtered = [];
  for (const status of statuses) {
    const matchIndex = remainingTentative.findIndex((post) => {
      if (post.id != null) {
        return status?.id === post.id;
      }
      return (
        status?.context === "Workspace E2E" &&
        status?.creator?.login === "github-actions[bot]" &&
        status?.state === post.state &&
        status?.description === post.description &&
        status?.target_url === post.targetUrl
      );
    });
    if (matchIndex !== -1) {
      remainingTentative.splice(matchIndex, 1);
      continue;
    }
    filtered.push(status);
  }
  return filtered;
};

const findActiveRunForFlows = (summary, flowIds) => {
  if (!Array.isArray(summary.activeRuns) || summary.activeRuns.length === 0) {
    return null;
  }
  const wanted = new Set(flowIds);
  const matching = summary.activeRuns.find((run) =>
    run.flows.some((flow) => wanted.has(flow))
  );
  return matching ?? summary.activeRuns[0];
};

const findForeignActiveRun = (summary, selection, ownerUrl) =>
  summary.activeRuns.find(
    (run) =>
      run.targetUrl !== "" &&
      run.targetUrl !== ownerUrl &&
      run.flows.some((flow) => selection.includes(flow))
  );

const readPilotStatusOrder = (statuses, sourceRun, selection) => {
  const relevant = statuses.filter(
    (status) => status?.context === "Workspace E2E" &&
      status.creator?.login === "github-actions[bot]"
  );
  // GitHub lists the newest statuses first. The source pending write precedes
  // its test and gives us the boundary for later results on this same SHA.
  const source = relevant.findIndex(
    (status) => status.state === "pending" && status.target_url === sourceRun
  );
  const later = source < 0 ? undefined : relevant.slice(0, source).find((status) => {
    if (status.target_url === sourceRun) return false;
    const verdict = classifyE2EStatusDescription(status.description);
    if (status.state === "success") {
      return verdict.kind === "passed" &&
        selection.every((flow) => verdict.selected.includes(flow));
    }
    return (status.state === "failure" || status.state === "error") &&
      (!verdict.selected?.length || verdict.selected.some((flow) => selection.includes(flow)));
  });
  return { sourceFound: source >= 0, later };
};

/**
 * Filters a carried flow set against head-SHA failures and active reruns so an
 * outgoing `same-tree-passed` status never advertises a flow that failed or is
 * actively running on the head SHA.
 */
const filterSafeCarriedFlows = (carriedFlows, headSummary) => {
  const blocked = new Set([
    ...headSummary.failedFlows,
    ...headSummary.runningFlows,
  ]);
  return carriedFlows.filter((flow) => !blocked.has(flow));
};

/**
 * Evaluates a same-tree source commit's real runs against `requestedSelected`,
 * excluding any flow that failed or is actively running on the head SHA from
 * the advertised carried flow set.
 */
const evaluateSameTreeCommit = (
  commitSha,
  commitStatuses,
  requestedSelected,
  headSummary
) => {
  const summary = summarizeCommitStatuses(commitStatuses, {
    includeCarried: false,
  });
  if (summary.latestRunKind === "" || summary.latestRunKind === "superseded") {
    return null;
  }
  const safeCarried = headSummary
    ? filterSafeCarriedFlows(summary.realPassedFlows, headSummary)
    : summary.realPassedFlows;
  const realMissing = diffFlowIds(requestedSelected, safeCarried);
  if (realMissing.length === 0) {
    return {
      state: "success",
      description: formatE2EStatusDescription({
        kind: "same-tree-passed",
        flows: toCanonicalFlows(safeCarried),
        sourceSha: commitSha,
      }),
    };
  }
  const failedSet = new Set(summary.failedFlows);
  if (requestedSelected.some((id) => failedSet.has(id))) {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, which failed E2E`,
    };
  }
  const runningSet = new Set(summary.runningFlows);
  if (requestedSelected.some((id) => runningSet.has(id))) {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, whose E2E is still running; rerun this check after it ends`,
    };
  }
  if (summary.latestRunKind === "failed") {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, which failed E2E`,
    };
  }
  if (summary.latestRunKind === "running") {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, whose E2E is still running; rerun this check after it ends`,
    };
  }
  return {
    state: "failure",
    description: `Same tree as ${commitSha.slice(0, 7)} lacks required E2E flows; deploy its Workspace preview`,
  };
};

/**
 * Executes a decide -> post -> post-write CAS verify loop so that:
 * - No writer can leave an unverified tentative `success` in place after a
 *   concurrent PR edit, validation failure, deployment change, real failure,
 *   or active rerun.
 * - Mutable metadata failures (`verifyAfterPost: true`) also verify after
 *   publication so a delayed failure cannot overwrite a concurrent correction.
 */
const publishWithCasReconcile = async ({
  sha,
  prNumber,
  readSnapshot,
  decide,
  onBlockedSuccess,
}) => {
  const evaluate = async (snapshot) => {
    const backendPreviewRequirement = await readBackendPreviewRequirement(
      prNumber,
      sha
    );
    const current = { ...snapshot, backendPreviewRequirement };
    const decision = decide(current);
    if (
      backendPreviewRequirement === "not-required" ||
      (decision.state !== "success" && !decision.satisfiedSuccess)
    ) {
      return decision;
    }
    if (backendPreviewRequirement === "pilot-owned") return { skipPost: true };
    const hasLiveProof = Boolean(
      current.liveGeneration &&
        current.liveGeneration === decision.verifiedGeneration
    );
    const blocked = backendPreviewBlock(
      current,
      parsePrBodyE2EFlows(String(snapshot.pr?.body ?? "")),
      hasLiveProof
    );
    if (!blocked) return decision;
    return onBlockedSuccess ?? { state: "failure", description: blocked };
  };

  const tentativePosts = [];
  let pendingSnapshot = null;
  let overrideDecision = null;

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const rawBefore = pendingSnapshot ?? (await readSnapshot());
    pendingSnapshot = null;
    const before = {
      ...rawBefore,
      statuses: rawBefore.statusesOk
        ? stripTentativePosts(rawBefore.statuses, tentativePosts)
        : rawBefore.statuses,
    };
    const decision = overrideDecision ?? (await evaluate(before));
    overrideDecision = null;
    if (decision.skipPost) {
      if (tentativePosts.length === 0) {
        return decision;
      }
      // We already posted a tentative status earlier in this loop and the fresh
      // state no longer authorizes it. Never leave a tentative success behind.
      if (decision.restorePendingDescription) {
        const pendingTargetUrl = decision.restorePendingTargetUrl || runUrl;
        postCommitStatus(sha, {
          context: "Workspace E2E",
          state: "pending",
          description: decision.restorePendingDescription,
          targetUrl: pendingTargetUrl,
        });
        return {
          state: "pending",
          description: decision.restorePendingDescription,
          targetUrl: pendingTargetUrl,
        };
      }
      if (decision.undoDecision) {
        postCommitStatus(sha, {
          context: "Workspace E2E",
          state: decision.undoDecision.state,
          description: decision.undoDecision.description,
          targetUrl: decision.undoDecision.targetUrl || runUrl,
        });
        return decision.undoDecision;
      }
      postCommitStatus(sha, {
        context: "Workspace E2E",
        state: "failure",
        description: RACE_FAILURE_DESCRIPTION,
        targetUrl: runUrl,
      });
      return { state: "failure", description: RACE_FAILURE_DESCRIPTION };
    }

    const postTargetUrl = decision.targetUrl || runUrl;
    const posted = postCommitStatus(sha, {
      context: "Workspace E2E",
      state: decision.state,
      description: decision.description,
      targetUrl: postTargetUrl,
    });

    const mustVerify =
      decision.state === "success" || decision.verifyAfterPost === true;
    if (!mustVerify) {
      return decision;
    }

    tentativePosts.push({
      id: posted && typeof posted === "object" ? posted.id : undefined,
      state: decision.state,
      description: decision.description,
      targetUrl: postTargetUrl,
    });

    // Verify linearizability against fresh live state after writing, excluding
    // all tentative posts made by this process.
    const rawAfter = await readSnapshot();
    const after = {
      ...rawAfter,
      statuses: rawAfter.statusesOk
        ? stripTentativePosts(rawAfter.statuses, tentativePosts)
        : rawAfter.statuses,
    };
    const verifyDecision = await evaluate(after);

    const samePr =
      before.prOk &&
      after.prOk &&
      before.pr?.head?.sha === after.pr?.head?.sha &&
      (before.pr?.body ?? "") === (after.pr?.body ?? "");
    const sameDeployment =
      before.deployment.state === after.deployment.state &&
      before.deployment.previewUrl === after.deployment.previewUrl;

    if (
      samePr &&
      sameDeployment &&
      !verifyDecision.skipPost &&
      verifyDecision.state === decision.state &&
      verifyDecision.description === decision.description &&
      (verifyDecision.targetUrl || runUrl) === postTargetUrl
    ) {
      return decision;
    }

    // If a concurrent active rerun appeared right beneath our tentative write,
    // restore the pending running status preserving the active run's original
    // target_url so that run still recognizes ownership when it ends.
    if (verifyDecision.restorePendingDescription) {
      const pendingTargetUrl = verifyDecision.restorePendingTargetUrl || runUrl;
      postCommitStatus(sha, {
        context: "Workspace E2E",
        state: "pending",
        description: verifyDecision.restorePendingDescription,
        targetUrl: pendingTargetUrl,
      });
      return {
        state: "pending",
        description: verifyDecision.restorePendingDescription,
        targetUrl: pendingTargetUrl,
      };
    }

    // If verification produced a non-success decision that does not itself
    // require post-write verification (for example a concurrent real failure,
    // PR invalidation, or widened flows requiring dispatch), apply it now and
    // preserve its dispatchAction.
    if (
      !verifyDecision.skipPost &&
      verifyDecision.state !== "success" &&
      verifyDecision.verifyAfterPost !== true
    ) {
      const finalTargetUrl = verifyDecision.targetUrl || runUrl;
      postCommitStatus(sha, {
        context: "Workspace E2E",
        state: verifyDecision.state,
        description: verifyDecision.description,
        targetUrl: finalTargetUrl,
      });
      return verifyDecision;
    }

    // If verification returned skipPost after we already wrote a tentative
    // status, accept it ONLY when verification affirmatively proved the live
    // selection is already satisfied (`satisfiedSuccess: true`, e.g. a genuine
    // concurrent pass landed). When a tentative failure overwrote a concurrent
    // success, reinstate that success and CAS-verify it on the next attempt.
    if (verifyDecision.skipPost) {
      const sameSuccessOwner = decision.state === "success" &&
        (!verifyDecision.reinstateDecision?.targetUrl ||
          verifyDecision.reinstateDecision.targetUrl === postTargetUrl);
      if (
        sameSuccessOwner &&
        verifyDecision.satisfiedSuccess === true &&
        after.prOk &&
        (after.deployment.state === "success" ||
          after.deployment.state === "skipped")
      ) {
        return decision;
      }
      if (
        !sameSuccessOwner &&
        verifyDecision.satisfiedSuccess === true &&
        verifyDecision.reinstateDecision &&
        after.prOk &&
        (after.deployment.state === "success" ||
          after.deployment.state === "skipped")
      ) {
        pendingSnapshot = rawAfter;
        overrideDecision = verifyDecision.reinstateDecision;
        continue;
      }
      if (verifyDecision.undoDecision) {
        if (
          verifyDecision.undoDecision.state === decision.state &&
          verifyDecision.undoDecision.description === decision.description &&
          (verifyDecision.undoDecision.targetUrl || runUrl) === postTargetUrl
        ) {
          return decision;
        }
        postCommitStatus(sha, {
          context: "Workspace E2E",
          state: verifyDecision.undoDecision.state,
          description: verifyDecision.undoDecision.description,
          targetUrl: verifyDecision.undoDecision.targetUrl || runUrl,
        });
        return verifyDecision.undoDecision;
      }
      if (decision.state !== "success") {
        return decision;
      }
      postCommitStatus(sha, {
        context: "Workspace E2E",
        state: "failure",
        description: RACE_FAILURE_DESCRIPTION,
        targetUrl: runUrl,
      });
      return { state: "failure", description: RACE_FAILURE_DESCRIPTION };
    }

    // Verification produced a new decision (e.g. a different `success` after
    // a concurrent fix to `none`, or a mutable failure): reuse `rawAfter` on
    // the next attempt (with `tentativePosts` stripped at the top).
    pendingSnapshot = rawAfter;
  }

  postCommitStatus(sha, {
    context: "Workspace E2E",
    state: "failure",
    description: RACE_FAILURE_DESCRIPTION,
    targetUrl: runUrl,
  });
  return { state: "failure", description: RACE_FAILURE_DESCRIPTION };
};

const runPublishCompletedPilot = async () => {
  const { findPilotRunGeneration, pilotRunUrl, pilotTargetKey } =
    await import("../workspace-backend-preview/run-proof.mjs");
  const { readCompletedPreviewGeneration } =
    await import("../workspace-backend-preview/e2e-gate.mjs");
  if (!/^[1-9][0-9]{0,8}$/.test(pilotPrNumber)) return;

  const initial = fetchPr(pilotPrNumber);
  if (!initial.ok || !isEligibleInternalPr(initial.data)) return;
  const sha = initial.data.head.sha;
  if (!/^[0-9a-f]{40}$/.test(sha)) return;
  const source = pilotRunUrl(process.env.PILOT_SOURCE_RUN_ID, process.env.PILOT_SOURCE_RUN_ATTEMPT);
  const sourceRun = source.split("/attempts/")[0];

  const readSnapshot = async () => {
    const prRead = fetchPr(pilotPrNumber);
    const pr = prRead.data;
    const deployment = fetchDeploymentState(sha);
    const statusesRead = fetchCommitStatuses(sha);
    const selection = parsePrBodyE2EFlows(String(pr?.body ?? ""));
    const statusesOk = statusesRead.ok && Array.isArray(statusesRead.data);
    const snapshot = {
      prOk: prRead.ok,
      pr,
      deployment,
      statusesOk,
      statuses: statusesOk ? statusesRead.data : [],
      selection,
    };
    if (
      !prRead.ok || !isEligibleInternalPr(pr) || pr.head.sha !== sha ||
      deployment.state !== "success" ||
      !selection.ok || !selection.selected.includes(BACKEND_PREVIEW_FLOW)
    ) return snapshot;

    const target = pilotTargetKey(pilotPrNumber, sha, previewUrlDigest(deployment.previewUrl), selection.flows);
    const generation = findPilotRunGeneration({ targetUrl: source, target, read: readPilotRun });
    if (!generation) return snapshot;

    let liveGeneration;
    try {
      liveGeneration = await readCompletedPreviewGeneration({
        number: Number(pilotPrNumber),
        sha,
        expectedOrigin: deployment.previewUrl,
      }, { ...process.env, GIT_REF: pr.head.ref });
    } catch {
      // A changed or unavailable protected deployment cannot authorize a pass.
    }
    return { ...snapshot, target, generation, liveGeneration };
  };

  const confirmed = await readSnapshot();
  if (!confirmed.generation) return;

  const result = await publishWithCasReconcile({
    sha,
    prNumber: pilotPrNumber,
    readSnapshot,
    decide: ({
      backendPreviewRequirement,
      prOk,
      pr,
      selection,
      liveGeneration,
      target,
      generation,
      statusesOk,
      statuses,
    }) => {
      if (
        backendPreviewRequirement !== "required" ||
        !prOk ||
        !isEligibleInternalPr(pr) ||
        pr.head.sha !== sha ||
        generation !== confirmed.generation
      ) {
        return { skipPost: true };
      }
      if (!statusesOk) {
        return {
          state: "failure",
          description: STATUSES_UNAVAILABLE_DESCRIPTION,
          targetUrl: sourceRun,
          verifyAfterPost: true,
        };
      }
      const pending = findForeignActiveRun(summarizeCommitStatuses(statuses), selection.selected, sourceRun);
      if (pending) {
        return {
          skipPost: true,
          restorePendingDescription: pending.description,
          restorePendingTargetUrl: pending.targetUrl,
        };
      }
      const { sourceFound, later } = readPilotStatusOrder(
        statuses,
        sourceRun,
        selection.selected
      );
      if (!sourceFound) return { skipPost: true };
      const failedProof = {
        state: "failure",
        description: BACKEND_PREVIEW_PROOF_REQUIRED,
        targetUrl: sourceRun,
        verifyAfterPost: true,
      };
      if (later?.state === "success") {
        const laterGeneration = findPilotRunGeneration({
          targetUrl: later.target_url,
          target,
          read: readPilotRun,
          followLatest: true,
        });
        if (laterGeneration && laterGeneration === liveGeneration) {
          return {
            skipPost: true,
            satisfiedSuccess: true,
            verifiedGeneration: laterGeneration,
            reinstateDecision: {
              state: "success",
              description: later.description,
              targetUrl: later.target_url,
            },
          };
        }
        return failedProof;
      }
      if (later) {
        return {
          skipPost: true,
          undoDecision: {
            state: later.state,
            description: later.description || BACKEND_PREVIEW_PROOF_REQUIRED,
            targetUrl: later.target_url || sourceRun,
          },
        };
      }
      return liveGeneration === generation ? {
        state: "success",
        description: formatE2EStatusDescription({ kind: "passed", flows: selection.flows }),
        targetUrl: sourceRun,
        verifiedGeneration: generation,
      } : failedProof;
    },
  });
  if (
    (result.state === "success" || result.state === "failure") &&
    (!result.targetUrl || result.targetUrl === sourceRun)
  ) {
    postCommitStatus(sha, {
      context: BACKEND_PREVIEW_CONTEXT,
      state: result.state,
      description: result.state === "success" ? backendProofDescription(confirmed.generation) : BACKEND_PREVIEW_PROOF_REQUIRED,
      targetUrl: source,
    });
  }
};

const runPublishFinalStatus = async () => {
  const targetSha = process.env.TARGET_SHA ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const statusState = process.env.STATUS_STATE ?? "failure";
  const allocationDescription = process.env.ALLOCATION_DESCRIPTION ?? "";
  const supersededDescription =
    process.env.SUPERSEDED_DESCRIPTION || WORKSPACE_E2E_SUPERSEDED_DESCRIPTION;
  const effectiveFlows = (process.env.FLOWS ?? "").trim() || "all";

  const parsedRunFlows = parseFlowsInput(effectiveFlows);
  if (!parsedRunFlows.ok) {
    throw new Error(parsedRunFlows.error);
  }

  if (statusState === "success" && process.env.BACKEND_PREVIEW_REQUIRED === "true") {
    postCommitStatus(targetSha, {
      context: "Workspace E2E allocation",
      state: "success",
      description: allocationDescription,
      targetUrl: runUrl,
    });
    return;
  }

  const readSnapshot = () => {
    const prRes = prNumber ? fetchPr(prNumber) : { ok: false };
    const statusesRes = fetchCommitStatuses(targetSha);
    const deployment = fetchDeploymentState(targetSha);
    return {
      prOk: prRes.ok && Boolean(prRes.data),
      pr: prRes.ok ? prRes.data : null,
      statusesOk: statusesRes.ok && Array.isArray(statusesRes.data),
      statuses:
        statusesRes.ok && Array.isArray(statusesRes.data)
          ? statusesRes.data
          : [],
      deployment,
      hasSingleEligiblePr: createSingleEligiblePrChecker(targetSha, prNumber),
    };
  };

  if (statusState === "success") {
    await publishWithCasReconcile({
      sha: targetSha,
      prNumber,
      readSnapshot,
      decide: ({
        prOk,
        pr,
        statusesOk,
        statuses,
        deployment,
        hasSingleEligiblePr,
      }) => {
        if (!prOk) {
          return { state: "failure", description: PR_UNAVAILABLE_DESCRIPTION };
        }
        if (deployment.state === "failed") {
          return {
            state: "failure",
            description: DEPLOYMENT_FAILED_DESCRIPTION,
          };
        }
        if (deployment.state !== "success") {
          return {
            state: "failure",
            description: DEPLOYMENT_UNAVAILABLE_DESCRIPTION,
          };
        }
        if (!statusesOk) {
          return {
            state: "failure",
            description: STATUSES_UNAVAILABLE_DESCRIPTION,
          };
        }

        const headSha = String(pr?.head?.sha ?? "");
        const prBody = String(pr?.body ?? "");

        const summary = summarizeCommitStatuses(statuses, {
          includeCarried: false,
        });
        const union =
          effectiveFlows === "all"
            ? [...WORKSPACE_E2E_FLOW_IDS]
            : unionFlowIds(summary.realPassedFlows, parsedRunFlows.selected);
        const unionCsv = toCanonicalFlows(union);

        if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
          // The head moved after this run passed; preserve this SHA's real pass
          // without evaluating the newer head's PR body against it.
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "passed",
              flows: unionCsv,
            }),
          };
        }

        const parsedPr = parsePrBodyE2EFlows(prBody);
        if (!parsedPr.ok) {
          return { state: "failure", description: INVALID_FLOWS_DESCRIPTION };
        }

        const unresolvedExactPreview = findUnresolvedExactPreviewFailure(
          statuses,
          deployment,
          hasSingleEligiblePr
        );
        if (unresolvedExactPreview) {
          return {
            state: "failure",
            description: unresolvedExactPreview.description,
            verifyAfterPost: true,
          };
        }

        // Never overwrite a newer active run started by a DIFFERENT workflow run
        // for any requested flow.
        const foreignActiveRun = findForeignActiveRun(summary, parsedPr.selected, runUrl);
        if (foreignActiveRun) {
          return {
            skipPost: true,
            restorePendingDescription: foreignActiveRun.description,
            restorePendingTargetUrl: foreignActiveRun.targetUrl,
          };
        }

        const missingFromUnion = diffFlowIds(parsedPr.selected, union);
        if (missingFromUnion.length === 0) {
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "passed",
              flows: unionCsv,
            }),
          };
        }

        return {
          state: "failure",
          description: formatE2EStatusDescription({
            kind: "partial",
            flows: unionCsv,
          }),
        };
      },
    });

    postCommitStatus(targetSha, {
      context: "Workspace E2E allocation",
      state: statusState,
      description: allocationDescription,
      targetUrl: runUrl,
    });
    return;
  }

  // Failure path: check if superseded first; otherwise ALWAYS record the actual
  // run failure in commit status history, then ALWAYS reconcile against the
  // live PR selection (even if the initial PR body was invalid and was fixed to
  // `none` before reconciliation).
  const initialPr = prNumber ? fetchPr(prNumber) : { ok: false };
  const initialHeadSha = initialPr.ok
    ? String(initialPr.data?.head?.sha ?? "")
    : "";
  if (/^[0-9a-f]{40}$/.test(initialHeadSha) && initialHeadSha !== targetSha) {
    postCommitStatus(targetSha, {
      context: "Workspace E2E",
      state: "failure",
      description: supersededDescription,
      targetUrl: runUrl,
    });
    postCommitStatus(targetSha, {
      context: "Workspace E2E allocation",
      state: "failure",
      description: supersededDescription,
      targetUrl: runUrl,
    });
    return;
  }

  const failedDescription = formatE2EStatusDescription({
    kind: "failed",
    flows: effectiveFlows,
  });
  postCommitStatus(targetSha, {
    context: "Workspace E2E",
    state: "failure",
    description: failedDescription,
    targetUrl: runUrl,
  });

  if (prNumber) {
    const undoToFailure = {
      state: "failure",
      description: failedDescription,
      targetUrl: runUrl,
    };
    await publishWithCasReconcile({
      sha: targetSha,
      prNumber,
      readSnapshot,
      onBlockedSuccess: { skipPost: true, undoDecision: undoToFailure },
      decide: ({
        prOk,
        pr,
        statusesOk,
        statuses,
        deployment,
        hasSingleEligiblePr,
      }) => {
        if (!prOk) {
          return { skipPost: true, undoDecision: undoToFailure };
        }
        const headSha = String(pr?.head?.sha ?? "");
        if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
          return { skipPost: true, undoDecision: undoToFailure };
        }
        const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
        if (!parsedPr.ok) {
          return {
            skipPost: true,
            undoDecision: {
              state: "failure",
              description: INVALID_FLOWS_DESCRIPTION,
              targetUrl: runUrl,
            },
          };
        }
        if (parsedPr.flows === "none") {
          if (
            (deployment.state === "success" || deployment.state === "skipped") &&
            statusesOk &&
            !findUnresolvedExactPreviewFailure(
              statuses,
              deployment,
              hasSingleEligiblePr
            )
          ) {
            return {
              state: "success",
              description: formatE2EStatusDescription({
                kind: "skipped-none",
              }),
            };
          }
          return { skipPost: true, undoDecision: undoToFailure };
        }
        if (deployment.state === "success" && statusesOk) {
          // Ensure the failure we just posted is reflected even under
          // read-after-write lag, while preserving server order if already
          // present (so a newer foreign active run above it is still recognized).
          const alreadyRecorded = statuses.some(
            (status) =>
              status?.context === "Workspace E2E" &&
              status?.creator?.login === "github-actions[bot]" &&
              status?.state === "failure" &&
              status?.description === failedDescription &&
              (status?.target_url == null || status?.target_url === runUrl)
          );
          const effectiveStatuses = alreadyRecorded
            ? statuses
            : [
                {
                  context: "Workspace E2E",
                  creator: { login: "github-actions[bot]" },
                  description: failedDescription,
                  state: "failure",
                  target_url: runUrl,
                },
                ...statuses,
              ];
          if (
            findUnresolvedExactPreviewFailure(
              effectiveStatuses,
              deployment,
              hasSingleEligiblePr
            )
          ) {
            return { skipPost: true, undoDecision: undoToFailure };
          }
          const summary = summarizeCommitStatuses(effectiveStatuses, {
            includeCarried: false,
          });
          const foreignActiveRun = summary.activeRuns.find(
            (run) =>
              run.targetUrl !== "" &&
              run.targetUrl !== runUrl &&
              run.flows.some((flow) => parsedPr.selected.includes(flow))
          );
          if (foreignActiveRun) {
            return {
              state: "pending",
              description: foreignActiveRun.description,
              targetUrl: foreignActiveRun.targetUrl,
            };
          }
          const missingReal = diffFlowIds(
            parsedPr.selected,
            summary.realPassedFlows
          );
          if (missingReal.length === 0) {
            return {
              state: "success",
              description: formatE2EStatusDescription({
                kind: "restored",
                flows: summary.realPassedFlowsCsv,
              }),
            };
          }
        }
        return { skipPost: true, undoDecision: undoToFailure };
      },
    });
  }

  postCommitStatus(targetSha, {
    context: "Workspace E2E allocation",
    state: statusState,
    description: allocationDescription,
    targetUrl: runUrl,
  });
};

const runPublishStatusWithoutRun = async () => {
  const targetSha = process.env.TARGET_SHA ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const statusState = process.env.STATUS_STATE ?? "failure";
  const statusDescription = process.env.STATUS_DESCRIPTION ?? "";
  const statusReason = (process.env.STATUS_REASON ?? "").trim();

  if (!prNumber) {
    postCommitStatus(targetSha, {
      context: "Workspace E2E",
      state: statusState === "success" ? "failure" : statusState,
      description:
        statusState === "success"
          ? PR_UNAVAILABLE_DESCRIPTION
          : statusDescription,
      targetUrl: runUrl,
    });
    return;
  }

  const readSnapshot = () => {
    const prRes = fetchPr(prNumber);
    const deployment = fetchDeploymentState(targetSha);
    const statusesRes = fetchCommitStatuses(targetSha);
    return {
      prOk: prRes.ok && Boolean(prRes.data),
      pr: prRes.ok ? prRes.data : null,
      statusesOk: statusesRes.ok && Array.isArray(statusesRes.data),
      statuses:
        statusesRes.ok && Array.isArray(statusesRes.data)
          ? statusesRes.data
          : [],
      deployment,
      hasSingleEligiblePr: createSingleEligiblePrChecker(targetSha, prNumber),
    };
  };

  // Delayed failure path: ONLY reconcile failures whose recorded reason is
  // explicitly a mutable metadata or deployment-state reason. Exact-preview
  // resolution failures (such as `preview-record-mismatch` or `invalid-url`)
  // are never cleared by an unrelated deployment on the same SHA.
  if (statusState !== "success") {
    if (!RECONCILABLE_NO_RUN_REASONS.has(statusReason)) {
      postCommitStatus(targetSha, {
        context: "Workspace E2E",
        state: statusState,
        description: statusDescription,
        targetUrl: runUrl,
      });
      return;
    }

    const defaultFailure = {
      state: statusState,
      description: statusDescription,
      verifyAfterPost: true,
    };
    await publishWithCasReconcile({
      sha: targetSha,
      prNumber,
      readSnapshot,
      onBlockedSuccess: defaultFailure,
      decide: ({
        prOk,
        pr,
        statusesOk,
        statuses,
        deployment,
        hasSingleEligiblePr,
      }) => {
        if (!prOk) {
          return defaultFailure;
        }
        const headSha = String(pr?.head?.sha ?? "");
        if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
          return { state: statusState, description: statusDescription };
        }
        if (deployment.state === "failed") {
          return {
            state: "failure",
            description: DEPLOYMENT_FAILED_DESCRIPTION,
            verifyAfterPost: true,
          };
        }
        if (deployment.state !== "success" && deployment.state !== "skipped") {
          return defaultFailure;
        }
        const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
        if (!parsedPr.ok) {
          return defaultFailure;
        }
        if (statusReason === "manual-none-conflict") {
          // A conflicting manual `flows=none` dispatch only resolves if the
          // live PR selection itself changed to `none`; keep the failure while
          // the PR still requests E2E flows.
          if (
            parsedPr.flows === "none" &&
            statusesOk &&
            !findUnresolvedExactPreviewFailure(
              statuses,
              deployment,
              hasSingleEligiblePr
            )
          ) {
            return {
              state: "success",
              description: formatE2EStatusDescription({ kind: "skipped-none" }),
            };
          }
          return defaultFailure;
        }
        if (!statusesOk) {
          return defaultFailure;
        }
        const unresolvedExactPreview = findUnresolvedExactPreviewFailure(
          statuses,
          deployment,
          hasSingleEligiblePr
        );
        if (unresolvedExactPreview) {
          return {
            state: "failure",
            description: unresolvedExactPreview.description,
            verifyAfterPost: true,
          };
        }
        if (parsedPr.flows === "none") {
          return {
            state: "success",
            description: formatE2EStatusDescription({ kind: "skipped-none" }),
          };
        }
        const summary = summarizeCommitStatuses(statuses, {
          includeCarried: true,
        });
        if (
          diffFlowIds(parsedPr.selected, summary.realPassedFlows).length === 0
        ) {
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "restored",
              flows: summary.realPassedFlowsCsv,
            }),
          };
        }
        const coveringCarried = findCoveringCarriedSource(
          summary.carriedSources,
          parsedPr.selected
        );
        if (coveringCarried) {
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "same-tree-passed",
              flows: coveringCarried.flowsCsv,
              sourceSha: coveringCarried.sourceSha,
            }),
          };
        }
        const inFlightCovered = unionFlowIds(
          summary.realPassedFlows,
          summary.runningFlows
        );
        if (
          summary.runningFlows.length > 0 &&
          diffFlowIds(parsedPr.selected, inFlightCovered).length === 0
        ) {
          const activeRun = findActiveRunForFlows(
            summary,
            diffFlowIds(parsedPr.selected, summary.realPassedFlows)
          );
          return {
            skipPost: true,
            restorePendingDescription: activeRun?.description,
            restorePendingTargetUrl: activeRun?.targetUrl,
          };
        }
        return defaultFailure;
      },
    });
    return;
  }

  const classified = classifyE2EStatusDescription(statusDescription);

  await publishWithCasReconcile({
    sha: targetSha,
    prNumber,
    readSnapshot,
    decide: ({
      prOk,
      pr,
      statusesOk,
      statuses,
      deployment,
      hasSingleEligiblePr,
    }) => {
      if (!prOk) {
        return { state: "failure", description: PR_UNAVAILABLE_DESCRIPTION };
      }
      if (deployment.state === "failed") {
        return {
          state: "failure",
          description: DEPLOYMENT_FAILED_DESCRIPTION,
        };
      }
      if (deployment.state !== "success" && deployment.state !== "skipped") {
        return {
          state: "failure",
          description: DEPLOYMENT_UNAVAILABLE_DESCRIPTION,
        };
      }

      const headSha = String(pr?.head?.sha ?? "");
      if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
        if (classified.kind === "carried-passed") {
          if (!statusesOk) {
            return {
              state: "failure",
              description: STATUSES_UNAVAILABLE_DESCRIPTION,
            };
          }
          const summary = summarizeCommitStatuses(statuses, {
            includeCarried: false,
          });
          const safeCarried = filterSafeCarriedFlows(
            classified.selected,
            summary
          );
          if (safeCarried.length === 0) {
            if (summary.runningFlows.length > 0) {
              const activeRun = findActiveRunForFlows(
                summary,
                classified.selected
              );
              return {
                skipPost: true,
                restorePendingDescription: activeRun?.description,
                restorePendingTargetUrl: activeRun?.targetUrl,
              };
            }
            return {
              state: "failure",
              description: "Protected preview E2E failed on this commit",
            };
          }
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "same-tree-passed",
              flows: toCanonicalFlows(safeCarried),
              sourceSha: classified.sourceSha,
            }),
          };
        }
        return { state: "success", description: statusDescription };
      }

      const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
      if (!parsedPr.ok) {
        return { state: "failure", description: INVALID_FLOWS_DESCRIPTION };
      }

      if (!statusesOk) {
        return {
          state: "failure",
          description: STATUSES_UNAVAILABLE_DESCRIPTION,
        };
      }

      const unresolvedExactPreview = findUnresolvedExactPreviewFailure(
        statuses,
        deployment,
        hasSingleEligiblePr
      );
      if (unresolvedExactPreview) {
        const currentSummary = summarizeCommitStatuses(statuses, {
          includeCarried: false,
        });
        if (
          currentSummary.latestState === "failure" &&
          currentSummary.latestDescription === unresolvedExactPreview.description
        ) {
          return {
            skipPost: true,
            undoDecision: {
              state: "failure",
              description: unresolvedExactPreview.description,
            },
          };
        }
        return {
          state: "failure",
          description: unresolvedExactPreview.description,
          verifyAfterPost: true,
        };
      }

      if (classified.kind === "skipped-none") {
        if (parsedPr.flows !== "none") {
          return {
            state: "failure",
            description:
              "PR E2E flows changed; run Workspace E2E for the newly requested flows",
          };
        }
        return { state: "success", description: statusDescription };
      }

      if (classified.kind === "carried-passed") {
        const summary = summarizeCommitStatuses(statuses, {
          includeCarried: false,
        });
        const runningSet = new Set(summary.runningFlows);
        if (parsedPr.selected.some((id) => runningSet.has(id))) {
          const activeRun = findActiveRunForFlows(summary, parsedPr.selected);
          return {
            skipPost: true,
            restorePendingDescription: activeRun?.description,
            restorePendingTargetUrl: activeRun?.targetUrl,
          };
        }
        const failedSet = new Set(summary.failedFlows);
        if (parsedPr.selected.some((id) => failedSet.has(id))) {
          return {
            state: "failure",
            description: "Protected preview E2E failed on this commit",
          };
        }
        // Exclude every head-failed or in-flight flow from the advertised
        // carried set so this status can never cover a flow that failed on head.
        const safeCarried = filterSafeCarriedFlows(
          classified.selected,
          summary
        );
        const missing = diffFlowIds(parsedPr.selected, safeCarried);
        if (missing.length > 0) {
          return {
            state: "failure",
            description:
              "PR E2E flows changed; same-tree commit lacks newly requested E2E flows",
          };
        }
        return {
          state: "success",
          description: formatE2EStatusDescription({
            kind: "same-tree-passed",
            flows: toCanonicalFlows(safeCarried),
            sourceSha: classified.sourceSha,
          }),
        };
      }

      return {
        state: "failure",
        description:
          "Workspace E2E status could not be verified; re-run the failed jobs",
      };
    },
  });
};

const runSyncPrFlows = async () => {
  const prNumber = process.env.PR_NUMBER ?? "";
  const initialPrRes = fetchPr(prNumber);
  if (!initialPrRes.ok || !initialPrRes.data) {
    throw new Error(`Could not read PR #${prNumber}`);
  }
  const initialPr = initialPrRes.data;
  if (!isEligibleInternalPr(initialPr)) {
    process.stdout.write(
      `PR #${prNumber} is no longer an eligible open internal PR\n`
    );
    return;
  }

  const headSha = String(initialPr.head?.sha ?? "");
  const headRef = String(initialPr.head?.ref ?? "");
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    process.stderr.write(`PR #${prNumber} head SHA is invalid\n`);
    process.exit(1);
  }
  try {
    execFileSync("git", ["check-ref-format", "--branch", headRef], {
      stdio: "ignore",
    });
  } catch {
    process.stderr.write(`PR #${prNumber} head ref is invalid\n`);
    process.exit(1);
  }

  const initialParsed = parsePrBodyE2EFlows(String(initialPr.body ?? ""));
  if (!initialParsed.ok) {
    process.stderr.write(`${initialParsed.error}\n`);
    appendSummary(
      `Workspace E2E flow check failed for PR #${prNumber}: ${initialParsed.error}`
    );
    postCommitStatus(headSha, {
      context: "Workspace E2E",
      state: "failure",
      description: INVALID_FLOWS_DESCRIPTION,
      targetUrl: runUrl,
    });
    process.exit(1);
  }
  appendSummary(
    `PR #${prNumber} requests Workspace E2E flows: \`${initialParsed.flows}\``
  );

  const readSnapshot = () => {
    const prRes = fetchPr(prNumber);
    const statusesRes = fetchCommitStatuses(headSha);
    const deployment = fetchDeploymentState(headSha);
    return {
      prOk: prRes.ok && Boolean(prRes.data),
      pr: prRes.ok ? prRes.data : null,
      statusesOk: statusesRes.ok && Array.isArray(statusesRes.data),
      statuses:
        statusesRes.ok && Array.isArray(statusesRes.data)
          ? statusesRes.data
          : [],
      deployment,
      hasSingleEligiblePr: createSingleEligiblePrChecker(headSha, prNumber),
    };
  };

  const outcome = await publishWithCasReconcile({
    sha: headSha,
    prNumber,
    readSnapshot,
    decide: ({
      backendPreviewRequirement,
      prOk,
      pr,
      statusesOk,
      statuses,
      deployment,
      hasSingleEligiblePr,
    }) => {
      if (!prOk) {
        return { state: "failure", description: PR_UNAVAILABLE_DESCRIPTION };
      }
      if (!isEligibleInternalPr(pr) || String(pr?.head?.sha ?? "") !== headSha) {
        return { skipPost: true };
      }
      const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
      if (!parsedPr.ok) {
        return {
          state: "failure",
          description: INVALID_FLOWS_DESCRIPTION,
          invalidPrError: parsedPr.error,
        };
      }
      if (!statusesOk) {
        return {
          state: "failure",
          description: STATUSES_UNAVAILABLE_DESCRIPTION,
        };
      }
      if (deployment.state === "failed") {
        return {
          state: "failure",
          description: DEPLOYMENT_FAILED_DESCRIPTION,
        };
      }
      if (deployment.state === "unavailable") {
        return {
          state: "failure",
          description: DEPLOYMENT_UNAVAILABLE_DESCRIPTION,
        };
      }

      const summary = summarizeCommitStatuses(statuses, {
        includeCarried: true,
      });
      const unresolvedExactPreview = findUnresolvedExactPreviewFailure(
        statuses,
        deployment,
        hasSingleEligiblePr
      );
      if (unresolvedExactPreview) {
        if (
          summary.latestState === "failure" &&
          summary.latestDescription === unresolvedExactPreview.description
        ) {
          return {
            skipPost: true,
            undoDecision: {
              state: "failure",
              description: unresolvedExactPreview.description,
            },
          };
        }
        return {
          state: "failure",
          description: unresolvedExactPreview.description,
          verifyAfterPost: true,
        };
      }
      const requestedFlows = parsedPr.flows;
      const requestedSelected = parsedPr.selected;
      if (backendPreviewRequirement === "pilot-owned") return { skipPost: true };
      const previewBlock = backendPreviewBlock(
        { backendPreviewRequirement, deployment, statusesOk, statuses },
        parsedPr
      );
      const backendPreviewRequired = backendPreviewRequirement === "required";
      const missingBackendProof = previewBlock === BACKEND_PREVIEW_PROOF_REQUIRED;
      if (
        previewBlock &&
        !missingBackendProof &&
        (previewBlock !== BACKEND_PREVIEW_DEPLOYMENT_REQUIRED ||
          deployment.state !== "pending")
      ) {
        return { state: "failure", description: previewBlock };
      }
      if (
        backendPreviewRequired &&
        deployment.state === "pending" &&
        summary.latestState === "success"
      ) {
        return { state: "pending", description: WAITING_FOR_PREVIEW_DESCRIPTION };
      }
      const deploymentResolved =
        deployment.state === "success" || deployment.state === "skipped";
      const pendingPreviewUndo = {
        state: "pending",
        description: WAITING_FOR_PREVIEW_DESCRIPTION,
      };

      if (requestedFlows === "none") {
        if (deploymentResolved) {
          const skippedNoneDecision = {
            state: "success",
            description: formatE2EStatusDescription({ kind: "skipped-none" }),
          };
          if (summary.latestState !== "success") {
            return skippedNoneDecision;
          }
          return {
            skipPost: true,
            satisfiedSuccess: true,
            reinstateDecision: skippedNoneDecision,
          };
        }
        if (
          summary.latestState === "failure" &&
          summary.latestDescription === INVALID_FLOWS_DESCRIPTION
        ) {
          return {
            state: "pending",
            description: WAITING_FOR_PREVIEW_DESCRIPTION,
          };
        }
        return { skipPost: true, undoDecision: pendingPreviewUndo };
      }

      const passedFlows = missingBackendProof
        ? summary.realPassedFlows.filter((flow) => flow !== BACKEND_PREVIEW_FLOW)
        : summary.realPassedFlows;
      const missingReal = diffFlowIds(requestedSelected, passedFlows);
      if (missingReal.length === 0) {
        if (!deploymentResolved) {
          if (
            summary.latestState === "failure" &&
            summary.latestDescription === INVALID_FLOWS_DESCRIPTION
          ) {
            return {
              state: "pending",
              description: "Waiting for Vercel preview to run E2E",
            };
          }
          return { skipPost: true, undoDecision: pendingPreviewUndo };
        }
        const restoredDecision = {
          state: "success",
          description: formatE2EStatusDescription({
            kind: "restored",
            flows: summary.realPassedFlowsCsv,
          }),
        };
        if (
          summary.latestState !== "success" ||
          summary.latestKind === "skipped-none"
        ) {
          // Use `restored` (not `passed`) so persisted tentative writes from
          // sync can never be mistaken by a later process for a real run pass.
          return restoredDecision;
        }
        return {
          skipPost: true,
          satisfiedSuccess: true,
          reinstateDecision: restoredDecision,
        };
      }

      const coveringCarried = findCoveringCarriedSource(
        summary.carriedSources,
        requestedSelected
      );
      if (coveringCarried && !missingBackendProof) {
        if (!deploymentResolved) {
          if (
            summary.latestState === "failure" &&
            summary.latestDescription === INVALID_FLOWS_DESCRIPTION
          ) {
            return {
              state: "pending",
              description: "Waiting for Vercel preview to run E2E",
            };
          }
          return { skipPost: true, undoDecision: pendingPreviewUndo };
        }
        const expectedDescription = formatE2EStatusDescription({
          kind: "same-tree-passed",
          flows: coveringCarried.flowsCsv,
          sourceSha: coveringCarried.sourceSha,
        });
        const carriedDecision = {
          state: "success",
          description: expectedDescription,
        };
        if (
          summary.latestState !== "success" ||
          summary.latestDescription !== expectedDescription
        ) {
          return carriedDecision;
        }
        return {
          skipPost: true,
          satisfiedSuccess: true,
          reinstateDecision: carriedDecision,
        };
      }

      const inFlightCovered = unionFlowIds(
        passedFlows,
        summary.runningFlows
      );
      const coveredByRunning =
        summary.runningFlows.length > 0 &&
        diffFlowIds(requestedSelected, inFlightCovered).length === 0;
      if (coveredByRunning) {
        const activeRun = findActiveRunForFlows(summary, missingReal);
        appendSummary(
          `An in-progress Workspace E2E run already covers ${requestedFlows}`
        );
        // If an intermediate status (for example another flow's pass) sits on
        // top of the still-active run, restore `pending` preserving the active
        // run's original target_url so merge stays blocked and the run retains
        // ownership when it finishes.
        if (summary.latestState !== "pending" && activeRun) {
          return {
            state: "pending",
            description: activeRun.description,
            targetUrl: activeRun.targetUrl || runUrl,
          };
        }
        return {
          skipPost: true,
          restorePendingDescription: activeRun?.description,
          restorePendingTargetUrl: activeRun?.targetUrl,
        };
      }

      if (deployment.state === "success") {
        const dispatchFlows = backendPreviewRequired
          ? requestedFlows
          : toCanonicalFlows(missingReal);
        if (!dispatchFlows || dispatchFlows === "none") {
          return {
            state: "failure",
            description:
              "Workspace E2E could not determine missing flows; re-run this check",
          };
        }
        return {
          state: "failure",
          description:
            "PR E2E flows changed; starting Workspace E2E for missing flows",
          dispatchAction: {
            sha: headSha,
            url: deployment.previewUrl,
            ref: headRef,
            flows: dispatchFlows,
          },
        };
      }

      if (deployment.state === "skipped") {
        // Honor failures and active reruns recorded directly on the head SHA
        // before considering an older same-tree commit.
        const headFailedSet = new Set(summary.failedFlows);
        if (requestedSelected.some((id) => headFailedSet.has(id))) {
          return {
            state: "failure",
            description: "Protected preview E2E failed on this commit",
          };
        }
        const headRunningSet = new Set(summary.runningFlows);
        if (requestedSelected.some((id) => headRunningSet.has(id))) {
          const activeRun = findActiveRunForFlows(summary, missingReal);
          return {
            state: "failure",
            description:
              "Workspace E2E is still running for part of this commit; wait or deploy its Workspace preview",
            restorePendingDescription: activeRun?.description,
            restorePendingTargetUrl: activeRun?.targetUrl,
          };
        }

        const commitsRes = fetchPrCommits(prNumber);
        if (!commitsRes.ok || !Array.isArray(commitsRes.data)) {
          return {
            state: "failure",
            description:
              "Workspace E2E could not read PR commits; deploy its Workspace preview",
          };
        }
        const targetCommit = commitsRes.data.find(
          (commit) => commit?.sha === headSha
        );
        const targetTree = targetCommit?.commit?.tree?.sha ?? "";
        if (!targetTree) {
          return {
            state: "failure",
            description:
              "Head missing from this PR's commit list (GitHub lists 250 at most); deploy its Workspace preview to run E2E",
          };
        }
        const sameTreeShas = commitsRes.data
          .filter(
            (commit) =>
              commit?.sha &&
              commit.sha !== headSha &&
              commit?.commit?.tree?.sha === targetTree
          )
          .map((commit) => commit.sha)
          .reverse();
        for (const candidateSha of sameTreeShas) {
          const candidateStatusesRes = fetchCommitStatuses(candidateSha);
          if (!candidateStatusesRes.ok) {
            return {
              state: "failure",
              description: STATUSES_UNAVAILABLE_DESCRIPTION,
            };
          }
          const result = evaluateSameTreeCommit(
            candidateSha,
            candidateStatusesRes.data,
            requestedSelected,
            summary
          );
          if (result) {
            return result;
          }
        }
        return {
          state: "failure",
          description:
            "Vercel skipped this SHA and no E2E-tested commit has its tree; deploy its Workspace preview",
        };
      }

      // deployment.state === "pending"
      if (
        summary.latestState === "failure" &&
        summary.latestDescription === INVALID_FLOWS_DESCRIPTION
      ) {
        return {
          state: "pending",
          description: "Waiting for Vercel preview to run E2E",
        };
      }
      return { skipPost: true, undoDecision: pendingPreviewUndo };
    },
  });

  if (outcome.invalidPrError) {
    process.stderr.write(`${outcome.invalidPrError}\n`);
    process.exit(1);
  }

  if (outcome.dispatchAction) {
    const dispatchRes = ghExec([
      "workflow",
      "run",
      "workspace-e2e.yml",
      "--repo",
      repoSlug,
      "--ref",
      "main",
      "-f",
      `sha=${outcome.dispatchAction.sha}`,
      "-f",
      `url=${outcome.dispatchAction.url}`,
      "-f",
      `ref=${outcome.dispatchAction.ref}`,
      "-f",
      `flows=${outcome.dispatchAction.flows}`,
    ]);
    if (!dispatchRes.ok) {
      throw new Error(
        `Failed to dispatch workspace-e2e.yml: ${dispatchRes.stderr}`
      );
    }
    appendSummary(
      `Dispatched Workspace E2E for ${outcome.dispatchAction.sha.slice(0, 7)} with missing flows: \`${outcome.dispatchAction.flows}\``
    );
  }
};

const [mode] = process.argv.slice(2);
switch (mode) {
  case "publish-completed-pilot":
    await runPublishCompletedPilot();
    break;
  case "publish-final-status":
    await runPublishFinalStatus();
    break;
  case "publish-status-without-run":
    await runPublishStatusWithoutRun();
    break;
  case "sync-pr-flows":
    await runSyncPrFlows();
    break;
  default:
    process.stderr.write(
      `Unknown publish-status mode: ${mode ?? "<missing>"}\n`
    );
    process.exit(1);
}
