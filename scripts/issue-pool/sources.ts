import { createHash } from "node:crypto";

export type RunCommand = (
  command: string,
  args: readonly string[]
) => Promise<string>;

export type Signal = Readonly<{
  key: string;
  title: string;
  evidence: string;
  legacyMarkers: readonly string[];
  observedAt: string;
  priority: "high" | "normal";
}> &
  (
    | { readonly source: "posthog" }
    | { readonly source: "vercel"; readonly commentId: string }
    | { readonly source: "nightly"; readonly runUrls: readonly string[] }
  );

const weekMs = 7 * 24 * 60 * 60 * 1000;
const logLimit = 1000;
const maxLogWindows = 4096;
const issuePageSize = 100;
const maxIssuePages = 100;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const commentIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const commentLinkPattern =
  /^https:\/\/vercel\.com(?:\/[A-Za-z0-9_-]{1,128}){1,4}\/c\/[A-Za-z0-9_-]{1,128}$/;
const posthogProjectUrl = "https://eu.posthog.com/project/204184";

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} returned a malformed object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} returned a malformed list`);
  }
  return value;
}

function count(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} returned an invalid count or offset`);
  }
  return value;
}

function identity(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${context} returned an invalid identifier`);
  }
  return value;
}

function observedAt(value: unknown, context: string): string {
  if (typeof value === "string" && timestampPattern.test(value)) {
    const day = value.slice(0, 10);
    const midnight = new Date(`${day}T00:00:00Z`);
    if (
      Number.isFinite(midnight.getTime()) &&
      midnight.toISOString().startsWith(day) &&
      Number.isFinite(Date.parse(value))
    ) {
      return new Date(value).toISOString();
    }
  }
  throw new Error(`${context} returned an invalid timestamp`);
}

async function readJson(
  run: RunCommand,
  command: string,
  args: readonly string[],
  context: string
): Promise<Record<string, unknown>> {
  let output: string;
  try {
    output = await run(command, args);
  } catch {
    throw new Error(`${context} command failed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
  return record(parsed, context);
}

function posthog(run: RunCommand, tool: string, input: object) {
  return readJson(
    run,
    "posthog-cli",
    ["api", "call", "--json", tool, JSON.stringify(input)],
    `PostHog ${tool}`
  );
}

function dateRange(start: number, end: number) {
  return {
    date_from: new Date(start).toISOString(),
    date_to: new Date(end).toISOString(),
  };
}

const production = {
  key: "deployment.environment.name",
  operator: "exact",
  value: "production",
};

function firstMessage(body: string): string {
  const text = body.trimStart();
  // The Workspace OTLP logger can serialize the message and its structured
  // arguments into one array. The first argument holds the message template.
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return typeof parsed[0] === "string" ? parsed[0] : "";
      }
    } catch {
      // Plain text can also start with a bracket.
    }
  }
  return text.startsWith("{") ? "" : text;
}

function logFingerprint(body: string, attributes: unknown): string {
  const [firstLine = ""] = firstMessage(body).slice(0, 1024).split(/\r?\n/, 1);
  const template = firstLine
    .replace(/\bhttps?:\/\/\S+/gi, "<value>")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "<value>")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "<value>")
    .replace(
      /\b(access[ _-]*code|api[ _-]*key|authorization|email|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1 <value>"
    )
    .replace(/\bbearer\s+\S+/gi, "bearer <value>")
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, "<value>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<value>")
    .replace(/\b[\w-]*\d[\w-]*\b/g, "<value>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const annotations =
    attributes === undefined
      ? {}
      : record(attributes, "PostHog log attributes");
  const classifications = [
    "boundary",
    "operation",
    "spanName",
    "failureKind",
    "_tag",
    "code",
    "statusCode",
  ].map((key) => {
    const value = annotations[key];
    return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,100}$/.test(value)
      ? value
      : null;
  });
  return createHash("sha256")
    .update(JSON.stringify([template, classifications]))
    .digest("hex");
}

type LogGroup = {
  latestId: string;
  observedAt: string;
  priority: Signal["priority"];
  occurrenceCount: number;
  markers: Set<string>;
};

