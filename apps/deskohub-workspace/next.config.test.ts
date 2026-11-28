import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportedLocales } from "@deskohub/i18n/locale-registry";
import {
  getRewrittenUrl,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import nextConfig from "./next.config.mjs";
import packageJson from "./package.json" with { type: "json" };

const resolveHeaders = async (path: string) =>
  (
    await unstable_getResponseFromNextConfig({
      url: `https://workspace.example${path}`,
      nextConfig,
    })
  ).headers;

const resolveReferrerPolicy = async (path: string) =>
  (await resolveHeaders(path)).get("referrer-policy");

test("redirects the prices alias to the canonical price list with locale and query intact", async () => {
  for (const prefix of ["", "/cs-CZ", "/en-US"]) {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://workspace.example${prefix}/prices?source=booking`,
      nextConfig,
    });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `https://workspace.example${prefix}/pricing?source=booking`
    );
  }
});

const originTrialTokensBefore = process.env.WEBMCP_ORIGIN_TRIAL_TOKENS;

afterEach(() => {
  if (originTrialTokensBefore === undefined) {
    delete process.env.WEBMCP_ORIGIN_TRIAL_TOKENS;
  } else {
    process.env.WEBMCP_ORIGIN_TRIAL_TOKENS = originTrialTokensBefore;
  }
});

test("sends no referrer from every page, including the localized landing pages", async () => {
  for (const path of [
    "/",
    "/en-US",
    "/cs-CZ",
    "/en-US/reservation/cowork",
    "/cs-CZ/pricing",
    "/workspace-location-map.jpeg",
  ]) {
    expect(await resolveReferrerPolicy(path)).toBe("no-referrer");
  }
});

test("enrolls pages in the WebMCP origin trial with every configured token", async () => {
  process.env.WEBMCP_ORIGIN_TRIAL_TOKENS = " chrome-token , edge-token ,";

  for (const path of ["/", "/en-US", "/cs-CZ/reservation/cowork"]) {
    expect((await resolveHeaders(path)).get("origin-trial")).toBe(
      "chrome-token, edge-token"
    );
  }
  for (const path of ["/api/mcp", "/_next/static/chunks/main.js"]) {
    const headers = await resolveHeaders(path);
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.has("origin-trial")).toBe(false);
  }
});

test("sends no Origin-Trial header without configured tokens", async () => {
  for (const tokens of [undefined, "", " , "]) {
    if (tokens === undefined) {
      delete process.env.WEBMCP_ORIGIN_TRIAL_TOKENS;
    } else {
      process.env.WEBMCP_ORIGIN_TRIAL_TOKENS = tokens;
    }

    expect((await resolveHeaders("/en-US")).has("origin-trial")).toBe(false);
  }
});

const resolveRewrite = async (path: string) =>
  getRewrittenUrl(
    await unstable_getResponseFromNextConfig({
      url: `https://workspace.example${path}`,
      nextConfig,
    })
  );

test("sends an unmatched dotted path outside the locales to the locale redirect", async () => {
  for (const path of [
    "/nope.html",
    "/a/b.php",
    "/.well-known/unknown.json",
    "/en/nope.html",
    "/en-US.html",
    "/cs-CZ.example/a.php",
    "/fr-fr/x.html",
    "/xx-YY/a.txt",
  ]) {
    expect(await resolveRewrite(path)).toBe(
      `https://workspace.example/locale-redirect${path}`
    );
  }
});

test("leaves locale, API, build asset, APK download and undotted paths to their routes", async () => {
  for (const path of [
    "/cs-CZ/nope.html",
    "/en-US/a/b.php",
    "/en-US.rsc",
    "/cs-CZ.prefetch.rsc",
    "/en-US.segments/_tree.segment.rsc",
    "/api/v1/cli/file.json",
    "/_next/static/chunks/main.js",
    "/_vercel/insights/script.js",
    "/page-markdown/cs-CZ/faq.md",
    "/workspace-location-map/wide.webp",
    "/android/download/deskohub-1.2.3.apk",
    "/nope",
  ]) {
    expect(await resolveRewrite(path)).toBeNull();
  }
});

test("loads the mobile web app for every undotted path under /app/", async () => {
  for (const path of [
    "/app/",
    "/app/account",
    "/app/account/",
    "/app/account/security",
  ]) {
    expect(await resolveRewrite(path)).toBe(
      "https://workspace.example/app/index.html"
    );
  }
  expect(await resolveRewrite("/application")).toBeNull();
});

test("keeps the mobile web app out of search results without blocking crawlers", async () => {
  for (const path of ["/app", "/app/", "/app/account", "/app/sw.js"]) {
    expect((await resolveHeaders(path)).get("x-robots-tag")).toBe("noindex");
  }
  for (const path of ["/", "/cs-CZ", "/application"]) {
    expect((await resolveHeaders(path)).has("x-robots-tag")).toBe(false);
  }
});

