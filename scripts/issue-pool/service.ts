import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  type Command,
  GitHubIdentityError,
  githubIssueTracker,
  resolveIssuePoolGitHub,
} from "./github";
import { collectNightlyE2E } from "./nightly";
import { IssuePool, runIssuePool } from "./pool";
import { collectPostHog, collectVercelFeedback } from "./sources";
import { t3WorkerRunner } from "./t3";

class ConfigurationError extends Error {}
class CommandFailure extends Error {}

const run: Command = async (executable, args, input) => {
  const isPostHog = executable === "posthog-cli";
  const command = isPostHog
    ? [executable, "--host", "https://eu.posthog.com", ...args]
    : [executable, ...args];
  const process = Bun.spawn(command, {
    env: isPostHog ? { ...Bun.env, POSTHOG_CLI_PROJECT_ID: "204184" } : Bun.env,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
    timeout: 90_000,
    killSignal: "SIGKILL",
  });
  const [output, status] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (status !== 0) {
    throw new CommandFailure(`${executable} failed with exit status ${status}`);
  }
  return output;
};

function positiveInteger(value: string, option: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ConfigurationError(`${option} must be a positive integer`);
  }
  return Number(value);
}

async function legacyVercelOwnership(
  project: string
): Promise<(body: string) => boolean> {
  const commonDir = (
    await run("git", [
      "-C",
      project,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
  const manifest = await readFile(
    join(commonDir, "vercel-comments", "tracks.json"),
    "utf8"
  ).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return '{"comments":{}}';
    }
    throw error;
  });
  const {
    comments,
  }: { comments: Record<string, { threadId?: string; state?: string }> } =
    JSON.parse(manifest);
  const assignedIds = new Set(
    Object.entries(comments)
      .filter(([, entry]) => entry.threadId || entry.state === "pending")
      .map(([id]) => id)
  );
  return (commentId) => assignedIds.has(commentId);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "max-issues": { type: "string", default: "3" },
      "max-workers": { type: "string", default: "2" },
      project: { type: "string", default: process.cwd() },
      "reporter-id": { type: "string" },
      state: { type: "string" },
      t3: { type: "string", default: "t3" },
      "vercel-fetch-script": { type: "string" },
    },
  });
  const { apply, project, state, t3 } = values;
  const vercelFetchScript = values["vercel-fetch-script"];
  if (!vercelFetchScript || (apply && !state)) {
    throw new ConfigurationError(
      "--vercel-fetch-script is required and --apply requires --state"
    );
  }
  const maxNewIssues = positiveInteger(values["max-issues"], "--max-issues");
  const maxNewWorkers = positiveInteger(values["max-workers"], "--max-workers");
  const configuredReporter = values["reporter-id"];
  const reporterId =
    configuredReporter === undefined
      ? undefined
      : positiveInteger(configuredReporter, "--reporter-id");
  const github = await resolveIssuePoolGitHub(run, reporterId);
  const { repo } = github;
  if (apply && state) {
    await mkdir(dirname(state), { recursive: true, mode: 0o700 });
    await run("git", ["-C", project, "fetch", "origin", "main"]);
  }

  const [collectorResults, legacyFeedbackClaimed] = await Promise.all([
    Promise.allSettled([
      collectPostHog(run),
      collectVercelFeedback(
        run,
        vercelFetchScript,
        join(project, "apps", "deskohub-workspace")
      ),
      collectNightlyE2E(run, repo),
    ]),
    legacyVercelOwnership(project),
  ]);
  const [posthog, vercel, nightly] = collectorResults;
  const failedSources = [
    ...(posthog.status === "rejected" ? ["posthog"] : []),
    ...(vercel.status === "rejected" ? ["vercel"] : []),
    ...(nightly.status === "rejected" ? ["nightly"] : []),
  ];
  const signals = [
    ...(posthog.status === "fulfilled" ? posthog.value : []),
    ...(vercel.status === "fulfilled" ? vercel.value : []),
    ...(nightly.status === "fulfilled" ? nightly.value : []),
  ];
  const tracker = githubIssueTracker({
    ...github,
    run,
    legacyFeedbackClaimed,
  });
  const runner = t3WorkerRunner({ executable: t3, project, repo, run });
  const pool =
    state && (apply || (await Bun.file(state).exists()))
      ? new IssuePool(state, !apply)
      : new IssuePool(":memory:");
  try {
    const result = await runIssuePool({
      apply,
      maxNewIssues,
      maxNewWorkers,
      pool,
      runner,
      signals,
      tracker,
    });
    process.stdout.write(
      `${JSON.stringify({
        apply,
        failedSources,
        signalCount: signals.length,
        ...result,
      })}\n`
    );
    if (
      failedSources.length > 0 ||
      result.pendingAssignment.length > 0 ||
      result.pendingIntake.length > 0 ||
      result.pendingReply.length > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    pool.close();
  }
}

await main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError ||
      error instanceof CommandFailure ||
      error instanceof GitHubIdentityError
      ? error.message
      : "Issue pool pass failed"
  );
  process.exitCode = 1;
});
