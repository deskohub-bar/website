import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Issue,
  IssuePool,
  type IssueTracker,
  runIssuePool,
  type WorkerRunner,
} from "./pool";
import type { Signal } from "./sources";

const logSignal: Signal = {
  key: "posthog:log:stable-pattern",
  title: "Workspace error",
  evidence: "A source reference",
  legacyMarkers: ["<!-- posthog-log-uuid:prior-event -->"],
  source: "posthog",
  observedAt: "2026-11-21T13:00:00Z",
  priority: "high",
};
const feedbackSignal: Signal = {
  commentId: "thread",
  key: "vercel:feedback:stable-thread",
  title: "Vercel feedback",
  evidence: "A feedback link",
  legacyMarkers: ["https://vercel.com/team/project/c/thread"],
  source: "vercel",
  observedAt: "2026-11-21T12:00:00Z",
  priority: "normal",
};

const issue = (number: number, body = ""): Issue => ({
  number,
  body,
  labels: [],
  assignees: [],
  state: "open",
  createdAt: "2026-11-21T10:00:00Z",
  closedAt: null,
});

function fixture() {
  const issues: Issue[] = [];
  const workers = new Map<number, string>();
  const reported = new Set<number>();
  const launches: number[] = [];
  const tracker: IssueTracker = {
    list: async () => [...issues],
    file: async (_title, body) => {
      const created = issue(issues.length + 1, body);
      issues.push(created);
      return created;
    },
    hasOwner: async (number) => reported.has(number),
    hasClosedWork: async (number) => reported.has(number),
    legacyFeedbackClaimed: () => false,
    suppressesRecurrence: async () => false,
    pendingReply: async () => null,
    recordReply: async () => {},
    recordNightlyRuns: async () => {},
    recordWorker: async (number) => {
      reported.add(number);
    },
  };
  const runner: WorkerRunner = {
    sendReply: async () => {},
    receivedReply: async () => false,
    find: async (number) => workers.get(number) ?? null,
    start: async (number) => {
      launches.push(number);
      const threadId = `worker-${number}`;
      workers.set(number, threadId);
      return threadId;
    },
  };
  return { issues, launches, tracker, runner };
}

const run = (
  pool: IssuePool,
  tracker: IssueTracker,
  runner: WorkerRunner,
  signals: Signal[],
  apply = true
) =>
  runIssuePool({
    pool,
    tracker,
    runner,
    signals,
    apply,
    maxNewIssues: 1,
    maxNewWorkers: 1,
  });

test("shares one priority, filing, and assignment policy across sources", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, launches, tracker, runner } = fixture();
  try {
    const preview = await run(
      pool,
      tracker,
      runner,
      [feedbackSignal, logSignal],
      false
    );
    expect(preview.plannedIntake).toEqual([logSignal.key, feedbackSignal.key]);
    expect(issues).toEqual([]);
    expect(launches).toEqual([]);
    await run(pool, tracker, runner, [feedbackSignal, logSignal]);
    expect(issues.map(({ number }) => number)).toEqual([1]);
    expect(issues[0]?.body).toContain(logSignal.evidence);
    await run(pool, tracker, runner, [feedbackSignal, logSignal]);
    expect(issues[1]?.body).toContain(feedbackSignal.evidence);
    expect(launches).toEqual([1, 2]);
    await run(pool, tracker, runner, [feedbackSignal, logSignal]);
    expect(issues).toHaveLength(2);
    expect(launches).toEqual([1, 2]);
  } finally {
    pool.close();
  }
});

test("adopts legacy issues and respects a human assignee", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  try {
    issues.push(
      {
        ...issue(1, logSignal.legacyMarkers.join("\n")),
        assignees: ["maintainer"],
      },
      issue(2, feedbackSignal.legacyMarkers.join("\n")),
      issue(3, "An unrelated issue")
    );
    const result = await run(pool, tracker, runner, [
      logSignal,
      feedbackSignal,
    ]);
    expect(result.filed).toEqual([]);
    expect(launches).toEqual([2]);
  } finally {
    pool.close();
  }
});

