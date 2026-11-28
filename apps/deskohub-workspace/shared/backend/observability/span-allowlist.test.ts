import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { type Attributes, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { isAllowedSpanName, sanitizeSpanText } from "./span-allowlist";
import { createWorkspaceOTelRegistration } from "./telemetry-sinks";

// Synthetic markers only: each stands for a credential or personal value a
// span must never export. The control marker sits in an allowlisted field,
// so finding it proves the span arrived.
const tokenMarker = "tokSynthMarker7Q2xK9vB4nR8mW1zL6pD3";
const addressMarker = testEmailAddress("synthetic-marker-recipient");
const pathMarker = "accessSynthMarker5H8kT2qW9xY4";
const controlRoute = "/[locale]/control-marker-route";

const leakingMarkers = [
  tokenMarker,
  encodeURIComponent(tokenMarker),
  addressMarker,
  encodeURIComponent(addressMarker),
  pathMarker,
];

/**
 * Records a representative set of unsafe spans through `provider`, with the
 * names and attribute keys the Workspace's instrumentations write: Next.js
 * server spans, `@vercel/otel`'s fetch instrumentation, Effect's HTTP client
 * and SQL client, and Effect spans with application attributes.
 */
const recordUnsafeSpans = (provider: BasicTracerProvider) => {
  const tracer = provider.getTracer("span-allowlist-test");
  const record = (
    name: string,
    attributes: Attributes,
    finish?: (span: ReturnType<typeof tracer.startSpan>) => void
  ) => {
    const span = tracer.startSpan(name, { attributes, kind: SpanKind.SERVER });
    finish?.(span);
    span.end();
  };

  // Next.js `BaseServer.handleRequest`, before the route is known.
  record(`GET /api/auth/magic-link/verify?token=${tokenMarker}`, {
    "next.span_type": "BaseServer.handleRequest",
    "next.span_name": `GET /api/auth/magic-link/verify?token=${tokenMarker}`,
    "http.method": "GET",
    "http.target": `/api/auth/magic-link/verify?token=${tokenMarker}`,
    "http.url": `https://workspace.invalid/api/auth/magic-link/verify?token=${tokenMarker}`,
    "http.status_code": 302,
    "http.route": "/api/auth/magic-link/verify",
    "next.route": controlRoute,
    "next.rsc": false,
  });
  record(`GET /cs-CZ/marketing-preferences/access/${pathMarker}`, {
    "http.method": "GET",
  });
  record(`send magic link to ${addressMarker}`, {});
  record(`account.lookup ${pathMarker}`, {});
  // An Effect span with application attributes, an exception and a status.
  record(
    "checkout.createHostedPaymentCheckout",
    {
      callbackUrl: `https://workspace.invalid/app/auth/callback?code=${tokenMarker}`,
      returnPath: `/cs-CZ/marketing-preferences/access/${pathMarker}`,
      unitId: tokenMarker,
      operation: "checkout.createHostedPaymentCheckout",
      "code.stacktrace": `at checkout (${pathMarker})`,
    },
    (span) => {
      span.addEvent("exception", {
        "exception.type": "ProviderError",
        "exception.message": `provider said ${tokenMarker} for ${addressMarker}`,
        "exception.stacktrace": `Error: ${tokenMarker}\n    at provider`,
      });
      span.addEvent(`retry ${addressMarker}`);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `failed for ${addressMarker}`,
      });
    }
  );
  // Effect SQL: its span is named after the database or system.
  record("postgresql", {
    "db.system.name": "postgresql",
    "db.namespace": "workspace",
    "db.operation.name": "SELECT",
    "db.query.text": `select * from verification where token = '${tokenMarker}'`,
    "db.statement": `select * from verification where token = '${tokenMarker}'`,
    "server.address": "db.provider.invalid",
  });
  // Effect's HTTP client.
  record("http.client GET", {
    "http.request.method": "GET",
    "url.full": `https://api.provider.invalid/v1/customers?email=${addressMarker}`,
    "url.path": `/v1/customers/${pathMarker}`,
    "url.query": `email=${addressMarker}`,
    "url.scheme": "https",
    "server.address": "api.provider.invalid",
    "server.port": 443,
    "http.request.header.authorization": [`Bearer ${tokenMarker}`],
    "http.response.status_code": 200,
    "user_agent.original": addressMarker,
    "client.address": "198.51.100.7",
  });
  // `@vercel/otel`'s fetch instrumentation.
  record(
    `fetch GET https://api.provider.invalid/v1/customers?email=${addressMarker}`,
    {
      "operation.name": "fetch.GET",
      "resource.name": `https://api.provider.invalid/v1/customers?email=${addressMarker}`,
      "http.method": "GET",
      "http.url": `https://api.provider.invalid/v1/customers?email=${addressMarker}`,
      "http.host": "api.provider.invalid:443",
      "http.scheme": "https",
      "http.user_agent": addressMarker,
      "net.peer.name": "api.provider.invalid",
      "net.peer.port": 443,
      "http.status_code": 200,
    }
  );
  // Next.js names a request by its path before it knows the route; a short
  // parameter looks like a static segment.
  record("GET /api/customers/sample-slug", {
    "http.method": "GET",
    "http.route": "/api/customers/[customerId]",
  });
  record("POST /api/customers/sample-slug", {});
  // A client address or credential where only a host belongs.
  record("http.client POST", {
    "http.request.method": "POST",
    "server.address": [tokenMarker, "api.provider.invalid"].join("@"),
    "net.peer.name": "api.provider.invalid:8443",
  });
};

