import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { groupIssues } from "./deduplication";
import { feedbackCommentIds } from "./feedback";
import { formatNightlyEvidence } from "./nightly-evidence";
import type { Signal } from "./sources";

export interface Issue {
  number: number;
  state: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  body: string;
  labels: readonly string[];
  assignees: readonly string[];
}

export interface IssueTracker {
  list(): Promise<readonly Issue[]>;
  file(title: string, body: string): Promise<Issue>;
  hasOwner(number: number): Promise<boolean>;
  hasClosedWork(number: number): Promise<boolean>;
  recordWorker(number: number, threadId: string): Promise<void>;
  legacyFeedbackClaimed(commentId: string): boolean;
  suppressesRecurrence(number: number): Promise<boolean>;
  pendingReply(number: number): Promise<WorkerReply | null>;
  recordReply(number: number, commentId: number): Promise<void>;
  recordNightlyRuns(issue: Issue, runUrls: readonly string[]): Promise<void>;
}

export interface WorkerReply {
  commentId: number;
  threadId: string;
  message: string;
}

export interface WorkerRunner {
  find(number: number): Promise<string | null>;
  start(number: number): Promise<string>;
  sendReply(reply: WorkerReply): Promise<void>;
  receivedReply(reply: WorkerReply): Promise<boolean>;
}

interface Claim {
  threadId: string | null;
  reported: number;
}

export interface PassResult {
  filed: number[];
  assigned: number[];
  pendingIntake: string[];
  pendingAssignment: number[];
  plannedIntake: string[];
  plannedAssignment: number[];
  replied: number[];
  pendingReply: number[];
  plannedReply: number[];
  duplicateGroups: number[][];
}

const issuePoolLabel = "issue-pool";
const sourceMarker = (key: string) =>
  `<!-- issue-pool-source:${createHash("sha256").update(key).digest("hex")} -->`;

const ownedByPool = (issue: Issue) =>
  issue.labels.includes(issuePoolLabel) ||
  /<!-- (?:issue-pool-source:[0-9a-f]{64}|posthog-(?:log-uuid|error-issue|error-event|manual-issue):[^<>]+) -->/.test(
    issue.body
  );

const matches = (issue: Issue, signal: Signal) =>
  issue.body.includes(sourceMarker(signal.key)) ||
  (signal.source === "vercel"
    ? feedbackCommentIds(issue.body).has(signal.commentId)
    : signal.legacyMarkers.some((marker) => issue.body.includes(marker)));

async function needsIssue(
  matching: readonly Issue[],
  signal: Signal,
  tracker: IssueTracker
) {
  if (signal.source === "vercel") {
    return (
      matching.length === 0 && !tracker.legacyFeedbackClaimed(signal.commentId)
    );
  }
  for (const issue of matching) {
    if (
      issue.state !== "closed" ||
      issue.closedAt === null ||
      Date.parse(signal.observedAt) <= Date.parse(issue.closedAt) ||
      issue.body.includes("<!-- posthog-agent:triage-non-actionable -->") ||
      (await tracker.suppressesRecurrence(issue.number))
    ) {
      return false;
    }
  }
  return true;
}

export class IssuePool {
  private readonly database: Database;