test("reconciles an accepted launch whose response was lost across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deskohub-issue-pool-"));
  const path = join(dir, "state.sqlite");
  const { launches, tracker, runner } = fixture();
  const uncertainRunner: WorkerRunner = {
    ...runner,
    async start(number) {
      await runner.start(number);
      throw new Error("Lost response");
    },
  };
  try {
    const first = new IssuePool(path);
    try {
      const result = await run(first, tracker, uncertainRunner, [logSignal]);
      expect(result.pendingAssignment).toEqual([1]);
    } finally {
      first.close();
    }
    const restarted = new IssuePool(path);
    try {
      const result = await run(restarted, tracker, runner, [logSignal]);
      expect(result.assigned).toEqual([1]);
      expect(launches).toEqual([1]);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remembers adoption after a legacy PostHog occurrence ages out", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  try {
    issues.push({
      ...issue(1, logSignal.legacyMarkers.join("\n")),
      assignees: ["maintainer"],
    });
    await run(pool, tracker, runner, [logSignal]);
    const result = await run(pool, tracker, runner, [
      {
        ...logSignal,
        legacyMarkers: ["<!-- posthog-log-uuid:later-event -->"],
      },
    ]);
    expect(result.filed).toEqual([]);
    expect(launches).toEqual([]);
  } finally {
    pool.close();
  }
});

test("matches the exact Vercel comment ID without depending on its permalink", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  try {
    issues.push(issue(1, "https://vercel.com/team/project/c/threadx"));
    const preview = await run(pool, tracker, runner, [feedbackSignal], false);
    expect(preview.plannedIntake).toEqual([feedbackSignal.key]);
    issues.push(
      issue(2, "https://vercel.com/team/project/c/thread/?from=toolbar")
    );
    const match = await run(pool, tracker, runner, [
      { ...feedbackSignal, legacyMarkers: [] },
    ]);
    expect(match.filed).toEqual([]);
    expect(launches).toEqual([2]);
    issues.length = 0;
    const manifestOnly = await run(
      pool,
      { ...tracker, legacyFeedbackClaimed: (id) => id === "thread" },
      runner,
      [{ ...feedbackSignal, legacyMarkers: [] }]
    );
    expect(manifestOnly.filed).toEqual([]);
    expect(launches).toEqual([2]);
  } finally {
    pool.close();
  }
});

test("keeps an existing worker when two open issues match the same fingerprint", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  try {
    const markers = [
      "<!-- posthog-log-uuid:prior-one -->",
      "<!-- posthog-log-uuid:prior-two -->",
    ];
    issues.push(...markers.map((marker, index) => issue(index + 1, marker)));
    const ownership = {
      ...tracker,
      hasOwner: async (number: number) => number === 2,
    };
    const first = await run(pool, ownership, runner, [
      { ...logSignal, legacyMarkers: markers },
    ]);
    const later = await run(pool, ownership, runner, []);
    expect(first.duplicateGroups).toEqual([[1, 2]]);
    expect(later.duplicateGroups).toEqual([[1, 2]]);
    expect(launches).toEqual([]);
  } finally {
    pool.close();
  }
});

test("assigns one worker when different sources explicitly name the same fix", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  const fix = "<!-- issue-pool-fix:checkout-pricing -->";
  try {
    issues.push(
      issue(1, [fix, ...logSignal.legacyMarkers].join("\n")),
      issue(2, [fix, ...feedbackSignal.legacyMarkers].join("\n"))
    );
    const result = await runIssuePool({
      pool,
      tracker,
      runner,
      signals: [logSignal, feedbackSignal],
      apply: true,
      maxNewIssues: 2,
      maxNewWorkers: 2,
    });
    expect(result.duplicateGroups).toEqual([[1, 2]]);
    expect(launches).toEqual([1]);
  } finally {
    pool.close();
  }
});

