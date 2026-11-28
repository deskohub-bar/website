import { feedbackCommentIds } from "./feedback";
import { formatNightlyEvidence, nightlyRunMarker } from "./nightly-evidence";
import type { Issue, IssueTracker } from "./pool";

export type Command = (
  executable: string,
  args: readonly string[],
  input?: string
) => Promise<string>;

const deskohubRepository = "Deskohub/deskohub-site";
const deskohubRepositoryId = 1015951989;
const deskohubOrganizationId = 361691508;
const deskohubMaintainerId = 41711263; // totalolage
const repositorySlug = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

export function isGitHubRepositorySlug(value: string): boolean {
  return (
    repositorySlug.test(value) &&
    !/\/(?:\.|\.\.)$/.test(value) &&
    value.trim() === value
  );
}

function githubApi(run: Command, args: readonly string[], input?: string) {
  return run("gh", ["api", ...args, "--hostname", "github.com"], input);
}

export class GitHubIdentityError extends Error {}

export async function resolveIssuePoolGitHub(
  run: Command,
  reporterId = deskohubMaintainerId
) {
  const [repository, reporter] = await Promise.all([
    githubApi(run, [`repos/${deskohubRepository}`]),
    githubApi(run, ["user", "--jq", ".id"]),
  ]);
  const metadata: {
    id?: unknown;
    full_name?: unknown;
    owner?: { id?: unknown; type?: unknown } | null;
  } | null = JSON.parse(repository);
  const repo = metadata?.full_name;
  if (
    metadata?.id !== deskohubRepositoryId ||
    typeof repo !== "string" ||
    !isGitHubRepositorySlug(repo)
  ) {
    throw new GitHubIdentityError(
      "Unexpected GitHub issue pool repository identity"
    );
  }
  const owner = metadata.owner;
  if (owner?.type !== "Organization" || owner.id !== deskohubOrganizationId) {
    throw new GitHubIdentityError(
      "The GitHub issue pool repository must be owned by the Deskohub organization"
    );
  }
  if (reporter.trim() !== String(reporterId)) {
    throw new GitHubIdentityError(
      "The authenticated GitHub account does not match the configured issue pool reporter ID"
    );
  }
  return { repo, reporterId, maintainerId: deskohubMaintainerId };
}

interface RestIssue {
  number: number;
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  body: string | null;
  assignees: { login: string }[];
  labels: { name: string }[];
  user: { id: number } | null;
  pull_request?: object;
}

interface IssueComment {
  id: number;
  body: string | null;
  user: { id: number } | null;
}

const threadMarker = /<!-- t3-worker-thread:([a-zA-Z0-9:%_-]+) -->/;
const humanNeeded = "<!-- posthog-agent:human-needed -->";
const consumed = (commentId: number) =>
  `<!-- posthog-agent:consumed-comment:${commentId} -->`;

const issueFromRest = (issue: RestIssue): Issue => ({
  number: issue.number,
  state: issue.state,
  createdAt: issue.created_at,
  closedAt: issue.closed_at,
  body: issue.body ?? "",
  labels: issue.labels.map((label) => label.name),
  assignees: issue.assignees.map((assignee) => assignee.login),
});

interface IssueOwnership {
  repository: {
    issue: {
      state: "OPEN" | "CLOSED";
      body: string;
      author: { databaseId?: number | null } | null;
      assignees: { totalCount: number };
      closedByPullRequestsReferences: { nodes: { state: string }[] };
    } | null;
  } | null;
}

