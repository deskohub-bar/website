import { testEmailAddress } from "@deskohub/test-email";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { Effect } from "effect";
import { makeAuthDatabase } from "@/db/auth-database-client";
import {
  authAccount,
  authRateLimit,
  authSession,
  authUser,
  authVerification,
} from "@/db/schema/auth";
import {
  connectWorkspacePostgresTestDatabase,
  requireTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  postgresAuthHookServices,
  testAccountDeletion,
} from "./auth-hook-services.test-utils";
import { type MagicLinkSendFunction, makeWorkspaceAuth } from "./auth-server";

const testDatabase = await connectWorkspacePostgresTestDatabase();

type RecordedCookieOptions = {
  readonly maxAge?: number;
};

type RecordedCookieSet = {
  readonly name: string;
  readonly value: string;
  readonly options?: RecordedCookieOptions;
};

const cookieStoreSets: RecordedCookieSet[] = [];
let requestHeaders = new Headers();

/**
 * Stands in for the Next.js request-scoped cookie store a Server Action
 * would see, so the tests observe the cookies the `nextCookies` plugin
 * forwards for direct `auth.api` calls instead of trusting its presence.
 */
mock.module("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({
    set: (name: string, value: string, options?: RecordedCookieOptions) => {
      cookieStoreSets.push({ name, value, options });
    },
  }),
}));

const SECRET_V1 = Buffer.alloc(48, 31).toString("base64url");
const HOST = "workspace.test";

const makeTestAuth = (sentMagicLinks: { url: string }[] = []) => {
  const database = requireTestDatabase(testDatabase);
  const sendMagicLink: MagicLinkSendFunction = (data) => {
    sentMagicLinks.push({ url: data.url });
  };
  return makeWorkspaceAuth({
    database: drizzleAdapter(makeAuthDatabase(database.pool), {
      provider: "pg",
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
        rateLimit: authRateLimit,
      },
      schemaName: "auth",
    }),
    secrets: [{ version: 1, value: SECRET_V1 }],
    allowedHosts: [HOST],
    nativeAppLinkOrigin: `https://${HOST}`,
    passkeyRelyingParty: { rpID: HOST, origins: [`https://${HOST}`] },
    customerMcpResource: `https://${HOST}/api/mcp`,
    httpsOnly: true,
    sendMagicLink,
    reviewAccountCredentials: [],
    services: postgresAuthHookServices(database, {
      passkeyFlag: Effect.succeed(false),
    }),
    accountDeletion: testAccountDeletion(),
  });
};

const uniqueEmail = (label: string) =>
  testEmailAddress(`${label}-${crypto.randomUUID()}`);

const runIpOctet = Math.floor(Math.random() * 200) + 20;
let ipCounter = 0;
const uniqueIp = () => {
  ipCounter += 1;
  return `172.${runIpOctet}.${ipCounter >> 8}.${ipCounter & 0xff}`;
};

const callHandler = (
  auth: ReturnType<typeof makeTestAuth>,
  path: string,
  init: RequestInit = {}
) => {
  const headers = new Headers({
    origin: `https://${HOST}`,
    host: HOST,
    "x-vercel-forwarded-for": uniqueIp(),
  });
  for (const [key, value] of new Headers(init.headers)) {
    headers.set(key, value);
  }
  return auth.handler(
    new Request(`https://${HOST}/api/auth${path}`, { ...init, headers })
  );
};

const signInAndVerify = async (
  auth: ReturnType<typeof makeTestAuth>,
  sentMagicLinks: { url: string }[],
  email: string
) => {
  await callHandler(auth, "/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const verifyPath = requireValue(
    sentMagicLinks[0],
    "sent magic link"
  ).url.slice(`https://${HOST}/api/auth`.length);
  const verified = await callHandler(auth, verifyPath);
  const sessionCookie = verified.headers
    .getSetCookie()
    .find((entry) => entry.includes("session_token="));
  return requireValue(
    requireValue(sessionCookie, "session cookie").split(";")[0],
    "session cookie pair"
  );
};

