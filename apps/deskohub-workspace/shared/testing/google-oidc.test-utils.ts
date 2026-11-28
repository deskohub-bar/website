import { mock, spyOn } from "bun:test";
import type { GoogleInvoker } from "@deskohub/google-oidc";
import { testEmailAddress } from "@deskohub/test-email";
import { Predicate } from "effect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { env } from "@/env";

/** Synthetic invokers with the distinct accounts and audiences infra declares. */
export const tasksInvoker: GoogleInvoker = {
  email: testEmailAddress("synthetic-tasks-invoker"),
  audience: "https://tasks-worker.workspace.test",
};
export const schedulerInvoker: GoogleInvoker = {
  email: testEmailAddress("synthetic-scheduler-invoker"),
  audience: "https://scheduler-worker.workspace.test",
};

/** The settings of a container host that accepts both invokers. */
export const googleInvokerSettings = {
  WORKSPACE_TASKS_INVOKER_EMAIL: tasksInvoker.email,
  WORKSPACE_TASKS_AUDIENCE: tasksInvoker.audience,
  WORKSPACE_SCHEDULER_INVOKER_EMAIL: schedulerInvoker.email,
  WORKSPACE_SCHEDULER_AUDIENCE: schedulerInvoker.audience,
};

type WorkerHostSettings = {
  readonly [Key in keyof typeof env]?: (typeof env)[Key] | undefined;
};

/**
 * Overrides the settings `env` reads with `initial`, for a test of a worker
 * route. Call it before importing the modules under test; the returned
 * function replaces the overrides.
 */
export const mockWorkerHost = async (initial: WorkerHostSettings) => {
  let host = initial;
  const envModule = await import("@/env");
  mock.module("@/env", () => ({
    ...envModule,
    env: new Proxy(envModule.env, {
      get: (target, key) =>
        Object.hasOwn(host, key)
          ? Reflect.get(host, key)
          : Reflect.get(target, key),
    }),
  }));
  return (next: WorkerHostSettings) => {
    host = next;
  };
};

interface TokenClaims {
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly aud?: string | readonly string[];
  readonly iss?: string;
  /** Seconds relative to now. */
  readonly issuedAt?: number;
  /** Seconds relative to now. */
  readonly expiresIn?: number;
}

type GoogleCertificatesState =
  | "serving"
  | "server-error"
  | "not-json"
  | "invalid-set"
  | "network-error";

const googleCertificatesUrl = "https://www.googleapis.com/oauth2/v3/certs";
const keyId = "synthetic-google-signing-key";
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Serves a local RS256 key set at Google's certificate URL and signs tokens
 * with it, so OIDC verification runs without the network. Other requests
 * reach the real `fetch`.
 */
export const serveGoogleSigningKeys = async (
  initial: GoogleCertificatesState = "serving"
) => {
  const google = await generateKeyPair("RS256");
  const foreign = await generateKeyPair("RS256");
  const keySet = {
    keys: [
      {
        ...(await exportJWK(google.publicKey)),
        kid: keyId,
        alg: "RS256",
        use: "sig",
      },
    ],
  };
  const certificateResponses = {
    serving: () => Promise.resolve(Response.json(keySet)),
    "server-error": () =>
      Promise.resolve(new Response("unavailable", { status: 500 })),
    "not-json": () => Promise.resolve(new Response("<html>")),
    "invalid-set": () => Promise.resolve(Response.json({ keys: "none" })),
    "network-error": () => Promise.reject(new TypeError("fetch failed")),
  } satisfies Record<GoogleCertificatesState, () => Promise<Response>>;
  let state = initial;
  const realFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) =>
        String(input instanceof Request ? input.url : input) ===
        googleCertificatesUrl
          ? certificateResponses[state]()
          : realFetch(input, init),
      { preconnect: realFetch.preconnect }
    )
  );

  /**
   * A Google ID token for `invoker`. `signedBy: "foreign"` signs with a key
   * Google does not publish under the same key ID.
   */
  const token = (
    invoker: GoogleInvoker,
    claims: TokenClaims = {},
    signedBy: "google" | "foreign" = "google"
  ) => {
    const issuedAt = nowSeconds() + (claims.issuedAt ?? -10);
    const audience = claims.aud ?? invoker.audience;
    return new SignJWT({
      email: claims.email ?? invoker.email,
      email_verified: claims.email_verified ?? true,
    })
      .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
      .setIssuer(claims.iss ?? "https://accounts.google.com")
      .setAudience(Predicate.isString(audience) ? audience : [...audience])
      .setIssuedAt(issuedAt)
      .setExpirationTime(nowSeconds() + (claims.expiresIn ?? 3590))
      .sign(signedBy === "google" ? google.privateKey : foreign.privateKey);
  };

  return {
    token,
    /** The served key set, for a verifier given its keys directly. */
    keys: createLocalJWKSet(keySet),
    /**
     * Sets how Google's certificate URL answers. Verification caches a
     * served key set, so an outage shows only before the first success.
     */
    serve: (next: GoogleCertificatesState) => {
      state = next;
    },
    restore: () => fetchSpy.mockRestore(),
  };
};