  constructor(path: string, readonly = false) {
    this.database = new Database(path, {
      readonly,
      create: !readonly,
      strict: true,
    });
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (!readonly)
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS intake (
        source_key TEXT NOT NULL,
        previous_issue INTEGER NOT NULL,
        PRIMARY KEY (source_key, previous_issue)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assignment (
        issue INTEGER PRIMARY KEY,
        thread_id TEXT,
        reported INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_issue (
        source_key TEXT NOT NULL,
        issue INTEGER NOT NULL,
        PRIMARY KEY (source_key, issue)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS worker_reply (
        comment_id INTEGER PRIMARY KEY,
        accepted INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  sourceGroups(): Map<string, Set<number>> {
    const sources = new Map<string, Set<number>>();
    const rows = this.database
      .query<{ sourceKey: string; issue: number }, []>(
        "SELECT source_key AS sourceKey, issue FROM source_issue"
      )
      .all();
    for (const { sourceKey, issue } of rows) {
      let members = sources.get(sourceKey);
      if (!members) {
        members = new Set();
        sources.set(sourceKey, members);
      }
      members.add(issue);
    }
    return sources;
  }

  linkIssue(key: string, number: number): void {
    this.database
      .query("INSERT OR IGNORE INTO source_issue VALUES (?, ?)")
      .run(key, number);
  }

  reserveReply(commentId: number): boolean {
    return (
      this.database
        .query("INSERT OR IGNORE INTO worker_reply (comment_id) VALUES (?)")
        .run(commentId).changes === 1
    );
  }

  replyAccepted(commentId: number): boolean {
    return (
      this.database
        .query<{ accepted: number }, [number]>(
          "SELECT accepted FROM worker_reply WHERE comment_id = ?"
        )
        .get(commentId)?.accepted === 1
    );
  }

  acceptReply(commentId: number): void {
    this.database
      .query("UPDATE worker_reply SET accepted = 1 WHERE comment_id = ?")
      .run(commentId);
  }

  reserveIntake(key: string, previousIssue: number): boolean {
    return (
      this.database
        .query("INSERT OR IGNORE INTO intake VALUES (?, ?)")
        .run(key, previousIssue).changes === 1
    );
  }

  reserveAssignment(number: number): boolean {
    return (
      this.database
        .query("INSERT OR IGNORE INTO assignment (issue) VALUES (?)")
        .run(number).changes === 1
    );
  }

  claim(number: number): Claim | null {
    return this.database
      .query<Claim, [number]>(
        "SELECT thread_id AS threadId, reported FROM assignment WHERE issue = ?"
      )
      .get(number);
  }

  record(number: number, threadId: string): void {
    this.database
      .query("UPDATE assignment SET thread_id = ? WHERE issue = ?")
      .run(threadId, number);
  }

  markReported(number: number): void {
    this.database
      .query("UPDATE assignment SET reported = 1 WHERE issue = ?")
      .run(number);
  }
}

export async function runIssuePool({
  pool,
  tracker,
  runner,
  signals,
  apply,
  maxNewIssues,
  maxNewWorkers,
}: {
  pool: IssuePool;
  tracker: IssueTracker;
  runner: WorkerRunner;
  signals: readonly Signal[];
  apply: boolean;
  maxNewIssues: number;
  maxNewWorkers: number;
}): Promise<PassResult> {
  const result: PassResult = {
    filed: [],
    assigned: [],
    pendingIntake: [],
    pendingAssignment: [],
    plannedIntake: [],
    plannedAssignment: [],
    replied: [],
    pendingReply: [],
    plannedReply: [],
    duplicateGroups: [],
  };
  const issues = [...(await tracker.list())];
  const eligible = new Set<number>();
  const seen = new Set<string>();
  const sourceGroups = pool.sourceGroups();
  for (const members of sourceGroups.values()) {
    for (const number of members) eligible.add(number);
  }
  let intakeAttempts = 0;
  let assignmentAttempts = 0;
  const reports: { signal: Signal; linked: Set<number>; matching: Issue[] }[] =
    [];
  const ordered = Array.from(signals).sort(
    (left, right) =>
      Number(right.priority === "high") - Number(left.priority === "high") ||
      left.observedAt.localeCompare(right.observedAt) ||
      left.key.localeCompare(right.key)
  );

  for (const signal of ordered) {
    if (seen.has(signal.key)) {
      continue;
    }
    seen.add(signal.key);
    const linked = sourceGroups.get(signal.key) ?? new Set<number>();
    sourceGroups.set(signal.key, linked);
    const matching = issues.filter(
      (issue) => linked.has(issue.number) || matches(issue, signal)
    );
    for (const issue of matching) {
      eligible.add(issue.number);
      if (apply && !linked.has(issue.number))
        pool.linkIssue(signal.key, issue.number);
      linked.add(issue.number);
    }
    reports.push({ signal, linked, matching });
  }

  const covered = await coveredIssues(
    groupIssues(issues, sourceGroups.values()),
    pool,
    tracker
  );
  for (const { signal, linked, matching: original } of reports) {
    const matching = original.map(
      (issue) => covered.get(issue.number) ?? issue
    );
    try {
      if (apply && signal.source === "nightly") {
        const existing = matching.find((issue) => issue.state === "open");
        if (existing) await tracker.recordNightlyRuns(existing, signal.runUrls);
      }
      if (!(await needsIssue(matching, signal, tracker))) {
        continue;
      }
      result.plannedIntake.push(signal.key);
      if (!apply || intakeAttempts >= maxNewIssues) {
        continue;
      }
      const previousIssue = Math.max(
        0,
        ...matching.map((issue) => issue.number)
      );
      if (!pool.reserveIntake(signal.key, previousIssue)) {
        result.pendingIntake.push(signal.key);
        continue;
      }
      intakeAttempts++;
      const issue = await tracker.file(
        signal.title,
        [
          signal.evidence,
          ...(signal.source === "nightly"
            ? [formatNightlyEvidence(signal.runUrls)]
            : []),
          sourceMarker(signal.key),
          ...signal.legacyMarkers.slice(-20),
        ].join("\n\n")
      );
      issues.push(issue);
      pool.linkIssue(signal.key, issue.number);
      linked.add(issue.number);
      eligible.add(issue.number);
      result.filed.push(issue.number);
    } catch {
      result.pendingIntake.push(signal.key);
    }
  }

  const orderedIssues = issues.toSorted(
    (left, right) => left.number - right.number
  );
  for (const related of groupIssues(orderedIssues, sourceGroups.values())) {
    const open = related.filter((issue) => issue.state === "open");
    const enrolled = open.filter(
      (issue) =>
        ownedByPool(issue) ||
        eligible.has(issue.number) ||
        pool.claim(issue.number) !== null
    );
    if (enrolled.length === 0) {
      continue;
    }
    for (const issue of open) {
      await reconcileReply({
        apply,
        number: issue.number,
        pool,
        result,
        runner,
        tracker,
      });
    }
    const group = open.filter((issue) => !covered.has(issue.number));
    const candidates = enrolled.filter((issue) => !covered.has(issue.number));
    if (related.length > 1) {
      result.duplicateGroups.push(related.map((member) => member.number));
    }
    if (candidates.length === 0) continue;
    let issue = candidates[0];
    if (group.length > 1) {
      issue = await chooseGroupIssue(group, issue, {
        pool,
        result,
        runner,
        tracker,
        apply,
      });
    }
    if (!issue || issue.assignees.length > 0) {
      continue;
    }
    assignmentAttempts += await assignIssue({
      apply,
      issue,
      allowLaunch: assignmentAttempts < maxNewWorkers,
      pool,
      result,
      runner,
      tracker,
    });
  }
  return result;
}

async function coveredIssues(
  groups: readonly Issue[][],
  pool: IssuePool,
  tracker: IssueTracker
): Promise<Map<number, Issue>> {
  const covered = new Map<number, Issue>();
  for (const group of groups) {
    const open = group.filter((issue) => issue.state === "open");
    if (open.length === 0) continue;
    const closed = group
      .filter((issue) => issue.state === "closed" && issue.closedAt !== null)
      .sort(
        (left, right) =>
          Date.parse(right.closedAt ?? "") - Date.parse(left.closedAt ?? "")
      );
    for (const issue of closed) {
      const siblings = open.filter(
        (candidate) =>
          !covered.has(candidate.number) &&
          Date.parse(candidate.createdAt) <= Date.parse(issue.closedAt ?? "")
      );
      if (siblings.length === 0) continue;
      if (
        pool.claim(issue.number)?.threadId ||
        issue.assignees.length > 0 ||
        (await tracker.hasClosedWork(issue.number))
      ) {
        for (const sibling of siblings) covered.set(sibling.number, issue);
      }
    }
  }
  return covered;
}

async function chooseGroupIssue(
  group: readonly Issue[],
  fallback: Issue | undefined,
  {
    pool,
    result,
    runner,
    tracker,
    apply,
  }: {
    pool: IssuePool;
    result: PassResult;
    runner: WorkerRunner;
    tracker: IssueTracker;
    apply: boolean;
  }
): Promise<Issue | undefined> {
  try {
    for (const issue of group) {
      if (issue.assignees.length > 0 || (await tracker.hasOwner(issue.number)))
        return;
    }
    const claimed = group.find((issue) => pool.claim(issue.number) !== null);
    if (claimed) return claimed;
    if (apply) {
      for (const issue of group) {
        const threadId = await runner.find(issue.number);
        if (threadId) {
          pool.reserveAssignment(issue.number);
          pool.record(issue.number, threadId);
          return issue;
        }
      }
    }
    return fallback;
  } catch {
    if (fallback) result.pendingAssignment.push(fallback.number);
    return;
  }
}

async function reconcileReply({
  apply,
  number,
  pool,
  result,
  runner,
  tracker,
}: {
  apply: boolean;
  number: number;
  pool: IssuePool;
  result: PassResult;
  runner: WorkerRunner;
  tracker: IssueTracker;
}): Promise<void> {
  try {
    const reply = await tracker.pendingReply(number);
    if (!reply) return;
    result.plannedReply.push(number);
    if (!apply) return;
    if (pool.reserveReply(reply.commentId)) {
      await runner.sendReply(reply);
      pool.acceptReply(reply.commentId);
    } else if (!pool.replyAccepted(reply.commentId)) {
      if (!(await runner.receivedReply(reply))) {
        result.pendingReply.push(number);
        return;
      }
      pool.acceptReply(reply.commentId);
    }
    await tracker.recordReply(number, reply.commentId);
    result.replied.push(number);
  } catch {
    result.pendingReply.push(number);
  }
}

async function assignIssue({
  apply,
  issue,
  allowLaunch,
  pool,
  result,
  runner,
  tracker,
}: {
  apply: boolean;
  issue: Issue;
  allowLaunch: boolean;
  pool: IssuePool;
  result: PassResult;
  runner: WorkerRunner;
  tracker: IssueTracker;
}): Promise<0 | 1> {
  const number = issue.number;
  const claim = pool.claim(number);
  let launchAttempt: 0 | 1 = 0;
  try {
    if (claim?.reported || (await tracker.hasOwner(number))) {
      return 0;
    }
    result.plannedAssignment.push(number);
    if (!apply) {
      return 0;
    }
    let thread = claim?.threadId ?? (await runner.find(number));
    if (!thread) {
      if (!allowLaunch) {
        return 0;
      }
      if (!pool.reserveAssignment(number)) {
        result.pendingAssignment.push(number);
        return 0;
      }
      launchAttempt = 1;
      thread = await runner.start(number);
    } else {
      pool.reserveAssignment(number);
    }
    pool.record(number, thread);
    await tracker.recordWorker(number, thread);
    pool.markReported(number);
    result.assigned.push(number);
  } catch {
    result.pendingAssignment.push(number);
  }
  return launchAttempt;
}
