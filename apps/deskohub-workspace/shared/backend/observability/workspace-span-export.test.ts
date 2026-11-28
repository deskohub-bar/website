import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import {
  context,
  createTraceState,
  ProxyTracerProvider,
  propagation,
  SpanKind,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { registerOTel } from "@vercel/otel";
import { Predicate, Schema } from "effect";
import { createWorkspaceOTelRegistration } from "./telemetry-sinks";
import { flushWorkspaceTraces } from "./workspace-telemetry";

// Synthetic markers only; nothing leaves the test's stand-in PostHog host.
const traceStateMarker = "statemarker";
const tokenMarker = "tokSynthMarker7Q2xK9vB4nR8mW1zL6pD3";
const authorizationMarker = "authSynthMarker4V8nQ1wE6rT3yU9";
const cookieMarker = "cookieSynthMarker2J7mK5pL8sD1fG4";
const customMarker = "customSynthMarker9B3vN6cX2zA5qW8";
const addressMarker = testEmailAddress("synthetic-marker-recipient");
const projectToken = "synthetic-project-token";

interface ReceivedExport {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

const ExportedAttributeSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
  ),
});

type ExportedAttribute = typeof ExportedAttributeSchema.Type;

const ExportedSpanSchema = Schema.Struct({
  name: Schema.String,
  attributes: Schema.Array(ExportedAttributeSchema),
  parentSpanId: Schema.optionalKey(Schema.String),
  links: Schema.optionalKey(
    Schema.Array(Schema.Struct({ spanId: Schema.String }))
  ),
});

const ExportedTracesSchema = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({
        attributes: Schema.Array(ExportedAttributeSchema),
      }),
      scopeSpans: Schema.Array(
        Schema.Struct({ spans: Schema.Array(ExportedSpanSchema) })
      ),
    })
  ),
});

const attributeMap = (attributes: readonly ExportedAttribute[]) =>
  Object.fromEntries(
    attributes.map(({ key, value }) => [key, Object.values(value)[0]])
  );

describe("the Workspace's PostHog span export through registerOTel", () => {
  test("sends PostHog allowlisted spans only, after every processor ran", async () => {
    const received: ReceivedExport[] = [];
    const posthog = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        received.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.text(),
        });
        return new Response(null, { status: 200 });
      },
    });

    try {
      registerOTel({
        ...createWorkspaceOTelRegistration({
          deploymentEnvironment: "preview",
          serviceVersion: "synthetic-sha",
          deploymentId: "synthetic-deployment",
          posthogHost: `http://127.0.0.1:${posthog.port}`,
          posthogProjectToken: projectToken,
          tracesExport: "always",
        }),
        // The spans are recorded by hand; no instrumentation patches fetch.
        instrumentations: [],
      });
      // A caller's trace context, with trace state from its `tracestate`.
      const callerContext = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: TraceFlags.SAMPLED,
        traceState: createTraceState(`vendor=${traceStateMarker}`),
      };
      // A server span, which @vercel/otel names a resource for as it ends,
      // under the caller's context and linked to it.
      trace
        .getTracer("workspace-span-export-test")
        .startSpan(
          "GET /api/customers/sample-slug",
          {
            kind: SpanKind.SERVER,
            attributes: {
              "http.method": "GET",
              "http.route": "/api/customers/[customerId]",
              "http.target": `/api/customers/sample-slug?token=${tokenMarker}`,
              "http.request.header.authorization": [
                `Bearer ${authorizationMarker}`,
              ],
              "http.request.header.cookie": [`session=${cookieMarker}`],
              "customer.note": customMarker,
            },
            links: [{ context: callerContext }],
          },
          trace.setSpanContext(context.active(), callerContext)
        )
        .end();
      const span = trace
        .getTracer("workspace-span-export-test")
        .startSpan(
          `fetch GET https://api.provider.invalid/v1/customers?email=${addressMarker}`,
          {
            attributes: {
              "http.method": "GET",
              "http.url": `https://api.provider.invalid/v1/customers?token=${tokenMarker}`,
              "net.peer.name": "api.provider.invalid",
              "db.query.text": `select '${tokenMarker}'`,
              unitId: tokenMarker,
            },
          }
        );
      span.end();
      await flushWorkspaceTraces();

      expect(received.length).toBeGreaterThan(0);
      for (const { path, authorization } of received) {
        expect(path).toBe("/i/v1/traces");
        expect(authorization).toBe(`Bearer ${projectToken}`);
      }
      const bodies = received.map(({ body }) => body);
      const exported = bodies.join("\n");
      for (const marker of [
        tokenMarker,
        authorizationMarker,
        cookieMarker,
        customMarker,
        addressMarker,
      ]) {
        expect(exported).not.toContain(marker);
      }
      for (const key of ["authorization", "cookie", "customer.note"]) {
        expect(exported).not.toContain(key);
      }
      expect(exported).not.toContain("sample-slug");
      expect(exported).not.toContain(traceStateMarker);
      expect(exported).toContain("0af7651916cd43dd8448eb211c80319c");
      const allResourceSpans = bodies.flatMap(
        (body) =>
          Schema.decodeUnknownSync(Schema.fromJsonString(ExportedTracesSchema))(
            body
          ).resourceSpans
      );
      const [resourceSpans] = allResourceSpans;
      const spans = allResourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ spans }) => spans)
      );
      const serverSpan = spans?.find(({ name }) => name.startsWith("GET /"));
      expect(serverSpan?.name).toBe("GET /api/customers/[customerId]");
      // The caller's context survives as the parent and the link.
      expect(serverSpan?.parentSpanId).toBe(callerContext.spanId);
      expect(serverSpan?.links?.map(({ spanId }) => spanId)).toEqual([
        callerContext.spanId,
      ]);
      expect(attributeMap(serverSpan?.attributes ?? [])).toMatchObject({
        "http.method": "GET",
        "http.route": "/api/customers/[customerId]",
      });
      expect(
        Object.keys(attributeMap(serverSpan?.attributes ?? []))
      ).not.toContain("resource.name");
      const exportedSpan = spans?.find(({ name }) =>
        name.includes("api.provider.invalid")
      );
      expect(exportedSpan?.name).toBe("GET api.provider.invalid");
      expect(attributeMap(exportedSpan?.attributes ?? [])).toEqual({
        "http.method": "GET",
        "net.peer.name": "api.provider.invalid",
        "operation.name": expect.any(String),
      });
      expect(
        attributeMap(resourceSpans?.resource.attributes ?? [])
      ).toMatchObject({
        "service.name": "deskohub-workspace",
        "deployment.environment.name": "preview",
        "service.version": "synthetic-sha",
        "deployment.id": "synthetic-deployment",
      });
    } finally {
      const registered = trace.getTracerProvider();
      const provider =
        registered instanceof ProxyTracerProvider
          ? registered.getDelegate()
          : registered;
      if (
        Predicate.hasProperty(provider, "shutdown") &&
        Predicate.isFunction(provider.shutdown)
      ) {
        await provider.shutdown();
      }
      trace.disable();
      context.disable();
      propagation.disable();
      await posthog.stop(true);
    }
  });
});