const exportedFields = (spans: readonly ReadableSpan[]) =>
  JSON.stringify(
    spans.map(({ name, attributes, events, status, links }) => ({
      name,
      attributes,
      events,
      status,
      links,
    }))
  );

/** A registration that exports its spans to PostHog at `posthogHost`. */
const exportingRegistration = (posthogHost = "https://posthog.invalid") =>
  createWorkspaceOTelRegistration({
    deploymentEnvironment: "preview",
    posthogHost,
    posthogProjectToken: "synthetic-project-token",
    tracesExport: "always",
  });

/**
 * The exporting registration's processors, with an in-memory exporter in
 * place of its PostHog export.
 */
const registrationProvider = (exporter: SpanExporter) =>
  new BasicTracerProvider({
    spanProcessors: [
      ...exportingRegistration()
        .spanProcessors.slice(0, -1)
        .filter(
          (processor): processor is SpanProcessor => processor !== "auto"
        ),
      new SimpleSpanProcessor(exporter),
    ],
  });

const recordedSpans = async () => {
  const exporter = new InMemorySpanExporter();
  const provider = registrationProvider(exporter);
  recordUnsafeSpans(provider);
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  await provider.shutdown();
  return spans;
};

describe("Workspace span allowlist", () => {
  test("exports no token, address or token-bearing path from names, attributes, events or status", async () => {
    const spans = await recordedSpans();
    const exported = exportedFields(spans);

    expect(spans).toHaveLength(11);
    expect(exported).not.toContain("sample-slug");
    for (const marker of leakingMarkers) {
      expect(exported).not.toContain(marker);
    }
    expect(exported).toContain(controlRoute);
  });

  test("keeps route templates, status codes, stable names and provider hosts", async () => {
    const [
      handleRequest,
      accessPage,
      addressed,
      lookup,
      checkout,
      sql,
      client,
      fetchSpan,
      routed,
      unrouted,
      invalidHost,
    ] = await recordedSpans();

    expect(handleRequest?.name).toBe("GET /api/auth/magic-link/verify");
    expect(handleRequest?.attributes).toEqual({
      "next.span_type": "BaseServer.handleRequest",
      "http.method": "GET",
      "http.status_code": 302,
      "http.route": "/api/auth/magic-link/verify",
      "next.route": controlRoute,
      "next.rsc": false,
    });
    expect(accessPage?.name).toBe("GET");
    expect(addressed?.name).toBe("span");
    expect(lookup?.name).toBe("span");
    expect(checkout?.name).toBe("checkout.createHostedPaymentCheckout");
    expect(checkout?.attributes).toEqual({
      operation: "checkout.createHostedPaymentCheckout",
    });
    expect(checkout?.status.code).toBe(SpanStatusCode.ERROR);
    expect(checkout?.status.message).toBeUndefined();
    expect(checkout?.events.map(({ name }) => name)).toEqual([
      "exception",
      "event",
    ]);
    expect(checkout?.events[0]?.attributes).toEqual({
      "exception.type": "ProviderError",
    });
    expect(sql?.name).toBe("postgresql");
    expect(sql?.attributes).toEqual({
      "db.system.name": "postgresql",
      "db.namespace": "workspace",
      "db.operation.name": "SELECT",
      "server.address": "db.provider.invalid",
    });
    expect(client?.name).toBe("http.client GET");
    expect(client?.attributes).toEqual({
      "http.request.method": "GET",
      "url.scheme": "https",
      "server.address": "api.provider.invalid",
      "server.port": 443,
      "http.response.status_code": 200,
    });
    expect(fetchSpan?.name).toBe("GET api.provider.invalid");
    expect(fetchSpan?.attributes).toEqual({
      "operation.name": "fetch.GET",
      "http.method": "GET",
      "http.scheme": "https",
      "net.peer.name": "api.provider.invalid",
      "net.peer.port": 443,
      "http.status_code": 200,
    });
    expect(routed?.name).toBe("GET /api/customers/[customerId]");
    expect(unrouted?.name).toBe("span");
    expect(invalidHost?.attributes).toEqual({
      "http.request.method": "POST",
    });
  });

  test("never exports query text, statements or stacks", async () => {
    const exported = exportedFields(await recordedSpans());

    for (const key of ["db.query.text", "db.statement", "code.stacktrace"]) {
      expect(exported).not.toContain(key);
    }
  });

  test("sends PostHog only allowlisted spans", async () => {
    const bodies: Uint8Array[] = [];
    const posthog = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        bodies.push(new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      },
    });
    const registration = exportingRegistration(
      `http://127.0.0.1:${posthog.port}`
    );
    const provider = new BasicTracerProvider({
      spanProcessors: registration.spanProcessors.filter(
        (processor): processor is SpanProcessor => processor !== "auto"
      ),
    });

    try {
      recordUnsafeSpans(provider);
      await provider.forceFlush();

      const received = new TextDecoder().decode(
        Buffer.concat(bodies.map((body) => Buffer.from(body)))
      );
      expect(bodies.length).toBeGreaterThan(0);
      expect(received).toContain(controlRoute);
      // The export keeps the validated hosts, database and operation
      // names the shared log censorship would mask.
      for (const kept of [
        "api.provider.invalid",
        "db.provider.invalid",
        "fetch.GET",
        '"key":"db.namespace","value":{"stringValue":"workspace"}',
      ]) {
        expect(received).toContain(kept);
      }
      for (const key of [
        "db.query.text",
        "url.full",
        "resource.name",
        "next.span_name",
      ]) {
        expect(received).not.toContain(key);
      }
      for (const marker of leakingMarkers) {
        expect(received).not.toContain(marker);
      }
    } finally {
      await provider.shutdown();
      await posthog.stop(true);
    }
  });
});

