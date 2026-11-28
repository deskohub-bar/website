import type {
  Attributes,
  AttributeValue,
  SpanContext,
  SpanStatus,
  TimeInput,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
  ReadableSpan,
  Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Predicate } from "effect";

/**
 * The span allowlist of the Workspace server: what a span may carry when it
 * leaves the process, to PostHog or Vercel's collector alike.
 * Instrumentations name spans after full request URLs and
 * record URLs, query strings and headers as attributes, and those can carry
 * sign-in tokens and personal data. The policy keeps stable operation names,
 * route templates, status, timings and an explicit attribute allowlist,
 * drops every other attribute and rewrites the rest before any exporter sees
 * the span.
 */

/**
 * The attributes a span keeps; every other key is dropped, whichever
 * instrumentation or application code wrote it. The keys are the ones the
 * Workspace's instrumentations emit with an operational meaning: Next.js
 * spans (`next.*` except `next.span_name`, which repeats the raw span name;
 * `http.route`, `http.method`, `http.status_code`),
 * `@vercel/otel`'s fetch instrumentation (`http.method`, `http.status_code`,
 * `net.peer.name`, `net.peer.port`, `operation.name`), Effect's HTTP client
 * (`http.request.method`, `http.response.status_code`, `server.address`,
 * `server.port`, `url.scheme`, `error.type`) and Effect SQL
 * (`db.system.name`, `db.namespace`, `db.operation.name`). What they record
 * besides, such as `url.full`, `url.path`, `url.query`, `http.url`,
 * `http.target`, `http.host`, `resource.name`, request and response headers,
 * `user_agent.original` and `client.address`, is dropped.
 *
 * Two application keys stay: `operation`, the Workspace operation name that
 * administration operations record, and `action.locale`, the locale a
 * Server Action ran in. Both hold names from a closed set, never values a
 * customer typed.
 */
const allowedAttributes = new Set([
  "http.request.method",
  "http.method",
  "http.response.status_code",
  "http.status_code",
  "http.route",
  "http.scheme",
  "url.scheme",
  "server.address",
  "server.port",
  "net.peer.name",
  "net.peer.port",
  "network.protocol.name",
  "network.protocol.version",
  "db.system",
  "db.system.name",
  "db.namespace",
  "db.operation.name",
  "db.collection.name",
  "db.query.summary",
  "rpc.system",
  "rpc.service",
  "rpc.method",
  "error.type",
  "exception.type",
  "operation.name",
  "next.span_type",
  "next.span_category",
  "next.route",
  "next.page",
  "next.rsc",
  "next.segment",
  "next.bubble",
  "code.function",
  "code.function.name",
  "code.namespace",
  "operation",
  "action.locale",
]);

/**
 * Keys that carry values even though instrumentations treat them as
 * operational: query text with inlined literals and a stack with request
 * data in its frames. They never leave the process, whatever the allowlist
 * above lists.
 */
const deniedAttributes = new Set([
  "code.stacktrace",
  "db.query.text",
  "db.statement",
]);

/** Attributes that hold a route template, never a concrete path. */
const routeTemplateAttributes = new Set([
  "http.route",
  "next.route",
  "next.page",
]);

/** Attributes that name a host, kept only as a bare hostname. */
const hostAttributes = new Set(["server.address", "net.peer.name"]);

const isAllowedAttribute = (key: string) =>
  allowedAttributes.has(key) && !deniedAttributes.has(key);

const redactedText = "[redacted]";

/** A word made of camel-cased dictionary-style parts, such as an operation. */
const camelCasedName = /^[A-Za-z][a-z]+(?:[A-Z][a-z]+)*$/;

const digitCount = (part: string) => part.replace(/\D/g, "").length;

/**
 * Whether the letters of `part` read as a name around its digits, as in
 * `base64UrlDecode` or `utf8ToBase64`: every letter run is camel-cased.
 */
const hasNamedLetterRuns = (part: string) =>
  part
    .split(/\d+/)
    .filter(Boolean)
    .every((run) => camelCasedName.test(run));

