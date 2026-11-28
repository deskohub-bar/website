import { expect, test } from "bun:test";
import { testEmailAddress } from "../../packages/test-email/src/test-email-address";
import {
  collectPostHog,
  collectVercelFeedback,
  type RunCommand,
} from "./sources";

const timestamp = "2026-11-20T14:30:01.123456Z";
const normalizedTimestamp = "2026-11-20T14:30:01.123Z";
const privateText = "private-customer-payload-canary";
const fetchScript = "/fixtures/fetch-comments.sh";
const workspaceDirectory = "apps/deskohub-workspace";

function uuid(index: number) {
  return `abcdef00-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function log(index: number, fields = {}) {
  return {
    uuid: uuid(index),
    timestamp,
    severity_text: "error",
    body: "Workspace checkout failed",
    ...fields,
  };
}

function errorIssue(index: number, fields = {}) {
  return {
    id: uuid(index),
    last_seen: timestamp,
    name: privateText,
    description: privateText,
    aggregations: { occurrences: 3 },
    ...fields,
  };
}

type Input = {
  offset?: number;
  query?: { dateRange: { date_from: string; date_to: string } };
};
type Responses = Record<string, (input: Input) => unknown>;

function posthogFixture(responses: Partial<Responses> = {}): RunCommand {
  const defaults: Responses = {
    "logs-count": () => ({ count: 0 }),
    "query-error-tracking-issues-list": () => ({ results: [], hasMore: false }),
  };

  return async (command, args) => {
    expect(command).toBe("posthog-cli");
    expect(args.slice(0, 3)).toEqual(["api", "call", "--json"]);
    const [, , , tool, input] = args;
    const handler = tool && (responses[tool] ?? defaults[tool]);
    if (!handler || input === undefined) throw new Error("Unexpected command");
    return JSON.stringify(handler(JSON.parse(input)));
  };
}

function logsFixture(rows: readonly unknown[]) {
  return posthogFixture({
    "logs-count": () => ({ count: rows.length }),
    "query-logs": () => ({ results: rows }),
  });
}

function vercelFixture(
  threads: readonly unknown[],
  count = threads.length
): RunCommand {
  return async (command, args) => {
    expect(command).toBe("bash");
    expect(args).toEqual([fetchScript, workspaceDirectory]);
    return JSON.stringify({ projects: [], count, threads });
  };
}

test("groups recurrent logs by template and operation while keeping occurrence aliases", async () => {
  const firstEmail = testEmailAddress("first");
  const secondEmail = testEmailAddress("second");
  const first = log(1, {
    uuid: uuid(1).toUpperCase(),
    body: `Checkout rejected for ${firstEmail} at https://example.test/secret. access_code=${privateText}`,
    attributes: {
      operation: "checkout.reserve",
      fiberId: "#1",
      payload: privateText,
    },
  });
  const second = log(2, {
    timestamp: "2026-11-20T16:30:02+02:00",
    severity_text: "fatal",
    body: JSON.stringify([
      `Checkout rejected for ${secondEmail} at https://other.test/other. access_code=rotated`,
      { authorization: privateText },
    ]),
    attributes: { operation: "checkout.reserve", fiberId: "#2" },
  });

  const signals = await collectPostHog(
    logsFixture([
      first,
      second,
      log(3, { body: first.body, attributes: { operation: "checkout.pay" } }),
      log(4, {
        body: "Checkout timed out",
        attributes: { operation: "checkout.reserve" },
      }),
    ])
  );
  const grouped = signals.find((signal) => signal.priority === "high");
  expect(signals).toHaveLength(3);
  expect(grouped).toMatchObject({
    source: "posthog",
    priority: "high",
    legacyMarkers: [
      `<!-- posthog-log-uuid:${uuid(1).toUpperCase()} -->`,
      `<!-- posthog-log-uuid:${uuid(1)} -->`,
      `<!-- posthog-log-uuid:${uuid(2)} -->`,
    ],
    observedAt: "2026-11-20T14:30:02.000Z",
  });
  expect(grouped?.key).toMatch(/^posthog:log:[0-9a-f]{64}$/);
  expect(grouped?.evidence).toContain("past seven days: 2");
  expect(grouped?.evidence).toContain(uuid(2));
  const evidence = JSON.stringify(signals);
  expect(evidence).not.toContain(firstEmail);
  expect(evidence).not.toContain(secondEmail);
  expect(evidence).not.toMatch(
    /example\.test|other\.test|private-customer|rotated|checkout\.reserve/
  );

  const recurrence = await collectPostHog(
    logsFixture([{ ...second, uuid: uuid(5) }])
  );
  expect(recurrence[0]?.key).toBe(grouped?.key);
});

