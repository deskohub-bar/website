import "@/shared/testing/workspace-test-env";

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { CallerContextLive } from "@deskohub/workspace-backend";
import {
  type AnonymousCaller,
  Caller,
  CampaignUnsubscribeRejected,
  EmailPreferencesRpcs,
  MarketingManagementAccessToken,
  WorkspaceRpcSerialization,
} from "@deskohub/workspace-rpc";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcServer } from "effect/rpc";

const apiOrigin = "https://workspace-api.test";
const googleProject = "example-sandbox";
const signedToken = `${Buffer.from(JSON.stringify(["send-synthetic", "customer-synthetic"])).toString("base64url")}.${"s".repeat(43)}`;
const managementToken = MarketingManagementAccessToken.make("A".repeat(43));
const browserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";
const subjectToken = "synthetic-vercel-identity";
const idToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.c2ln`;

mock.module("@vercel/oidc", () => ({
  getVercelOidcToken: async () => subjectToken,
}));

const { GET, POST } = await import("./route");

let completeWithdrawal = Promise.resolve();
let onWithdrawalStarted = () => {};
let withdrawals = 0;
let requests: Request[] = [];
let unexpectedResponse: Response | undefined;
let openCaller: AnonymousCaller | undefined;
let unavailable = false;

const rpcServer = HttpRouter.toWebHandler(
  RpcServer.layerHttp({
    group: EmailPreferencesRpcs,
    path: "/rpc",
    protocol: "http",
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceRpcSerialization,
        EmailPreferencesRpcs.toLayer(
          EmailPreferencesRpcs.of({
            "EmailPreferences.openPreferences": ({ token }) =>
              Effect.gen(function* () {
                openCaller = yield* Caller;
                if (unavailable)
                  return yield* Effect.die(
                    new Error("Synthetic database unavailable")
                  );
                if (token !== signedToken)
                  return yield* new CampaignUnsubscribeRejected();
                return { accessToken: managementToken };
              }),
            "EmailPreferences.unsubscribeOneClick": () =>
              Effect.promise(async () => {
                onWithdrawalStarted();
                await completeWithdrawal;
                withdrawals += 1;
                return withdrawals === 1 ? "withdrawn" : "unchanged";
              }),
          })
        ),
        CallerContextLive,
        HttpServer.layerServices
      )
    )
  ),
  { disableLogger: true }
);

const originalFetch = globalThis.fetch;

beforeAll(() => {
  Object.assign(process.env, {
    WORKSPACE_EMAIL_PREFERENCES_TRANSPORT: "rpc",
    WORKSPACE_API_ORIGIN: apiOrigin,
    WORKSPACE_GCP_PROJECT_NUMBER: "123456789",
    WORKSPACE_WIF_POOL: "workspace-vercel",
    WORKSPACE_WIF_PROVIDER: "vercel",
    WORKSPACE_FRONTEND_SERVICE_ACCOUNT: `workspace-frontend@${googleProject}.iam.gserviceaccount.com`,
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      switch (url.origin) {
        case "https://sts.googleapis.com":
          return Response.json({
            access_token: "synthetic-federated-token",
            expires_in: 3600,
            token_type: "Bearer",
          });
        case "https://iamcredentials.googleapis.com":
          return Response.json({ token: idToken });
        case apiOrigin:
          requests.push(request.clone());
          return unexpectedResponse ?? rpcServer.handler(request);
        default:
          throw new Error(`Unexpected HTTP origin ${url.origin}`);
      }
    },
    { preconnect: originalFetch.preconnect }
  );
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKSPACE_EMAIL_PREFERENCES_TRANSPORT;
  delete process.env.WORKSPACE_API_ORIGIN;
  delete process.env.WORKSPACE_GCP_PROJECT_NUMBER;
  delete process.env.WORKSPACE_WIF_POOL;
  delete process.env.WORKSPACE_WIF_PROVIDER;
  delete process.env.WORKSPACE_FRONTEND_SERVICE_ACCOUNT;
  await rpcServer.dispose();
});

const unsubscribeRequest = (token: string, init?: RequestInit) =>
  new Request(
    `https://workspace.deskohub.test/api/email-campaigns/unsubscribe?token=${encodeURIComponent(token)}`,
    init
  );

test("redirects to localized preferences and forwards the signed token only in the RPC body", async () => {
  requests = [];
  const response = await GET(
    unsubscribeRequest(signedToken, {
      headers: {
        "accept-language": "de-DE",
        authorization: "browser-authorization",
        cookie: "browser-session=synthetic",
        "user-agent": browserUserAgent,
        "x-deskohub-correlation-id": "browser-chosen-id",
        "x-forwarded-for": "192.0.2.11",
        "x-vercel-forwarded-for": "198.51.100.11",
      },
    })
  );

  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.pathname).toBe("/de-DE/marketing-preferences/access");
  expect(location.searchParams.get("token")).toBe(managementToken);
  expect(requests).toHaveLength(1);
  const [forwarded] = requests;
  expect(forwarded.url).toBe(`${apiOrigin}/rpc`);
  expect(forwarded.headers.get("authorization")).toBe(`Bearer ${idToken}`);
  expect(forwarded.headers.has("cookie")).toBeFalse();
  expect(forwarded.headers.has("x-forwarded-for")).toBeFalse();
  expect(JSON.stringify([...forwarded.headers])).not.toContain(signedToken);
  expect(await forwarded.text()).toContain(signedToken);
  expect(openCaller).toMatchObject({
    correlationId: expect.stringMatching(/^[\da-f-]{36}$/),
    locale: "de-DE",
    clientAddress: Option.some("198.51.100.11"),
    userAgent: Option.some(browserUserAgent),
  });
});

test("answers 400 before dispatch for a malformed token", async () => {
  requests = [];
  const response = await GET(unsubscribeRequest("malformed"));

  expect(response.status).toBe(400);
  expect(requests).toHaveLength(0);
});

test("finishes the one-click withdrawal after the client aborts", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  onWithdrawalStarted = started.resolve;
  completeWithdrawal = finish.promise;
  const controller = new AbortController();
  const response = POST(
    unsubscribeRequest(signedToken, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
      signal: controller.signal,
    })
  );

  await started.promise;
  controller.abort();
  finish.resolve();

  expect(await (await response).json()).toEqual({ status: "unsubscribed" });
  expect(withdrawals).toBe(1);
});

test("maps a server-side dependency failure to the existing public error", async () => {
  unavailable = true;
  try {
    const response = await GET(unsubscribeRequest(signedToken));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Marketing preferences could not be opened.",
    });
  } finally {
    unavailable = false;
  }
});

test.each([403, 200])(
  "maps a non-RPC HTTP %i response to the existing public error",
  async (status) => {
    requests = [];
    unexpectedResponse = new Response("upstream HTML", {
      status,
      headers: { "content-type": "text/html" },
    });
    try {
      const response = await GET(unsubscribeRequest(signedToken));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Marketing preferences could not be opened.",
      });
      expect(requests).toHaveLength(1);
    } finally {
      unexpectedResponse = undefined;
    }
  }
);