const isTokenLikePart = (part: string) =>
  /^\d{6,}$/.test(part) ||
  (part.length >= 12 &&
    /\d/.test(part) &&
    /[a-z]/i.test(part) &&
    (digitCount(part) >= 4 || !hasNamedLetterRuns(part))) ||
  (part.length >= 24 && !camelCasedName.test(part));

/**
 * A word that is probably an identifier or credential rather than a name:
 * a UUID, a long number, a part that mixes letters with several digits or
 * with letter runs that read as no name, or a long part without the shape of
 * a camel-cased name.
 */
const isTokenLike = (word: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(word) ||
  word.split(/[._:-]/).some(isTokenLikePart);

/** A static segment name: short, and not shaped like a value. */
const isStaticSegmentName = (name: string) =>
  /^[\w.-]{1,48}$/.test(name) && !isTokenLike(name);

/** A route parameter's name, such as `id` or `reservationId`. */
const isParameterName = (name: string) =>
  /^[A-Za-z_][\w-]{0,47}$/.test(name) && !isTokenLike(name);

/**
 * A dynamic route segment, such as `[id]`, `[...all]` or `[[...slug]]`, or
 * a `:id` parameter, whose parameter name passes the name check.
 */
const isDynamicRouteSegment = (segment: string) => {
  const parameter =
    /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(segment) ??
    /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment) ??
    /^:(.+)$/.exec(segment);
  return parameter !== null && isParameterName(parameter[1] ?? "");
};

/**
 * A route group `(marketing)`, a parallel route slot `@modal`, or an
 * intercepting route segment such as `(.)photo`, `(..)(..)[id]` or
 * `(...)account`, whose names pass the static segment check.
 */
const isRouteConventionSegment = (segment: string) => {
  const group = /^\(([\w-]+)\)$/.exec(segment);
  if (group) return isStaticSegmentName(group[1] ?? "");
  const slot = /^@([\w-]+)$/.exec(segment);
  if (slot) return isStaticSegmentName(slot[1] ?? "");
  const intercepting = /^(?:\(\.{1,3}\)){1,4}(.+)$/.exec(segment);
  if (!intercepting) return false;
  const target = intercepting[1] ?? "";
  return isDynamicRouteSegment(target) || isStaticSegmentName(target);
};

/**
 * Route template and static path segments, parallel route slots (`@modal`)
 * among them; anything else could be a value.
 */
const isSafePathSegment = (segment: string) =>
  segment === "" ||
  isDynamicRouteSegment(segment) ||
  isRouteConventionSegment(segment) ||
  isStaticSegmentName(segment);

const isSafeWord = (word: string) =>
  word.includes("/")
    ? /^[\w./[\]()@:-]+$/.test(word) &&
      !word.includes("//") &&
      word.split("/").every(isSafePathSegment)
    : /^[\w.:()[\]-]{1,64}$/.test(word) && !isTokenLike(word);

/**
 * Whether `name` is a stable operation name or route-template span name,
 * such as `checkout.createHostedPaymentCheckout`, `http.client GET` or
 * `render route (app) /[locale]/account`. URLs, query strings, encoded
 * values, addresses and identifier-shaped words make a name unsafe.
 */
export const isAllowedSpanName = (name: string) =>
  name.length > 0 &&
  name.length <= 160 &&
  // `@` only starts a parallel route slot segment, which `isSafeWord` checks.
  !/[?#%=&'"\\]|:\/\//.test(name) &&
  name.split(" ").every(isSafeWord);

const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi;
const queryPattern = /[?#][^\s"'<>]*/g;
const pathPattern = /\/[^\s"'<>]+/g;
const tokenPattern = /[A-Za-z0-9_\-+=]{12,}/g;
const quotedLiteralPattern = /'(?:[^']|'')*'/g;

const originOf = (url: string) => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  return parsed?.host ? `${parsed.protocol}//${parsed.host}` : redactedText;
};

const sanitizePath = (path: string) =>
  path
    .split("/")
    .map((segment) => (isSafePathSegment(segment) ? segment : ":redacted"))
    .join("/");

/**
 * Keeps the operational shape of free text and removes values: a URL keeps
 * its origin, a path keeps its template and static segments, and query
 * strings, fragments, quoted SQL literals and long token-shaped runs go.
 */
