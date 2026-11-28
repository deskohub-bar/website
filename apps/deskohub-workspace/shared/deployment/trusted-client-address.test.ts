import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  trustedClientAddressHeaderSchema,
  trustedClientAddressHeaders,
  vercelClientAddressHeader,
} from "./trusted-client-address";

const acceptsHeader = (header: string) =>
  Schema.is(trustedClientAddressHeaderSchema)(header);

describe("trustedClientAddressHeaders", () => {
  test("trusts only Vercel's header on Vercel", () => {
    expect(
      trustedClientAddressHeaders({ VERCEL_URL: "workspace.vercel.app" })
    ).toEqual([vercelClientAddressHeader]);
  });

  test("trusts the configured ingress header instead of Vercel's", () => {
    expect(
      trustedClientAddressHeaders({
        WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER: "x-deskohub-client-address",
        VERCEL_URL: "workspace.vercel.app",
      })
    ).toEqual(["x-deskohub-client-address"]);
  });

  test("trusts no forwarded header off Vercel without a configured ingress", () => {
    expect(trustedClientAddressHeaders({})).toEqual([]);
  });
});

describe("trustedClientAddressHeaderSchema", () => {
  test("accepts a lowercase header the ingress sets", () => {
    expect(acceptsHeader("x-deskohub-client-address")).toBe(true);
  });

  test("rejects headers a client can append to, and malformed names", () => {
    expect(acceptsHeader("x-forwarded-for")).toBe(false);
    expect(acceptsHeader("forwarded")).toBe(false);
    expect(acceptsHeader("X-Client-IP")).toBe(false);
    expect(acceptsHeader("x client")).toBe(false);
    expect(acceptsHeader("")).toBe(false);
  });
});