test("closing the owned issue covers its old siblings while newer evidence can open a recurrence", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  const fix = "<!-- issue-pool-fix:checkout-pricing -->";
  try {
    const primary = { ...issue(1, fix), labels: ["issue-pool"] };
    issues.push(
      primary,
      issue(2, [fix, ...logSignal.legacyMarkers].join("\n"))
    );
    await run(pool, tracker, runner, [logSignal]);
    expect(launches).toEqual([1]);
    issues[0] = {
      ...primary,
      state: "closed",
      closedAt: "2026-11-21T14:00:00Z",
    };
    await run(pool, tracker, runner, []);
    await run(pool, tracker, runner, [logSignal]);
    expect(issues).toHaveLength(2);
    expect(launches).toEqual([1]);
    const recurrence = await run(pool, tracker, runner, [
      { ...logSignal, observedAt: "2026-11-21T15:00:00Z" },
    ]);
    expect(recurrence.filed).toEqual([3]);
    expect(launches).toEqual([1, 3]);
  } finally {
    pool.close();
  }
});

test("a closing PR preserves a fix group's ownership after merge", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  const fix = "<!-- issue-pool-fix:checkout-pricing -->";
  const primary = { ...issue(1, fix), labels: ["issue-pool"] };
  const sibling = { ...issue(2, fix), labels: ["issue-pool"] };
  let merged = false;
  const linkedPRTracker: IssueTracker = {
    ...tracker,
    hasOwner: async (number) => number === 1 && !merged,
    hasClosedWork: async (number) => number === 1 && merged,
  };
  try {
    issues.push(primary, sibling);
    await run(pool, linkedPRTracker, runner, []);
    expect(launches).toEqual([]);
    merged = true;
    issues[0] = {
      ...primary,
      state: "closed",
      closedAt: "2026-11-21T14:00:00Z",
    };
    const later = await run(pool, linkedPRTracker, runner, []);
    expect(later.duplicateGroups).toEqual([[1, 2]]);
    expect(later.plannedAssignment).toEqual([]);
    expect(launches).toEqual([]);
  } finally {
    pool.close();
  }
});

test("reconciles the existing worker's reply even when only its sibling is enrolled", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  const fix = "<!-- issue-pool-fix:checkout-pricing -->";
  const reply = { commentId: 52, message: "The answer", threadId: "worker-2" };
  const delivered: string[] = [];
  try {
    issues.push({ ...issue(1, fix), labels: ["issue-pool"] }, issue(2, fix));
    const result = await run(
      pool,
      {
        ...tracker,
        hasOwner: async (number) => number === 2,
        pendingReply: async (number) => (number === 2 ? reply : null),
      },
      {
        ...runner,
        sendReply: async ({ threadId }) => {
          delivered.push(threadId);
        },
      },
      []
    );
    expect(result.replied).toEqual([2]);
    expect(delivered).toEqual(["worker-2"]);
    expect(launches).toEqual([]);
  } finally {
    pool.close();
  }
});

test("preserves maintainer replies after adopted feedback leaves the collector", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  const reply = { commentId: 52, message: "The answer", threadId: "worker-1" };
  const delivered: number[] = [];
  try {
    issues.push(issue(1, feedbackSignal.legacyMarkers.join("\n")));
    await run(pool, tracker, runner, [feedbackSignal]);
    const result = await run(
      pool,
      {
        ...tracker,
        pendingReply: async () => reply,
      },
      {
        ...runner,
        sendReply: async ({ commentId }) => {
          delivered.push(commentId);
        },
      },
      []
    );
    expect(result.replied).toEqual([1]);
    expect(delivered).toEqual([52]);
    expect(launches).toEqual([1]);
  } finally {
    pool.close();
  }
});

