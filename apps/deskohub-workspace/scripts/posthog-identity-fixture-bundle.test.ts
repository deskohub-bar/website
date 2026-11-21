import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildPosthogIdentityFixtureBundle } from "./posthog-identity-fixture-bundle";

// CI never runs the PostHog identity browser check, so this builds its fixture
// with the shared bundler setup and initializes it without `process`, failing
// when an import change leaks a module that reads server-only globals at load.
const outdir = mkdtempSync(join(tmpdir(), "posthog-identity-fixture-"));

afterAll(() => rmSync(outdir, { force: true, recursive: true }));

// Web-standard APIs a browser also provides, borrowed from the runtime.
const webStandardGlobals = [
  "AbortController",
  "AbortSignal",
  "BroadcastChannel",
  "Blob",
  "CustomEvent",
  "DOMException",
  "Event",
  "EventTarget",
  "FormData",
  "Headers",
  "MessageChannel",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WritableStream",
  "atob",
  "btoa",
  "clearInterval",
  "clearTimeout",
  "console",
  "crypto",
  "performance",
  "queueMicrotask",
  "setInterval",
  "setTimeout",
  "structuredClone",
] as const;

/** Globals a browser offers at module init; deliberately no `process`. */
const browserLikeGlobals = () => {
  const events = new EventTarget();
  const context = {
    ...Object.fromEntries(
      webStandardGlobals.map((name) => [name, globalThis[name]])
    ),
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    fetch: () => Promise.reject(new Error("no network in the bundle guard")),
    navigator: { language: "en-US", userAgent: "bundle-guard" },
    removeEventListener: events.removeEventListener.bind(events),
  };
  return Object.assign(context, {
    globalThis: context,
    self: context,
    window: context,
  });
};

test("builds and initializes the browser fixture without process or a DOM", async () => {
  const build = await buildPosthogIdentityFixtureBundle(
    "https://telemetry.posthog.test",
    outdir
  );
  expect(build.success).toBe(true);
  const output = build.outputs.find((candidate) =>
    candidate.path.endsWith(".js")
  );
  if (!output) throw new Error("Missing PostHog fixture JavaScript bundle");

  // The bundle ends with an ESM export list; the rest is a classic script.
  const script = (await Bun.file(output.path).text()).replace(
    /\nexport \{[^}]*\};?\s*$/,
    "\n"
  );
  expect(script.trim()).not.toBe("");
  expect(() =>
    runInNewContext(script, browserLikeGlobals(), {
      filename: "posthog-identity-browser-fixture.js",
    })
  ).not.toThrow();
}, 60_000);
