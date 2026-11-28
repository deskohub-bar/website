export const nightlyRunMarker = (url: string) =>
  `<!-- issue-pool-nightly-run:${url} -->`;

export function formatNightlyEvidence(urls: readonly string[]): string {
  if (urls.length === 0) {
    return "";
  }
  return [
    "Nightly E2E runs with this failure",
    "",
    ...Array.from(new Set(urls), (url) => `- ${url}\n${nightlyRunMarker(url)}`),
  ].join("\n");
}
