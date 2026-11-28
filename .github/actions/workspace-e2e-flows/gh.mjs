import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs `gh` capturing stdout and stderr through temporary files so responses
 * larger than Node's default 1 MiB `execFileSync` buffer never fail with
 * `ENOBUFS`.
 */
export const runGhCapture = (args) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-e2e-gh-"));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  let outFd = openSync(stdoutPath, "w");
  let errFd = openSync(stderrPath, "w");
  try {
    const result = spawnSync("gh", args, {
      stdio: ["ignore", outFd, errFd],
    });
    closeSync(outFd);
    outFd = -1;
    closeSync(errFd);
    errFd = -1;
    if (result.error) {
      return { ok: false, stdout: "", stderr: String(result.error) };
    }
    return {
      ok: result.status === 0,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    };
  } finally {
    if (outFd >= 0) closeSync(outFd);
    if (errFd >= 0) closeSync(errFd);
    rmSync(dir, { force: true, recursive: true });
  }
};

const parseHttpHeaderAndBody = (raw) => {
  const text = String(raw ?? "");
  if (!/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(text)) {
    return { hasHeaders: false, headersText: "", bodyText: text };
  }
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) {
    return { hasHeaders: true, headersText: text, bodyText: "" };
  }
  return {
    hasHeaders: true,
    headersText: text.slice(0, match.index),
    bodyText: text.slice(match.index + match[0].length),
  };
};

const parseNextLink = (headersText) => {
  for (const line of headersText.split(/\r?\n/)) {
    const match = /^link:\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    for (const part of match[1].split(",")) {
      const linkMatch = /^<([^>]+)>(.*)$/.exec(part.trim());
      if (linkMatch && /;\s*rel="next"(?:;|$)/i.test(linkMatch[2])) {
        return linkMatch[1];
      }
    }
  }
  return "";
};

/**
 * Fetches a paginated GitHub REST API JSON array one page at a time via
 * `gh api -i` without subprocess buffer caps. Each completed page is parsed
 * and accumulated independently so a failed or truncated later page (for
 * example HTTP 502) never corrupts or discards items verified from earlier
 * pages.
 */
export const fetchPaginatedJson = (endpoint, extraArgs = []) => {
  const items = [];
  const seenUrls = new Set();
  let page = 1;
  let nextUrl = "";

  while (true) {
    const args = nextUrl
      ? [
          "api",
          "--method",
          "GET",
          "-i",
          "-H",
          "Accept: application/vnd.github+json",
          nextUrl,
        ]
      : [
          "api",
          "--method",
          "GET",
          "-i",
          "-H",
          "Accept: application/vnd.github+json",
          endpoint,
          ...extraArgs,
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ];

    const res = runGhCapture(args);
    if (!res.ok) {
      return { ok: false, items };
    }

    const initial = parseHttpHeaderAndBody(res.stdout);
    let effectiveHeaders = initial.headersText;
    let effectiveBody = initial.bodyText;
    while (
      initial.hasHeaders &&
      /^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(effectiveBody)
    ) {
      const nested = parseHttpHeaderAndBody(effectiveBody);
      effectiveHeaders = nested.headersText;
      effectiveBody = nested.bodyText;
    }

    let parsed;
    try {
      parsed = JSON.parse(effectiveBody);
    } catch {
      return { ok: false, items };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, items };
    }
    items.push(...parsed);

    if (initial.hasHeaders) {
      const linkNext = parseNextLink(effectiveHeaders);
      if (!linkNext) {
        return { ok: true, items };
      }
      if (seenUrls.has(linkNext)) {
        return { ok: false, items };
      }
      seenUrls.add(linkNext);
      nextUrl = linkNext;
      page += 1;
      continue;
    }

    if (parsed.length < 100) {
      return { ok: true, items };
    }
    page += 1;
  }
};