export const sanitizeSpanText = (text: string) =>
  text
    .replace(urlPattern, originOf)
    .replace(queryPattern, "")
    .replace(quotedLiteralPattern, "'?'")
    .replace(pathPattern, sanitizePath)
    .replace(tokenPattern, (run) => (isTokenLike(run) ? redactedText : run));

const hostPattern = /^[a-z0-9.-]{1,253}$/i;

/** A number or boolean array attribute, which carries no text to sanitize. */
const isStringFreeArray = (
  value: Exclude<AttributeValue, string | number | boolean>
): value is
  | Array<null | undefined | number>
  | Array<null | undefined | boolean> => !value.some(Predicate.isString);

const sanitizeAttributeValue = (
  key: string,
  value: AttributeValue
): AttributeValue | undefined => {
  if (hostAttributes.has(key)) {
    return Predicate.isString(value) && hostPattern.test(value)
      ? value
      : undefined;
  }
  if (routeTemplateAttributes.has(key)) {
    return Predicate.isString(value)
      ? sanitizePath(value.replace(queryPattern, ""))
      : undefined;
  }
  if (Predicate.isString(value)) return sanitizeSpanText(value);
  if (!Array.isArray(value) || isStringFreeArray(value)) return value;
  return value.map((item) =>
    Predicate.isString(item) ? sanitizeSpanText(item) : item
  );
};

/** Applies the allowlist to `attributes` in place. */
const sanitizeAttributesInPlace = (attributes: Attributes) => {
  for (const [key, value] of Object.entries(attributes)) {
    const allowed = value !== undefined && isAllowedAttribute(key);
    const sanitized = allowed ? sanitizeAttributeValue(key, value) : undefined;
    if (sanitized === undefined) delete attributes[key];
    else attributes[key] = sanitized;
  }
};

const stringAttribute = (attributes: Attributes, ...keys: string[]) => {
  for (const key of keys) {
    const value = attributes[key];
    if (Predicate.isString(value) && value) return value;
  }
  return undefined;
};

const httpMethodName = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) /;

/**
 * Whether `name` names an HTTP request by its path, such as Next.js's
 * `GET /cs-CZ/reservation/abc` before it knows the route. Its static-looking
 * segments can still be path parameters, so only a route template may stand
 * in for the path.
 */
const isRequestPathName = (name: string, method: string | undefined) =>
  name.split(" ").some((word) => word.includes("/")) &&
  (method !== undefined || httpMethodName.test(name));

/**
 * The span's own name when the allowlist accepts it and it is no request
 * path, else the most specific stable name its sanitized attributes support:
 * method and route template, Next.js span type, method and provider host,
 * method, or `span`.
 */
const allowedSpanName = (name: string, attributes: Attributes) => {
  const method = stringAttribute(
    attributes,
    "http.request.method",
    "http.method"
  );
  if (isAllowedSpanName(name) && !isRequestPathName(name, method)) {
    return name;
  }
  const route = stringAttribute(attributes, "http.route", "next.route");
  const host = stringAttribute(attributes, "server.address", "net.peer.name");
  const candidates = [
    method && route && `${method} ${route}`,
    stringAttribute(attributes, "next.span_type"),
    method && host && `${method} ${host}`,
    method,
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        Predicate.isString(candidate) &&
        candidate !== "" &&
        isAllowedSpanName(candidate)
    ) ?? "span"
  );
};

/**
 * Exception events keep their type; their message and stack carry provider
 * error bodies and values. Other events keep allowlisted attributes.
 */
const sanitizeEventsInPlace = (span: Span) => {
  for (const event of span.events) {
    if (!isAllowedSpanName(event.name)) event.name = "event";
    if (event.attributes) {
      delete event.attributes["exception.message"];
      delete event.attributes["exception.stacktrace"];
      sanitizeAttributesInPlace(event.attributes);
    }
  }
};

const sanitizeLinksInPlace = (span: Span) => {
  for (const link of span.links) {
    if (link.attributes) sanitizeAttributesInPlace(link.attributes);
  }
};