const ownershipQuery = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      body
      author { ... on User { databaseId } ... on Bot { databaseId } }
      assignees(first: 1) { totalCount }
      closedByPullRequestsReferences(first: 100) { nodes { state } }
    }
  }
}`;

export function githubIssueTracker({
  repo,
  run,
  reporterId,
  maintainerId,
  legacyFeedbackClaimed,
}: {
  repo: string;
  run: Command;
  reporterId: number;
  maintainerId: number;
  legacyFeedbackClaimed: (commentId: string) => boolean;
}): IssueTracker {
  const [owner = "", name = ""] = repo.split("/");
  const base = `repos/${repo}/issues`;
  const trusted = new Set([reporterId, maintainerId]);
  const trustedAuthor = (authorId: number | null | undefined) =>
    authorId != null && trusted.has(authorId);
  const getPages = async <T>(path: string): Promise<T[]> => {
    const response = await githubApi(run, ["--paginate", "--slurp", path]);
    const pages: T[][] = JSON.parse(response);
    return pages.flat();
  };
  const comments = new Map<number, Promise<IssueComment[]>>();
  function issueComments(
    number: number,
    fresh = false
  ): Promise<IssueComment[]> {
    let cached = fresh ? undefined : comments.get(number);
    if (!cached) {
      cached = getPages<IssueComment>(
        `${base}/${number}/comments?per_page=100`
      ).then((rows) =>
        rows
          .filter(({ user }) => trustedAuthor(user?.id))
          .sort((left, right) => left.id - right.id)
      );
      comments.set(number, cached);
    }
    return cached;
  }
  const workerRecorded = async (number: number) =>
    (await issueComments(number, true)).some(({ body }) =>
      threadMarker.test(body ?? "")
    );
  async function postComment(number: number, body: string): Promise<void> {
    await githubApi(
      run,
      ["--method", "POST", `${base}/${number}/comments`, "--input", "-"],
      JSON.stringify({ body })
    );
    comments.delete(number);
  }
  async function readOwnership(number: number) {
    const response = await githubApi(run, [
      "graphql",
      "-f",
      `query=${ownershipQuery}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]);
    const { data }: { data: IssueOwnership } = JSON.parse(response);
    return data.repository?.issue;
  }
  return {
    async list() {
      const issues = await getPages<RestIssue>(
        `${base}?state=all&per_page=100`
      );
      return issues
        .filter((issue) => !issue.pull_request && trustedAuthor(issue.user?.id))
        .map(issueFromRest);
    },
    async file(title, body) {
      const response = await githubApi(
        run,
        ["--method", "POST", base, "--input", "-"],
        JSON.stringify({ title, body })
      );
      const issue: RestIssue = JSON.parse(response);
      if (issue.user?.id !== reporterId) {
        throw new Error("Created issue did not have the authenticated author");
      }
      const created = issueFromRest(issue);
      if (created.body !== body) {
        throw new Error("Created issue did not retain the pool source marker");
      }
      return created;
    },
    async hasOwner(number) {
      const issue = await readOwnership(number);
      return (
        issue?.state !== "OPEN" ||
        !trustedAuthor(issue.author?.databaseId) ||
        issue.assignees.totalCount > 0 ||
        issue.closedByPullRequestsReferences.nodes.some(
          (pr) => pr.state === "OPEN"
        ) ||
        (await workerRecorded(number)) ||
        Array.from(feedbackCommentIds(issue.body)).some(legacyFeedbackClaimed)
      );
    },
    async recordWorker(number, threadId) {
      if (!/^[a-zA-Z0-9:%_-]+$/.test(threadId)) {
        throw new Error("Unexpected T3 thread identifier");
      }
      const issue = await readOwnership(number);
      if (issue?.state !== "OPEN" || !trustedAuthor(issue.author?.databaseId))
        return;
      if (await workerRecorded(number)) {
        return;
      }
      await postComment(
        number,
        `Assigned to T3 worker \`${threadId}\`.\n\n<!-- t3-worker-thread:${threadId} -->`
      );
    },
    legacyFeedbackClaimed,
    async hasClosedWork(number) {
      const issue = await readOwnership(number);
      return (
        issue?.state === "CLOSED" &&
        trustedAuthor(issue.author?.databaseId) &&
        (issue.closedByPullRequestsReferences.nodes.some(
          (pr) => pr.state === "MERGED"
        ) ||
          (await workerRecorded(number)))
      );
    },
    async recordNightlyRuns(issue, runUrls) {
      const known = [
        issue.body,
        ...(await issueComments(issue.number, true)).map(
          ({ body }) => body ?? ""
        ),
      ];
      const newRuns = runUrls.filter(
        (url) => !known.some((body) => body.includes(nightlyRunMarker(url)))
      );
      if (newRuns.length === 0) return;
      const current = await readOwnership(issue.number);
      if (
        current?.state === "OPEN" &&
        trustedAuthor(current.author?.databaseId)
      ) {
        await postComment(issue.number, formatNightlyEvidence(newRuns));
      }
    },
    async suppressesRecurrence(number) {
      return (await issueComments(number)).some(({ body }) =>
        body?.includes("<!-- posthog-agent:triage-non-actionable -->")
      );
    },
    async pendingReply(number) {
      const rows = await issueComments(number);
      const question = rows.findLast(({ body }) => body?.includes(humanNeeded));
      const worker = rows.findLast(({ body }) => threadMarker.test(body ?? ""));
      const threadId = worker?.body?.match(threadMarker)?.[1];
      if (!question || !threadId) return null;
      const reply = rows.find(
        ({ id, body, user }) =>
          id > question.id &&
          user?.id === maintainerId &&
          body?.trim() &&
          !/<!-- (?:posthog-agent:|t3-worker-thread:|issue-pool-)/.test(body) &&
          !rows.some(({ body: comment }) => comment?.includes(consumed(id)))
      );
      if (!reply?.body) return null;
      const issue = await readOwnership(number);
      if (issue?.state !== "OPEN" || !trustedAuthor(issue.author?.databaseId))
        return null;
      return { commentId: reply.id, threadId, message: reply.body };
    },
    async recordReply(number, commentId) {
      if (
        !(await issueComments(number)).some(({ body }) =>
          body?.includes(consumed(commentId))
        )
      ) {
        await postComment(number, consumed(commentId));
      }
    },
  };
}