const userIdForEmail = async (email: string) => {
  const result = await requireTestDatabase(testDatabase).pool.query<{
    id: string;
  }>(`select id from auth."user" where email = $1`, [email]);
  return result.rows[0]?.id;
};

const sessionExpiresAt = async (email: string) => {
  const result = await requireTestDatabase(testDatabase).pool.query<{
    expires_at: string;
  }>(`select expires_at from auth.session where user_id = $1`, [
    await userIdForEmail(email),
  ]);
  return new Date(
    requireValue(result.rows[0], "session row").expires_at
  ).getTime();
};

const recordedSessionTokenSet = () =>
  cookieStoreSets.find((entry) => entry.name.endsWith("session_token"));

const backdateSession = async (email: string) => {
  await requireTestDatabase(testDatabase).pool.query(
    `update auth.session
        set expires_at = now() + interval '28 days'
      where user_id = (select id from auth."user" where email = $1)`,
    [email]
  );
};

describe.skipIf(!testDatabase)(
  "Better Auth Next.js cookie integration on the migrated disposable Postgres",
  () => {
    test("clears the browser session cookie when the delete-user call runs from a Server Action", async () => {
      const sentMagicLinks: { url: string }[] = [];
      const auth = makeTestAuth(sentMagicLinks);
      const email = uniqueEmail("delete-cookies");
      const cookie = await signInAndVerify(auth, sentMagicLinks, email);

      cookieStoreSets.length = 0;
      await auth.api.deleteUser({
        body: {},
        headers: new Headers({
          origin: `https://${HOST}`,
          host: HOST,
          "content-type": "application/json",
          cookie,
        }),
      });

      const userId = await userIdForEmail(email);
      expect(userId).toBeUndefined();

      const cleared = recordedSessionTokenSet();
      expect(cleared).toBeTruthy();
      const clearedCookie = requireValue(cleared, "cleared session cookie");
      expect(clearedCookie.value).toBe("");
      expect(clearedCookie.options?.maxAge).toBe(0);
    });

    test("defers the rolling refresh on RSC get-session reads that cannot write cookies", async () => {
      const sentMagicLinks: { url: string }[] = [];
      const auth = makeTestAuth(sentMagicLinks);
      const email = uniqueEmail("rsc-defer");
      const cookie = await signInAndVerify(auth, sentMagicLinks, email);
      await backdateSession(email);
      const staleExpiry = await sessionExpiresAt(email);

      cookieStoreSets.length = 0;
      requestHeaders = new Headers({ host: HOST, RSC: "1" });
      const session = await auth.api.getSession({
        headers: new Headers({
          host: HOST,
          RSC: "1",
          cookie,
        }),
      });
      expect(session?.user.email).toBe(email);

      expect(await sessionExpiresAt(email)).toBe(staleExpiry);
      expect(recordedSessionTokenSet()).toBeUndefined();
    });

    test("keeps the refresh-free server read from rolling the session ahead of the browser cookie", async () => {
      const sentMagicLinks: { url: string }[] = [];
      const auth = makeTestAuth(sentMagicLinks);
      const email = uniqueEmail("server-read");
      const cookie = await signInAndVerify(auth, sentMagicLinks, email);
      await backdateSession(email);
      const staleExpiry = await sessionExpiresAt(email);

      // A hard reload carries no `RSC` header, so the header skip cannot
      // protect it: the authoritative server read must not touch the
      // database expiry the browser cannot see a refreshed cookie for.
      requestHeaders = new Headers({ host: HOST });
      const session = await auth.api.getSession({
        query: { disableRefresh: true },
        headers: new Headers({ host: HOST, cookie }),
      });
      expect(session?.user.email).toBe(email);
      expect(await sessionExpiresAt(email)).toBe(staleExpiry);

      // The browser get-session route handler owns the rolling refresh.
      const response = await callHandler(auth, "/get-session", {
        headers: { cookie },
      });
      expect(response.status).toBe(200);

      expect(await sessionExpiresAt(email)).toBeGreaterThan(staleExpiry);
      const refreshedCookie = response.headers
        .getSetCookie()
        .find((entry) => entry.includes("session_token="));
      expect(refreshedCookie).toContain("Max-Age=2592000");
    });
  }
);
