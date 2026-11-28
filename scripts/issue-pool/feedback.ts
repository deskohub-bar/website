const commentMarker =
  /(?:<!-- vercel-comment:([A-Za-z0-9_-]+) -->|Vercel Toolbar thread ID: ([A-Za-z0-9_-]+)(?=[.\s]|$))/g;
const vercelLink = /https:\/\/vercel\.com\/[^\s<>()]+/g;
const commentPath = /^\/(?:[A-Za-z0-9_-]+\/){1,4}c\/([A-Za-z0-9_-]+)\/?$/;

export function feedbackCommentIds(body: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const match of body.matchAll(commentMarker)) {
    const id = match[1] ?? match[2];
    if (id) ids.add(id);
  }
  for (const link of body.matchAll(vercelLink)) {
    const url = new URL(link[0].replace(/[.,;\]]+$/, ""));
    const id = url.pathname.match(commentPath)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}