describe("isAllowedSpanName", () => {
  test("accepts stable operation names and route templates", () => {
    for (const name of [
      "checkout.createHostedPaymentCheckout",
      "http.client GET",
      "GET /[locale]/account",
      "render route (app) /[locale]/reservation/[reservationId]",
      "executing api route (app) /api/auth/[...all]/route",
      "resolve page components",
      "render route (app) /[locale]/@modal/(.)reservation/[reservationId]",
      "render route (app) /[locale]/(..)(..)account",
      "render route (app) /[locale]/(...)reservation/[[...slug]]",
      "encoding.base64UrlDecode",
      "utf8ToBase64Url",
      "GET /api/customers/:customerId",
    ]) {
      expect(isAllowedSpanName(name)).toBe(true);
    }
  });

  test("rejects URLs, query strings, addresses, encoded values and identifiers", () => {
    for (const name of [
      "GET https://workspace.invalid/",
      "GET /api/auth/magic-link/verify?token=abc",
      `send to ${addressMarker}`,
      "GET /access/abc%20def",
      `GET /cs-CZ/marketing-preferences/access/${pathMarker}`,
      "reservation 4f1c2a9e-0b7d-4a51-9a3e-2d4b6c8e1f00",
      "order 1234567890",
      "session aZ3kQpLm9xWr",
      `render route (app) /[locale]/@${tokenMarker}/page`,
      `render route (app) /[locale]/(.)${tokenMarker}`,
      `render route (app) /[locale]/(${tokenMarker})/page`,
      `render route (app) /[locale]/(..)(..)${pathMarker}`,
      `render route (app) /[locale]/[${tokenMarker}]`,
      `render route (app) /[locale]/[...${tokenMarker}]`,
      `render route (app) /[locale]/[[...${tokenMarker}]]`,
      `render route (app) /[locale]/(.)[${pathMarker}]`,
      `GET /api/:${tokenMarker}`,
      "key deadbeef1234abcd",
      "",
    ]) {
      expect(isAllowedSpanName(name)).toBe(false);
    }
  });
});

describe("sanitizeSpanText", () => {
  test("keeps the origin of a URL and the template of a path", () => {
    expect(
      sanitizeSpanText(
        `redirect to https://workspace.invalid/app/auth/callback?code=${tokenMarker}#done`
      )
    ).toBe("redirect to https://workspace.invalid");
    expect(
      sanitizeSpanText(`/cs-CZ/marketing-preferences/access/${pathMarker}?x=1`)
    ).toBe("/cs-CZ/marketing-preferences/access/:redacted");
  });

  test("removes long token-shaped runs from free text", () => {
    expect(sanitizeSpanText(`session ${tokenMarker} expired`)).toBe(
      "session [redacted] expired"
    );
  });
});
