import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dev } from "astro";

let server: Awaited<ReturnType<typeof dev>>;
let origin: string;
const testEnv = {
  ASTRO_DISABLE_UPDATE_CHECK: "true",
  ASTRO_TELEMETRY_DISABLED: "1",
  VERCEL_ENV: "preview",
};
const originalEnv = Object.entries(testEnv).map(
  ([name]) => [name, process.env[name]] as const
);

beforeAll(async () => {
  Object.assign(process.env, testEnv);
  server = await dev({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  origin = `http://127.0.0.1:${server.address.port}`;
}, 30_000);

afterAll(async () => {
  try {
    await server?.stop();
  } finally {
    for (const [name, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test.each(["/de-DE/", "/nonexistent"])(
  "returns 404 for an unsupported locale at %s",
  async (path) => {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${origin}${path}`, {
        method,
        redirect: "manual",
      });
      expect(response.status).toBe(404);
      const body = await response.text();
      if (method === "HEAD") {
        expect(body).toBe("");
      } else {
        expect(body).not.toContain("portal-panel");
      }
    }
  }
);

test.each([
  ["/cs-CZ/", "TRVALE ZAVŘENO"],
  ["/en-US/", "OUT OF BUSINESS"],
])("renders both Bar states at %s", async (path, stamp) => {
  const open = await fetch(`${origin}${path}?asOf=2026-11-30T22:59:59.999Z`);
  const closed = await fetch(`${origin}${path}?asOf=2026-11-30T23:00:00Z`);
  expect(open.status).toBe(200);
  expect(closed.status).toBe(200);
  expect(open.headers.get("cache-control")).toBe("private, no-store");
  expect(closed.headers.get("cache-control")).toBe("private, no-store");

  const openHtml = await open.text();
  expect(openHtml).toContain('href="https://bar.deskohub.cz"');
  expect(openHtml).toContain('href="https://workspace.deskohub.cz"');
  expect(openHtml).not.toContain('id="portal-stamp-ink"');
  expect(openHtml).not.toContain(stamp);

  const closedHtml = await closed.text();
  expect(closedHtml).toMatch(
    /<div\b[^>]*class="portal-panel portal-panel-closed portal-panel-bar"[^>]*>/
  );
  expect(closedHtml).toContain('aria-disabled="true"');
  expect(closedHtml).toContain('id="portal-stamp-ink"');
  expect(closedHtml).toContain(stamp);
  expect(closedHtml).not.toContain('href="https://bar.deskohub.cz"');
  expect(closedHtml).toContain('href="https://workspace.deskohub.cz"');
});

test("serves a bodyless HEAD response for a locale without the trailing slash", async () => {
  const response = await fetch(`${origin}/en-US?asOf=2026-11-30T23:00:00Z`, {
    method: "HEAD",
    redirect: "manual",
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe("");
});
