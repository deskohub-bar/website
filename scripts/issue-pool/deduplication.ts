import { feedbackCommentIds } from "./feedback";
import type { Issue } from "./pool";

const issueMarkers =
  /<!-- (issue-pool-source:[0-9a-f]{64}|issue-pool-fix:[a-z0-9-]+|posthog-(?:log-uuid|error-issue|error-event):[^<>]+) -->/g;

export function groupIssues(
  issues: readonly Issue[],
  sourceGroups: Iterable<ReadonlySet<number>>
): Issue[][] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const groups = new Map<string, Set<number>>();
  for (const issue of byNumber.values()) {
    const keys = [
      ...Array.from(issue.body.matchAll(issueMarkers), (match) => match[0]),
      ...Array.from(feedbackCommentIds(issue.body), (id) => `vercel:${id}`),
    ];
    for (const key of keys) {
      let members = groups.get(key);
      if (!members) {
        members = new Set();
        groups.set(key, members);
      }
      members.add(issue.number);
    }
  }

  const neighbors = new Map(
    Array.from(byNumber.keys(), (number) => [number, new Set<number>()])
  );
  for (const members of [...groups.values(), ...sourceGroups]) {
    const [first, ...rest] = Array.from(members).filter((number) =>
      byNumber.has(number)
    );
    if (first === undefined) continue;
    for (const number of rest) {
      neighbors.get(first)?.add(number);
      neighbors.get(number)?.add(first);
    }
  }

  const seen = new Set<number>();
  const result: Issue[][] = [];
  for (const first of byNumber.keys()) {
    if (seen.has(first)) continue;
    const members = new Set([first]);
    for (const number of members) {
      seen.add(number);
      for (const neighbor of neighbors.get(number) ?? []) members.add(neighbor);
    }
    result.push(
      Array.from(members, (number) => byNumber.get(number))
        .filter((issue) => issue !== undefined)
        .sort((left, right) => left.number - right.number)
    );
  }
  return result;
}
