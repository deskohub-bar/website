import { createHash } from "node:crypto";
import { isWorkspaceE2EDiagnosticCode } from "../../apps/deskohub-workspace/e2e/errors";
import { isGitHubRepositorySlug } from "./github";
import type { RunCommand } from "./sources";

export type NightlySignal = Readonly<{
  source: "nightly";
  key: string;
  title: string;
  evidence: string;
  legacyMarkers: readonly string[];
  observedAt: string;
  priority: "normal";
  runUrls: readonly string[];
}>;

const weekMs = 7 * 24 * 60 * 60 * 1000;
const githubActionsBot = "github-actions[bot]";
const githubActionsBotId = 41898282;
const annotationTitle = "Workspace E2E case failed";
const annotationPattern =
  /^case=(?<caseId>[a-z][a-z0-9-]{0,95})(?:,step=(?<stepId>[a-z][a-z0-9-]{0,95}))?(?:,diagnostic_code=(?<diagnosticCode>[a-z][a-z0-9_]{0,127}))?,outcome=(?<outcome>failed|timed_out),failure_kind=(?<failureKind>error|defect|timeout)$/;

type NightlyGroup = {
  title: string;
  evidence: string;
  observedAt: string;
  runUrls: Set<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// gh emits each projected object as one JSON line, including across pages.
async function readGitHubRows(
  run: RunCommand,
  endpoint: string,
  projection: string
): Promise<Record<string, unknown>[]> {
  let output: string;
  try {
    output = await run("gh", [
      "api",
      endpoint,
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--paginate",
      "--jq",
      projection,
    ]);
  } catch {
    throw new Error("GitHub Actions nightly metadata command failed");
  }

  try {
    const lines = output.trim();
    if (lines === "") return [];
    return lines.split("\n").map((line) => {
      const row: unknown = JSON.parse(line);
      if (!isRecord(row)) throw new Error("Expected a GitHub metadata object");
      return row;
    });
  } catch {
    throw new Error("GitHub Actions returned malformed nightly metadata");
  }
}

function isFailure(row: Record<string, unknown>): boolean {
  return (
    row.status === "completed" &&
    (row.conclusion === "failure" || row.conclusion === "timed_out")
  );
}

function isActionsBot(actor: unknown): boolean {
  return (
    isRecord(actor) &&
    actor.id === githubActionsBotId &&
    actor.login === githubActionsBot
  );
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("GitHub Actions returned an invalid nightly identifier");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    const iso = new Date(value).toISOString();
    if (iso === value || iso.replace(".000Z", "Z") === value) return iso;
  }
  throw new Error("GitHub Actions returned an invalid nightly timestamp");
}

function caseDiagnosis(annotation: Record<string, unknown>) {
  if (
    annotation.title !== annotationTitle ||
    annotation.annotation_level !== "failure" ||
    typeof annotation.message !== "string"
  ) {
    return;
  }
  const match = annotationPattern.exec(annotation.message);
  if (match?.[0] !== annotation.message) return;
  const { caseId, stepId, outcome, failureKind, diagnosticCode } =
    match.groups ?? {};
  if (
    !caseId ||
    caseId === "invalid" ||
    stepId === "invalid" ||
    (outcome === "timed_out") !== (failureKind === "timeout") ||
    (diagnosticCode === undefined && (failureKind !== "timeout" || !stepId)) ||
    (diagnosticCode !== undefined &&
      !isWorkspaceE2EDiagnosticCode(diagnosticCode))
  ) {
    return;
  }

  const key = createHash("sha256").update(match[0]).digest("hex");
  return {
    key: `nightly:case:${key}`,
    title: `Nightly E2E: ${caseId}${stepId ? ` / ${stepId}` : ""}`,
    evidence: [
      `- Case: \`${caseId}\``,
      ...(stepId ? [`- Step: \`${stepId}\``] : []),
      `- Outcome: \`${outcome}\``,
      `- Failure kind: \`${failureKind}\``,
      ...(diagnosticCode ? [`- Diagnostic code: \`${diagnosticCode}\``] : []),
    ].join("\n"),
  };
}

export async function collectNightlyE2E(
  run: RunCommand,
  repo: string
): Promise<NightlySignal[]> {
  if (!isGitHubRepositorySlug(repo)) {
    throw new Error("Invalid repository for nightly E2E intake");
  }
  const since = encodeURIComponent(
    `>=${new Date(Date.now() - weekMs).toISOString()}`
  );
  const workflow = `repos/${repo}/actions/workflows/workspace-e2e.yml/runs`;
  const runs = await readGitHubRows(
    run,
    `${workflow}?branch=main&event=workflow_dispatch&status=completed&created=${since}&per_page=100`,
    `.workflow_runs[] | {id, run_attempt, status, conclusion, event, head_branch,
      actor: {id: .actor.id, login: .actor.login}, triggering_actor: {id: .triggering_actor.id, login: .triggering_actor.login},
      head_repository: {full_name: .head_repository.full_name},
      pr_count: (.pull_requests | if type == "array" then length else null end), updated_at}`
  );

  const groups = new Map<string, NightlyGroup>();
  for (const row of runs) {
    // The nightly launcher is the only bot dispatch of this workflow on main.
    if (
      !isFailure(row) ||
      row.event !== "workflow_dispatch" ||
      row.head_branch !== "main" ||
      !isActionsBot(row.actor) ||
      !isActionsBot(row.triggering_actor) ||
      !isRecord(row.head_repository) ||
      typeof row.head_repository.full_name !== "string" ||
      row.head_repository.full_name.toLowerCase() !== repo.toLowerCase() ||
      row.pr_count !== 0
    ) {
      continue;
    }
    const id = positiveId(row.id);
    const attempt = positiveId(row.run_attempt);
    const observedAt = timestamp(row.updated_at);
    const url = `https://github.com/${repo}/actions/runs/${id}/attempts/${attempt}`;
    const jobs = await readGitHubRows(
      run,
      `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`,
      '.jobs[] | select(.name == "test-e2e") | {id, name, status, conclusion}'
    );

    // Launcher, setup, and unannotated suite failures need manual triage.
    // A failed job or step can represent several unrelated fixes.
    for (const job of jobs) {
      if (job.name !== "test-e2e" || !isFailure(job)) continue;
      const annotations = await readGitHubRows(
        run,
        `repos/${repo}/check-runs/${positiveId(job.id)}/annotations?per_page=100`,
        `.[] | select(.title == "${annotationTitle}" and .annotation_level == "failure") | {title, annotation_level, message}`
      );
      for (const annotation of annotations) {
        const diagnosis = caseDiagnosis(annotation);
        if (!diagnosis) continue;
        const { key, title, evidence } = diagnosis;
        const group = groups.get(key);
        if (group) {
          group.runUrls.add(url);
          if (observedAt > group.observedAt) group.observedAt = observedAt;
        } else {
          groups.set(key, {
            title,
            evidence,
            observedAt,
            runUrls: new Set([url]),
          });
        }
      }
    }
  }

  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({
      ...group,
      key,
      source: "nightly",
      priority: "normal",
      legacyMarkers: [],
      runUrls: [...group.runUrls].sort(),
    }));
}
