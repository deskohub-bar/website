import { expect, test } from "bun:test";
import { collectNightlyE2E } from "./nightly";
import type { RunCommand } from "./sources";

const repo = "Deskohub/deskohub-site";
const workflow = `repos/${repo}/actions/workflows/workspace-e2e.yml/runs`;
const bot = "github-actions[bot]";

function nightlyRun(id: number, attempt = 1, day = "19") {
  return {
    id,
    run_attempt: attempt,
    status: "completed",
    conclusion: "failure",
    event: "workflow_dispatch",
    head_branch: "main",
    actor: { id: 41898282, login: bot },
    triggering_actor: { id: 41898282, login: bot },
    head_repository: { full_name: repo },
    pr_count: 0,
    updated_at: `2026-11-${day}T10:46:28Z`,
  };
}

const failureAnnotation = {
  title: "Workspace E2E case failed",
  annotation_level: "failure",
  message:
    "case=checkout-pay-full-price,step=replay-payment-webhook,diagnostic_code=nexi_webhook_fulfillment_failed,outcome=failed,failure_kind=error",
};

const completedJob = {
  id: 101,
  name: "test-e2e",
  status: "completed",
  conclusion: "failure",
};

function githubFixture(runs: readonly unknown[]) {
  const responses = new Map<string, readonly unknown[]>();
  const calls: string[] = [];
  const run: RunCommand = async (command, args) => {
    const [subcommand, endpoint] = args;
    if (command !== "gh" || subcommand !== "api" || !endpoint) {
      throw new Error("Unexpected command");
    }
    expect(args).toContain("GET");
    const path = endpoint.split("?")[0] ?? "";
    calls.push(path);
    const records = path === workflow ? runs : responses.get(path);
    if (!records) throw new Error("Unexpected GitHub endpoint");
    return records.map((record) => JSON.stringify(record)).join("\n");
  };
  return { calls, responses, run };
}

test("groups nightly attempts from the transferred repository and keeps canonical GitHub links", async () => {
  const { responses, run } = githubFixture([
    {
      ...nightlyRun(33, 2, "20"),
      head_repository: { full_name: "deskohub/deskohub-site" },
      html_url: "https://preview.invalid/private",
    },
    nightlyRun(27),
  ]);
  responses.set(`repos/${repo}/actions/runs/33/attempts/2/jobs`, [
    completedJob,
  ]);
  responses.set(`repos/${repo}/actions/runs/27/attempts/1/jobs`, [
    { ...completedJob, id: 102 },
  ]);
  responses.set(`repos/${repo}/check-runs/101/annotations`, [
    failureAnnotation,
  ]);
  responses.set(`repos/${repo}/check-runs/102/annotations`, [
    failureAnnotation,
    failureAnnotation,
  ]);

  const [signal, ...others] = await collectNightlyE2E(run, repo);

  expect(others).toEqual([]);
  expect(signal).toMatchObject({
    source: "nightly",
    observedAt: "2026-11-20T10:46:28.000Z",
    runUrls: [
      `https://github.com/${repo}/actions/runs/27/attempts/1`,
      `https://github.com/${repo}/actions/runs/33/attempts/2`,
    ],
  });
  expect(signal?.key).toMatch(/^nightly:case:[a-f0-9]{64}$/);
  expect(signal?.evidence).toContain("nexi_webhook_fulfillment_failed");
  expect(JSON.stringify(signal)).not.toContain("preview.invalid");
});

test("keeps distinct structured diagnoses separate within the same case and step", async () => {
  const { responses, run } = githubFixture([nightlyRun(27)]);
  responses.set(`repos/${repo}/actions/runs/27/attempts/1/jobs`, [
    completedJob,
  ]);
  responses.set(`repos/${repo}/check-runs/101/annotations`, [
    failureAnnotation,
    {
      ...failureAnnotation,
      message:
        "case=checkout-pay-full-price,step=replay-payment-webhook,diagnostic_code=nexi_webhook_late_payment,outcome=failed,failure_kind=error",
    },
  ]);

  const signals = await collectNightlyE2E(run, repo);
  expect(signals).toHaveLength(2);
  expect(new Set(signals.map(({ key }) => key)).size).toBe(2);
  expect(signals.map(({ evidence }) => evidence).join("\n")).toContain(
    "nexi_webhook_late_payment"
  );
});