function addLog(
  value: unknown,
  groups: Map<string, LogGroup>,
  seenLogs: Map<string, string>,
  windowIds: Set<string>
) {
  const context = "PostHog log";
  const row = record(value, context);
  const rawId = identity(row.uuid, uuidPattern, context);
  const id = rawId.toLowerCase();
  if (windowIds.has(id)) {
    throw new Error("PostHog repeated a log occurrence inside a window");
  }
  windowIds.add(id);
  const timestamp = observedAt(row.timestamp, context);
  const severity = row.severity_text;
  if (
    typeof row.body !== "string" ||
    (severity !== "error" && severity !== "fatal")
  ) {
    throw new Error(`${context} returned an invalid body or severity`);
  }
  const fingerprint = logFingerprint(row.body, row.attributes);
  const occurrence = `${fingerprint}:${timestamp}:${severity}`;
  const seen = seenLogs.get(id);
  if (seen !== undefined && seen !== occurrence) {
    throw new Error("PostHog returned conflicting rows for a log occurrence");
  }
  seenLogs.set(id, occurrence);

  const group = groups.get(fingerprint) ?? {
    latestId: id,
    observedAt: timestamp,
    priority: "normal",
    occurrenceCount: 0,
    markers: new Set<string>(),
  };
  if (
    timestamp > group.observedAt ||
    (timestamp === group.observedAt && id < group.latestId)
  ) {
    group.latestId = id;
    group.observedAt = timestamp;
  }
  if (severity === "fatal") group.priority = "high";
  if (seen === undefined) group.occurrenceCount++;
  group.markers.add(`<!-- posthog-log-uuid:${rawId} -->`);
  group.markers.add(`<!-- posthog-log-uuid:${id} -->`);
  groups.set(fingerprint, group);
}

async function collectLogs(
  run: RunCommand,
  start: number,
  end: number
): Promise<Signal[]> {
  const groups = new Map<string, LogGroup>();
  const seen = new Map<string, string>();
  let windows = 0;

  async function readWindow(from: number, to: number): Promise<number> {
    if (++windows > maxLogWindows) {
      throw new Error("PostHog log collection exceeded its window limit");
    }
    const query = {
      dateRange: dateRange(from, to),
      severityLevels: ["error", "fatal"],
      serviceNames: ["deskohub-workspace"],
      filterGroup: [{ ...production, type: "log_resource_attribute" }],
    };
    const result = await posthog(run, "logs-count", { query });
    const expected = count(result.count, "PostHog logs-count");
    if (expected > logLimit) {
      const middle = from + Math.floor((to - from) / 2);
      if (middle === from) {
        throw new Error(
          "PostHog log count exceeds the limit in one millisecond"
        );
      }
      const left = await readWindow(from, middle);
      const right = await readWindow(middle, to);
      if (left + right !== expected) {
        throw new Error("PostHog log counts changed while splitting a window");
      }
    } else if (expected > 0) {
      const page = await posthog(run, "query-logs", {
        query: {
          ...query,
          orderBy: "earliest",
          limit: logLimit,
          excludeAttributes: false,
        },
      });
      const rows = list(page.results, "PostHog query-logs");
      if (
        rows.length !== expected ||
        (page.hasMore !== undefined && page.hasMore !== false) ||
        page.nextCursor != null
      ) {
        throw new Error("PostHog returned an incomplete log window");
      }
      const windowIds = new Set<string>();
      for (const row of rows) {
        addLog(row, groups, seen, windowIds);
      }
    }
    return expected;
  }

  await readWindow(start, end);
  return Array.from(groups, ([fingerprint, group]) => ({
    key: `posthog:log:${fingerprint}`,
    title: `[PostHog] Workspace ${group.priority === "high" ? "fatal" : "error"} log ${fingerprint.slice(0, 12)}`,
    evidence: `Matching production log occurrences in the past seven days: ${group.occurrenceCount}. Latest occurrence UUID: ${group.latestId}. [PostHog Logs](${posthogProjectUrl}/logs)`,
    legacyMarkers: [...group.markers].sort(),
    observedAt: group.observedAt,
    source: "posthog",
    priority: group.priority,
  }));
}