const resolveRedirect = async (path: string) => {
  const response = await unstable_getResponseFromNextConfig({
    url: `https://workspace.example${path}`,
    nextConfig,
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
};

test("routes every supported locale's dotted paths and reservation link", async () => {
  for (const locale of supportedLocales) {
    expect(await resolveRewrite(`/${locale}/nope.html`)).toBeNull();
    expect(
      (await resolveRedirect(`/${locale}/reservation`)).location
    ).toStartWith(`https://workspace.example/${locale}/reservation/cowork?`);
  }
});

test("drops a trailing slash everywhere except inside the installed app's scope", async () => {
  for (const [path, location] of [
    ["/cs-CZ/faq/", "/cs-CZ/faq"],
    ["/en-US/", "/en-US"],
    ["/apple/", "/apple"],
    ["/application/", "/application"],
  ]) {
    expect(await resolveRedirect(path)).toEqual({
      status: 308,
      location: `https://workspace.example${location}`,
    });
  }
  for (const path of ["/app/", "/app/account/", "/"]) {
    expect((await resolveRedirect(path)).location).toBeNull();
  }
});

test("fails a production compile without the mobile web export", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "next-config-"));
  try {
    await expect(
      Promise.resolve(
        nextConfig.compiler?.runAfterProductionCompile?.({
          projectDir,
          distDir: join(projectDir, ".next"),
        })
      )
    ).rejects.toThrow(/mobile-web-app:build/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("compiles React components natively inside Turbopack", () => {
  expect(nextConfig.reactCompiler).toBe(true);
  expect(nextConfig.experimental?.turbopackRustReactCompiler).toBe(true);
});

test("keeps Turbopack's build cache out of Vercel's build cache", () => {
  expect(nextConfig.experimental?.turbopackFileSystemCacheForBuild).toBe(false);
  // Next keeps a copy restored from an older Vercel build cache, which would
  // be uploaded again.
  expect(packageJson.scripts["build:compile"]).toStartWith(
    "rm -rf .next/cache/turbopack && "
  );
});

test("emits the standalone server only for a container image build", async () => {
  // Vercel and CI builds leave the output to Next's default.
  expect(nextConfig.output).toBeUndefined();

  const buildTargetBefore = process.env.WORKSPACE_BUILD_TARGET;
  process.env.WORKSPACE_BUILD_TARGET = "oci";
  try {
    const { default: containerConfig } = await import(
      "./next.config.mjs?build-target=oci"
    );
    expect(containerConfig.output).toBe("standalone");
  } finally {
    if (buildTargetBefore === undefined) {
      delete process.env.WORKSPACE_BUILD_TARGET;
    } else {
      process.env.WORKSPACE_BUILD_TARGET = buildTargetBefore;
    }
  }
});

const importConfigWith = async (
  variables: Readonly<Record<string, string | undefined>>,
  cacheKey: string
) => {
  const before = Object.fromEntries(
    Object.keys(variables).map((name) => [name, process.env[name]])
  );
  const assign = (values: Readonly<Record<string, string | undefined>>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(variables);
  try {
    const { default: config }: { readonly default: typeof nextConfig } =
      await import(`./next.config.mjs?stage=${cacheKey}`);
    return config;
  } finally {
    assign(before);
  }
};

test("gates browser source maps and the testing API by the Workspace stage before Vercel's", async () => {
  const containerProduction = await importConfigWith(
    { WORKSPACE_DEPLOYMENT_STAGE: "production", VERCEL_ENV: undefined },
    "container-production"
  );
  expect(containerProduction.productionBrowserSourceMaps).toBe(true);

  const containerPreview = await importConfigWith(
    { WORKSPACE_DEPLOYMENT_STAGE: "preview", VERCEL_ENV: "production" },
    "container-preview"
  );
  expect(containerPreview.productionBrowserSourceMaps).toBe(false);
  expect(containerPreview.experimental?.exposeTestingApiInProductionBuild).toBe(
    true
  );

  const vercelProduction = await importConfigWith(
    { WORKSPACE_DEPLOYMENT_STAGE: undefined, VERCEL_ENV: "production" },
    "vercel-production"
  );
  expect(vercelProduction.productionBrowserSourceMaps).toBe(true);
});

test("hands a host's Workspace stage to the browser bundle and leaves Vercel's alone", async () => {
  const container = await importConfigWith(
    { WORKSPACE_DEPLOYMENT_STAGE: "production" },
    "container-browser-stage"
  );
  expect(container.env).toEqual({
    NEXT_PUBLIC_WORKSPACE_DEPLOYMENT_STAGE: "production",
  });

  const vercel = await importConfigWith(
    { WORKSPACE_DEPLOYMENT_STAGE: undefined, VERCEL_ENV: "production" },
    "vercel-browser-stage"
  );
  expect(vercel.env).toBeUndefined();
});