test("ignores contributor dispatches, contributor reruns, PRs, forks and cancelled runs", async () => {
  const contributor = { login: "contributor" };
  const { calls, run } = githubFixture([
    { ...nightlyRun(1), actor: contributor, triggering_actor: contributor },
    { ...nightlyRun(2, 2), triggering_actor: contributor },
    { ...nightlyRun(3), event: "pull_request" },
    { ...nightlyRun(4), pr_count: 1 },
    { ...nightlyRun(5), event: "repository_dispatch" },
    { ...nightlyRun(6), head_branch: "feature" },
    { ...nightlyRun(7), head_repository: { full_name: "fork/deskohub-site" } },
    { ...nightlyRun(8), conclusion: "cancelled" },
    { ...nightlyRun(9), status: "in_progress" },
    { ...nightlyRun(10), actor: { id: 800, login: bot } },
  ]);

  expect(await collectNightlyE2E(run, repo)).toEqual([]);
  expect(calls).toEqual([workflow]);
});

test("keeps only closed annotation fields and leaves setup failures in triage", async () => {
  const { calls, responses, run } = githubFixture([
    nightlyRun(27),
    nightlyRun(33),
  ]);
  responses.set(`repos/${repo}/actions/runs/27/attempts/1/jobs`, [
    completedJob,
    { ...completedJob, id: 102, name: "resolve-target" },
  ]);
  responses.set(`repos/${repo}/actions/runs/33/attempts/1/jobs`, [
    { ...completedJob, id: 103, conclusion: "cancelled" },
  ]);
  const privateValue = "synthetic-private-value";
  const timedOut = {
    ...failureAnnotation,
    message:
      "case=automation-reservation-booked,step=wait-for-email,outcome=timed_out,failure_kind=timeout",
    raw_details: privateValue,
    path: privateValue,
  };
  responses.set(`repos/${repo}/check-runs/101/annotations`, [
    timedOut,
    { ...failureAnnotation, message: privateValue },
    { ...failureAnnotation, title: privateValue },
    { ...failureAnnotation, annotation_level: "warning" },
    {
      ...failureAnnotation,
      message:
        "case=checkout-pay-full-price,step=replay-payment-webhook,outcome=failed,failure_kind=error",
    },
    { ...timedOut, message: `${timedOut.message}\n${privateValue}` },
    { ...timedOut, message: `${timedOut.message},detail=${privateValue}` },
    {
      ...timedOut,
      message: timedOut.message.replace("wait-for-email", "invalid"),
    },
    {
      ...timedOut,
      message: timedOut.message.replace(
        "wait-for-email",
        "https://preview.invalid"
      ),
    },
    {
      ...failureAnnotation,
      message: failureAnnotation.message.replace(
        "nexi_webhook_fulfillment_failed",
        "synthetic_private_value"
      ),
    },
  ]);

  const signals = await collectNightlyE2E(run, repo);
  expect(signals).toHaveLength(1);
  expect(signals[0]?.evidence).toContain("`timed_out`");
  expect(JSON.stringify(signals)).not.toContain(privateValue);
  expect(calls.filter((path) => path.endsWith("/annotations"))).toEqual([
    `repos/${repo}/check-runs/101/annotations`,
  ]);
});

test("rejects malformed repository names before reading GitHub", async () => {
  const { calls, run } = githubFixture([]);
  await expect(collectNightlyE2E(run, `${repo}/../private`)).rejects.toThrow(
    "Invalid repository for nightly E2E intake"
  );
  expect(calls).toEqual([]);
});
