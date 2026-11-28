import { describe, expect, test } from "bun:test";
import { Effect, Option, Result, Schema } from "effect";
import { Headers } from "effect/http";
import {
  CallerHeaders,
  decodeCallerHeaders,
  InvalidCallerHeaders,
} from "./caller";
import { correlationIdHeader } from "./correlation";

const correlationId = "72823c14-d2de-4a19-94ec-8b70ad590242";
const userAgent = "Mozilla/5.0 (KHTML, like Gecko)";
const wireUserAgent = Buffer.from(userAgent).toString("base64url");
const headers = Headers.fromInput({
  [correlationIdHeader]: correlationId,
  "x-deskohub-locale": "cs-CZ",
});

describe("caller header decoding", () => {
  test("decodes the anonymous caller and ignores ambient HTTP headers", async () => {
    const caller = await Effect.runPromise(
      decodeCallerHeaders(
        Headers.merge(
          headers,
          Headers.fromInput({
            "x-deskohub-client-address": "2001:db8::42",
            "x-deskohub-user-agent": wireUserAgent,
            "x-forwarded-for": "192.0.2.60",
            "user-agent": "transport-agent",
          })
        )
      )
    );

    expect(caller).toEqual({
      correlationId,
      locale: "cs-CZ",
      clientAddress: Option.some("2001:db8::42"),
      userAgent: Option.some(userAgent),
    });
    expect(await Effect.runPromise(decodeCallerHeaders(headers))).toEqual({
      correlationId,
      locale: "cs-CZ",
      clientAddress: Option.none(),
      userAgent: Option.none(),
    });
  });

  for (const [name, value] of [
    [correlationIdHeader, correlationId],
    ["x-deskohub-locale", "cs-CZ"],
    ["x-deskohub-client-address", "192.0.2.60"],
    ["x-deskohub-user-agent", wireUserAgent],
  ]) {
    if (!name || !value) throw new Error("Invalid test headers");
    test(`rejects a repeated ${name} merged by Effect`, async () => {
      const otherHeaders = Headers.remove(headers, name);
      const merged = Headers.fromInput([
        ...Object.entries(otherHeaders),
        [name, value],
        [name.toUpperCase(), value],
      ]);
      expect(
        await Effect.runPromise(Effect.flip(decodeCallerHeaders(merged)))
      ).toBeInstanceOf(InvalidCallerHeaders);
    });
  }

  test("rejects malformed caller header values", async () => {
    for (const invalid of [
      Headers.set(headers, "x-deskohub-client-address", "192.0.2.1:81"),
      Headers.set(headers, correlationIdHeader, "caller"),
      Headers.set(headers, "x-deskohub-locale", "xx-XX"),
      Headers.remove(headers, correlationIdHeader),
      Headers.set(headers, "x-deskohub-user-agent", userAgent),
      Headers.set(headers, "x-deskohub-user-agent", "b2sA"),
      Headers.set(headers, "x-deskohub-user-agent", "dGVzdA0KdGVzdA"),
      Headers.set(
        headers,
        "x-deskohub-user-agent",
        Buffer.from("a".repeat(2049)).toString("base64url")
      ),
    ]) {
      expect(
        await Effect.runPromise(Effect.flip(decodeCallerHeaders(invalid)))
      ).toBeInstanceOf(InvalidCallerHeaders);
    }
  });

  test("rejects an oversized encoded user-agent before decoding it", () => {
    const decoded = Schema.decodeUnknownResult(CallerHeaders)(
      Headers.set(headers, "x-deskohub-user-agent", "A".repeat(8196))
    );
    if (Result.isSuccess(decoded))
      throw new Error("Expected an invalid wire header");
    expect(decoded.failure.message).toContain("a length of at most 8192");
  });
});