async function collectErrorIssues(
  run: RunCommand,
  start: number,
  end: number
): Promise<Signal[]> {
  const context = "PostHog Error Tracking";
  const issues = new Map<string, Signal>();
  let offset = 0;
  for (let pageNumber = 0; pageNumber < maxIssuePages; pageNumber++) {
    const page = await posthog(run, "query-error-tracking-issues-list", {
      dateRange: dateRange(start, end),
      status: "all",
      filterTestAccounts: true,
      filterGroup: [{ ...production, type: "event" }],
      orderBy: "last_seen",
      orderDirection: "ASC",
      limit: issuePageSize,
      offset,
      volumeResolution: 7,
    });
    const rows = list(page.results, context);
    if (
      rows.length > issuePageSize ||
      (page.hasMore !== undefined && typeof page.hasMore !== "boolean") ||
      (page.offset !== undefined && page.offset !== offset)
    ) {
      throw new Error(`${context} returned invalid pagination`);
    }
    const previousSize = issues.size;
    for (const value of rows) {
      const row = record(value, context);
      const rawId = identity(row.id, uuidPattern, context);
      const id = rawId.toLowerCase();
      const timestamp = observedAt(row.last_seen, context);
      const rawOccurrences =
        row.aggregations == null
          ? undefined
          : record(row.aggregations, context).occurrences;
      const occurrences =
        rawOccurrences === undefined
          ? undefined
          : count(rawOccurrences, context);
      const previous = issues.get(id);
      const legacyMarkers = [
        ...new Set([
          ...(previous?.legacyMarkers ?? []),
          `<!-- posthog-error-issue:${rawId} -->`,
          `<!-- posthog-error-issue:${id} -->`,
        ]),
      ].sort();
      if (previous && previous.observedAt >= timestamp) {
        issues.set(id, { ...previous, legacyMarkers });
        continue;
      }
      issues.set(id, {
        key: `posthog:error:${id}`,
        title: `[PostHog] Workspace browser exception ${id.slice(0, 8)}`,
        evidence: `PostHog Error Tracking issue UUID: ${id}.${occurrences === undefined ? "" : ` Production occurrences in the past seven days: ${occurrences}.`} [PostHog Error Tracking](${posthogProjectUrl}/error_tracking/${id})`,
        legacyMarkers,
        observedAt: timestamp,
        source: "posthog",
        priority: "normal",
      });
    }
    if (offset > 0 && rows.length > 0 && issues.size === previousSize) {
      throw new Error(`${context} repeated a page without new issues`);
    }

    // CLI versions that omit paging metadata still accept an explicit offset.
    if (page.hasMore === true || page.nextOffset != null) {
      if (
        page.hasMore === false ||
        rows.length === 0 ||
        page.nextOffset !== offset + rows.length
      ) {
        throw new Error(`${context} returned incomplete pagination`);
      }
    } else if (page.hasMore === false || rows.length < issuePageSize) {
      return [...issues.values()];
    }
    offset += rows.length;
  }
  throw new Error(`${context} exceeded its page limit`);
}

function compareSignals(left: Signal, right: Signal): number {
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
}

export async function collectPostHog(run: RunCommand): Promise<Signal[]> {
  const end = Date.now();
  const start = end - weekMs;
  const logs = await collectLogs(run, start, end);
  const issues = await collectErrorIssues(run, start, end);
  return [...logs, ...issues].sort(compareSignals);
}

export async function collectVercelFeedback(
  run: RunCommand,
  fetchScript: string,
  directory: string
): Promise<Signal[]> {
  const context = "Vercel feedback";
  const page = await readJson(run, "bash", [fetchScript, directory], context);
  const threads = list(page.threads, context);
  if (count(page.count, context) !== threads.length) {
    throw new Error(`${context} returned an incomplete thread list`);
  }

  const signals = new Map<string, Signal>();
  for (const value of threads) {
    const thread = record(value, context);
    const id = identity(thread.id, commentIdPattern, context);
    const timestamp = observedAt(thread.createdAt, context);
    const link =
      thread.link == null
        ? undefined
        : identity(thread.link, commentLinkPattern, "Vercel feedback link");
    const previous = signals.get(id);
    const previousLink = previous?.legacyMarkers[0];
    if (
      previous &&
      (previous.observedAt !== timestamp ||
        (link && previousLink && link !== previousLink))
    ) {
      throw new Error(`${context} returned conflicting rows for a thread`);
    }
    const threadLink = link ?? previousLink;
    signals.set(id, {
      commentId: id,
      key: `vercel:comment:${id}`,
      title: `[Vercel] Unresolved Toolbar comment ${id}`,
      evidence: `Vercel Toolbar thread ID: ${id}.${threadLink ? ` [Open comment](${threadLink})` : ""}`,
      legacyMarkers: threadLink ? [threadLink] : [],
      observedAt: timestamp,
      source: "vercel",
      priority: "normal",
    });
  }
  return [...signals.values()].sort(compareSignals);
}