test("counts and splits a production log window before fetching every row", async () => {
  type Range = NonNullable<Input["query"]>["dateRange"];
  const counted: Range[] = [];
  const fetched: Range[] = [];
  const run = posthogFixture({
    "logs-count": (input) => {
      const { query } = input;
      if (!query) throw new Error("Missing fixture date range");
      expect(query).toMatchObject({
        severityLevels: ["error", "fatal"],
        serviceNames: ["deskohub-workspace"],
        filterGroup: [
          {
            key: "deployment.environment.name",
            type: "log_resource_attribute",
            operator: "exact",
            value: "production",
          },
        ],
      });
      counted.push(query.dateRange);
      if (counted.length === 1) return { count: 1001 };
      return { count: counted.length === 2 ? 501 : 500 };
    },
    "query-logs": (input) => {
      const { query } = input;
      if (!query) throw new Error("Missing fixture date range");
      expect(query).toMatchObject({ orderBy: "earliest", limit: 1000 });
      fetched.push(query.dateRange);
      return {
        results:
          fetched.length === 1
            ? Array.from({ length: 501 }, (_, index) => log(index))
            : Array.from({ length: 500 }, (_, index) => log(index + 500)),
      };
    },
  });

  const [signal] = await collectPostHog(run);
  expect(counted).toHaveLength(3);
  const [week, left, right] = counted;
  if (!week || !left || !right)
    throw new Error("Expected three counted windows");
  expect(Date.parse(week.date_to) - Date.parse(week.date_from)).toBe(
    7 * 24 * 60 * 60 * 1000
  );
  expect(left.date_from).toBe(week.date_from);
  expect(left.date_to).toBe(right.date_from);
  expect(right.date_to).toBe(week.date_to);
  expect(fetched).toEqual([left, right]);
  expect(signal?.legacyMarkers).toHaveLength(1000);
  expect(signal?.evidence).toContain("past seven days: 1000");
});

test.each([true, false])(
  "collects all Error Tracking pages with metadata present %s",
  async (metadata) => {
    const offsets: number[] = [];
    const run = posthogFixture({
      "query-error-tracking-issues-list": (input) => {
        expect(input).toMatchObject({
          status: "all",
          filterTestAccounts: true,
          filterGroup: [
            {
              key: "deployment.environment.name",
              type: "event",
              operator: "exact",
              value: "production",
            },
          ],
          limit: 100,
        });
        offsets.push(input.offset ?? -1);
        if (input.offset === 0) {
          return {
            results: Array.from({ length: 100 }, (_, index) =>
              errorIssue(index, { id: uuid(index).toUpperCase() })
            ),
            ...(metadata ? { hasMore: true, nextOffset: 100 } : {}),
          };
        }
        return {
          results: [
            errorIssue(99, { last_seen: "2026-11-20T14:30:04Z" }),
            errorIssue(100),
          ],
          ...(metadata ? { hasMore: false } : {}),
        };
      },
    });

    const signals = await collectPostHog(run);
    expect(offsets).toEqual([0, 100]);
    expect(signals).toHaveLength(101);
    expect(signals[0]).toMatchObject({
      key: `posthog:error:${uuid(0)}`,
      observedAt: normalizedTimestamp,
      priority: "normal",
      legacyMarkers: [
        `<!-- posthog-error-issue:${uuid(0).toUpperCase()} -->`,
        `<!-- posthog-error-issue:${uuid(0)} -->`,
      ],
    });
    expect(signals[100]?.evidence).toContain("past seven days: 3");
    expect(signals[99]?.observedAt).toBe("2026-11-20T14:30:04.000Z");
    expect(JSON.stringify(signals)).not.toContain(privateText);
  }
);

test("rejects incomplete log windows and repeated occurrences", async () => {
  const truncated = posthogFixture({
    "logs-count": () => ({ count: 2 }),
    "query-logs": () => ({ results: [log(1)] }),
  });
  await expect(collectPostHog(truncated)).rejects.toThrow(
    "incomplete log window"
  );
  await expect(collectPostHog(logsFixture([log(1), log(1)]))).rejects.toThrow(
    "repeated a log occurrence"
  );
});