test("honors the disposition on a closed legacy issue before filing a recurrence", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner } = fixture();
  try {
    issues.push({
      ...issue(1, logSignal.legacyMarkers.join("\n")),
      state: "closed",
      closedAt: "2026-11-21T12:00:00Z",
    });
    const withoutDisposition = await run(
      pool,
      tracker,
      runner,
      [logSignal],
      false
    );
    expect(withoutDisposition.plannedIntake).toEqual([logSignal.key]);
    const suppressed = await run(
      pool,
      { ...tracker, suppressesRecurrence: async (number) => number === 1 },
      runner,
      [logSignal]
    );
    expect(suppressed.filed).toEqual([]);
    expect(suppressed.plannedIntake).toEqual([]);
  } finally {
    pool.close();
  }
});

test("resumes a recorded worker once and recovers a lost reply acknowledgement", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  const reply = {
    commentId: 52,
    message: "Here is the answer",
    threadId: "prior-worker",
  };
  let sends = 0;
  let consumed = false;
  const migrationTracker: IssueTracker = {
    ...tracker,
    hasOwner: async () => true,
    pendingReply: async () => (consumed ? null : reply),
    async recordReply(number, commentId) {
      expect([number, commentId]).toEqual([1, 52]);
      consumed = true;
    },
  };
  const migrationRunner: WorkerRunner = {
    ...runner,
    async sendReply(answer) {
      expect(answer).toEqual(reply);
      sends++;
      throw new Error("Lost response after send");
    },
    receivedReply: async () => sends === 1,
  };
  try {
    issues.push(issue(1, logSignal.legacyMarkers.join("\n")));
    const firstPass = await run(pool, migrationTracker, migrationRunner, []);
    expect(firstPass.pendingReply).toEqual([1]);
    expect(consumed).toBe(false);
    const secondPass = await run(pool, migrationTracker, migrationRunner, []);
    expect(secondPass.replied).toEqual([1]);
    await run(pool, migrationTracker, migrationRunner, []);
    expect(sends).toBe(1);
    expect(launches).toEqual([]);
  } finally {
    pool.close();
  }
});

test("keeps an ambiguous issue creation reserved and adopts it when it appears", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner } = fixture();
  let created: Issue | undefined;
  let attempts = 0;
  const uncertainTracker: IssueTracker = {
    ...tracker,
    async file(_title, body) {
      attempts++;
      created = issue(1, body);
      throw new Error("Lost response");
    },
  };
  try {
    expect(
      (await run(pool, uncertainTracker, runner, [logSignal])).pendingIntake
    ).toEqual([logSignal.key]);
    expect(
      (await run(pool, uncertainTracker, runner, [logSignal])).pendingIntake
    ).toEqual([logSignal.key]);
    expect(attempts).toBe(1);
    if (!created) throw new Error("Expected an accepted issue");
    issues.push(created);
    expect(
      (await run(pool, uncertainTracker, runner, [logSignal])).assigned
    ).toEqual([1]);
  } finally {
    pool.close();
  }
});

test("repeated nightly run failures accumulate on one issue and worker", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  const attempts = [
    "https://github.com/owner/repository/actions/runs/101/attempts/1",
    "https://github.com/owner/repository/actions/runs/102/attempts/1",
  ];
  const firstNight: Signal = {
    ...logSignal,
    key: "nightly:diagnostic:checkout-timeout",
    source: "nightly",
    legacyMarkers: [],
    runUrls: attempts.slice(0, 1),
  };
  const observed: { number: number; runs: readonly string[] }[] = [];
  const trackerWithEvidence: IssueTracker = {
    ...tracker,
    async recordNightlyRuns(existing, runs) {
      observed.push({ number: existing.number, runs });
    },
  };
  try {
    await run(pool, trackerWithEvidence, runner, [firstNight]);
    const later = await run(pool, trackerWithEvidence, runner, [
      { ...firstNight, runUrls: attempts },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.body).toContain(attempts[0]);
    expect(later.filed).toEqual([]);
    expect(observed).toEqual([{ number: 1, runs: attempts }]);
    expect(launches).toEqual([1]);
  } finally {
    pool.close();
  }
});