/** The status keeps its code; its message is exception text. */
const sanitizeStatusInPlace = (span: Span) => {
  const status: SpanStatus = span.status;
  if (status.message !== undefined) delete status.message;
};

/** Rewrites an unended span so it satisfies the allowlist. */
const applySpanAllowlist = (span: Span) => {
  sanitizeAttributesInPlace(span.attributes);
  const name = allowedSpanName(span.name, span.attributes);
  if (name !== span.name) span.updateName(name);
  sanitizeEventsInPlace(span);
  sanitizeLinksInPlace(span);
  sanitizeStatusInPlace(span);
};

/**
 * Span processor that applies the Workspace span allowlist as each span
 * ends, after every instrumentation has written its name and attributes and
 * before any exporting processor receives it. Register it ahead of the
 * exporting processors: `registerOTel({ spanProcessors: [new
 * SpanAllowlistProcessor(), "auto"] })`.
 */
export class SpanAllowlistProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const end = span.end.bind(span);
    span.end = (endTime?: TimeInput) => {
      if (!span.ended) applySpanAllowlist(span);
      end(endTime);
    };
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Resource attributes a span keeps in the PostHog export: the
 * Workspace's own identity and the SDK's. Host and process details the
 * resource detectors add stay in the process.
 */
const allowedResourceAttributes = new Set([
  "service.name",
  "service.namespace",
  "service.version",
  "deployment.id",
  "deployment.environment.name",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
]);

/**
 * A span context with its trace and span ids and flags, without its W3C
 * trace state: a caller's `tracestate` header sets it, and its entries can
 * hold any text, URLs among them.
 */
const withoutTraceState = ({
  traceState: _traceState,
  ...context
}: SpanContext): SpanContext => context;

const allowlistedCopy = (attributes: Attributes | undefined) => {
  const copy: Attributes = { ...attributes };
  sanitizeAttributesInPlace(copy);
  return copy;
};

/**
 * A copy of an ended span that satisfies the allowlist, whatever processors
 * that ran after `SpanAllowlistProcessor` added, such as the attributes
 * `@vercel/otel` derives when a span ends.
 */
const toAllowlistedSpan = (span: ReadableSpan): ReadableSpan => {
  const attributes = allowlistedCopy(span.attributes);
  const resourceAttributes = Object.fromEntries(
    Object.entries(span.resource.attributes).filter(([key]) =>
      allowedResourceAttributes.has(key)
    )
  );
  return {
    attributes,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    duration: span.duration,
    ended: span.ended,
    endTime: span.endTime,
    events: span.events.map((event) => {
      const {
        "exception.message": _message,
        "exception.stacktrace": _stack,
        ...eventAttributes
      } = event.attributes ?? {};
      return {
        ...event,
        name: isAllowedSpanName(event.name) ? event.name : "event",
        attributes: allowlistedCopy(eventAttributes),
      };
    }),
    instrumentationScope: span.instrumentationScope,
    kind: span.kind,
    links: span.links.map((link) => ({
      ...link,
      context: withoutTraceState(link.context),
      attributes: allowlistedCopy(link.attributes),
    })),
    name: allowedSpanName(span.name, attributes),
    parentSpanContext:
      span.parentSpanContext && withoutTraceState(span.parentSpanContext),
    resource: resourceFromAttributes(
      resourceAttributes,
      span.resource.schemaUrl
        ? { schemaUrl: span.resource.schemaUrl }
        : undefined
    ),
    spanContext: () => withoutTraceState(span.spanContext()),
    startTime: span.startTime,
    status: { code: span.status.code },
  };
};

/**
 * The exporter of the PostHog span export: every span it receives satisfies
 * the allowlist again, after every processor has run. The allowlist is
 * stricter than the shared log censorship, which would also mask the hosts,
 * database names and operation names the export is meant to keep.
 */
export const createAllowlistedSpanExporter = (
  exporter: SpanExporter
): SpanExporter => ({
  export: (spans, resultCallback) =>
    exporter.export(spans.map(toAllowlistedSpan), resultCallback),
  forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
  shutdown: () => exporter.shutdown(),
});