test("keeps log and Error Tracking signals separate for the same UUID", async () => {
  const run = posthogFixture({
    "logs-count": () => ({ count: 1 }),
    "query-logs": () => ({ results: [log(1)] }),
    "query-error-tracking-issues-list": () => ({ results: [errorIssue(1)] }),
  });
  const signals = await collectPostHog(run);
  expect(signals.map(({ legacyMarkers }) => legacyMarkers)).toEqual([
    [`<!-- posthog-error-issue:${uuid(1)} -->`],
    [`<!-- posthog-log-uuid:${uuid(1)} -->`],
  ]);
});

test("rejects an incomplete or stuck Error Tracking page", async () => {
  const missingOffset = posthogFixture({
    "query-error-tracking-issues-list": () => ({
      results: [errorIssue(1)],
      hasMore: true,
    }),
  });
  await expect(collectPostHog(missingOffset)).rejects.toThrow(
    "incomplete pagination"
  );

  const repeatsResults = posthogFixture({
    "query-error-tracking-issues-list": () => ({
      results: Array.from({ length: 100 }, (_, index) => errorIssue(index)),
    }),
  });
  await expect(collectPostHog(repeatsResults)).rejects.toThrow(
    "repeated a page"
  );
});

test("rejects malformed IDs, timestamps, JSON, and commands without reproducing provider text", async () => {
  await expect(
    collectPostHog(logsFixture([log(1, { uuid: privateText })]))
  ).rejects.toThrow("invalid identifier");
  await expect(
    collectPostHog(logsFixture([log(1, { timestamp: "2026-02-30T14:30:00Z" })]))
  ).rejects.toThrow("invalid timestamp");
  await expect(collectPostHog(async () => privateText)).rejects.toThrow(
    /^PostHog logs-count returned invalid JSON$/
  );
  await expect(
    collectPostHog(async () => {
      throw new Error(privateText);
    })
  ).rejects.toThrow(/^PostHog logs-count command failed$/);
});

test("normalizes Vercel thread metadata without exposing feedback or deployment URLs", async () => {
  const id = "-Abc123";
  const link = `https://vercel.com/team/project/c/${id}`;
  const signals = await collectVercelFeedback(
    vercelFixture([
      { id, createdAt: timestamp, link: null, author: privateText },
      {
        id,
        createdAt: normalizedTimestamp,
        link,
        text: privateText,
        replies: [{ text: privateText }],
        pageUrl: `https://example.test/${privateText}`,
      },
      { id: "-abc123", createdAt: timestamp, link: null },
    ]),
    fetchScript,
    workspaceDirectory
  );

  expect(signals).toHaveLength(2);
  expect(signals[0]).toMatchObject({
    key: `vercel:comment:${id}`,
    observedAt: normalizedTimestamp,
    legacyMarkers: [link],
    source: "vercel",
    priority: "normal",
  });
  expect(signals[0]?.evidence).toContain(link);
  expect(signals[1]?.legacyMarkers).toEqual([]);
  expect(JSON.stringify(signals)).not.toMatch(/private-customer|example\.test/);
});

test.each([
  "http://vercel.com/team/c/abc",
  "https://vercel.com.evil.test/team/c/abc",
  "https://vercel.com@evil.test/team/c/abc",
  "https://vercel.com/team/c/abc?token=secret",
  "https://vercel.com/team/c/%61bc",
])("rejects a Vercel permalink outside the allowlist %s", async (link) => {
  const run = vercelFixture([{ id: "abc", createdAt: timestamp, link }]);
  await expect(
    collectVercelFeedback(run, fetchScript, workspaceDirectory)
  ).rejects.toThrow("Vercel feedback link returned an invalid identifier");
});

test("rejects an incomplete Vercel thread list and missing thread timestamps", async () => {
  await expect(
    collectVercelFeedback(vercelFixture([], 1), fetchScript, workspaceDirectory)
  ).rejects.toThrow("incomplete thread list");
  await expect(
    collectVercelFeedback(
      vercelFixture([{ id: "abc" }]),
      fetchScript,
      workspaceDirectory
    )
  ).rejects.toThrow("invalid timestamp");
});
