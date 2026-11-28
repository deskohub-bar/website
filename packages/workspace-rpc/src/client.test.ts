import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import {
  BackendUnavailable,
  Caller,
  CallerContext,
  CampaignUnsubscribeRejected,
  CampaignUnsubscribeToken,
  decodeCallerHeaders,
  EmailPreferencesRpcs,
  layerCallerContextClient,
  layerWorkspaceRpcProtocol,
  MarketingManagementAccessToken,
  makeWorkspaceRpcClient,
  WorkspaceRpcSerialization,
} from "./index";

const payload = {
  token: CampaignUnsubscribeToken.make("synthetic-unsubscribe"),
};
const grant = {
  accessToken: MarketingManagementAccessToken.make(
    "synthetic-management-grant"
  ),
};
const caller = {
  correlationId: "72823c14-d2de-4a19-94ec-8b70ad590242",
  locale: "cs-CZ",
  clientAddress: Option.some("192.0.2.60"),
  userAgent: Option.some(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
  ),
} satisfies typeof Caller.Service;

const callerLayer = Layer.succeed(CallerContext)((effect, { headers }) =>
  decodeCallerHeaders(headers).pipe(
    Effect.flatMap((value) => Effect.provideService(effect, Caller, value))
  )
);

const handlers = EmailPreferencesRpcs.of({
  "EmailPreferences.openPreferences": ({ token }) =>
    Effect.gen(function* () {
      expect(yield* Caller).toEqual(caller);
      return token === payload.token
        ? grant
        : yield* new CampaignUnsubscribeRejected();
    }),
  "EmailPreferences.unsubscribeOneClick": () => Effect.succeed("withdrawn"),
});

const makeTestServer = (
  testHandlers = EmailPreferencesRpcs.toLayer(handlers)
) =>
  HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: EmailPreferencesRpcs,
      path: "/rpc",
      protocol: "http",
      disableFatalDefects: true,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(callerLayer, testHandlers, WorkspaceRpcSerialization)
      )
    )
  );

type Client = Effect.Success<ReturnType<typeof makeWorkspaceRpcClient>>;

const runClient = <A, E>(
  call: (client: Client) => Effect.Effect<A, E>,
  onFetch: (
    request: Request,
    init?: RequestInit
  ) => Response | Promise<Response>,
  authorization: Effect.Effect<
    Redacted.Redacted<string>,
    BackendUnavailable
  > = Effect.succeed(Redacted.make("synthetic-id-token")),
  invalidateAuthorization: (
    token: Redacted.Redacted<string>
  ) => Effect.Effect<void> = () => Effect.void,
  signal?: AbortSignal
) => {
  const fetchStub = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      onFetch(new Request(input, init), init),
    { preconnect: () => {} }
  );
  const protocol = layerWorkspaceRpcProtocol({
    url: "https://workspace.invalid/",
    authorization,
    invalidateAuthorization,
  }).pipe(Layer.provide(FetchHttpClient.layer));
  return Effect.runPromise(
    makeWorkspaceRpcClient().pipe(
      Effect.flatMap(call),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(protocol, layerCallerContextClient(caller))
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetchStub)
    ),
    { signal }
  );
};

const rpcContentType = "application/vnd.effect.rpc+schema-binary";

describe("Workspace RPC HTTP client", () => {
  test("sends a plain RPC URL and transports only validated caller metadata and token payloads", async () => {
    const server = makeTestServer();
    try {
      const result = await runClient(
        (client) => client.openPreferences(payload),
        async (request, init) => {
          expect(request.url).toEqual("https://workspace.invalid/rpc");
          expect(request.method).toBe("POST");
          expect(init?.redirect).toBe("manual");
          expect(request.headers.get("authorization")).toBe(
            "Bearer synthetic-id-token"
          );
          expect(request.headers.get("content-type")).toBe(rpcContentType);
          expect([...request.headers.values()].join(" ")).not.toContain(
            payload.token
          );
          expect(request.headers.get("x-deskohub-correlation-id")).toBeNull();
          request.headers.set("user-agent", "transport default");
          return server.handler(request);
        }
      );
      expect(result).toEqual(grant);
    } finally {
      await server.dispose();
    }
  });

  test("keeps declared campaign rejection as a typed failure", async () => {
    const server = makeTestServer();
    try {
      const failure = await runClient(
        (client) =>
          Effect.flip(
            client.openPreferences({
              token: CampaignUnsubscribeToken.make(""),
            })
          ),
        (request) => server.handler(request)
      );
      expect(failure).toBeInstanceOf(CampaignUnsubscribeRejected);
    } finally {
      await server.dispose();
    }
  });

  test("rejects a caller header injected at the HTTP transport boundary", async () => {
    const server = makeTestServer();
    try {
      const failure = await runClient(
        (client) => Effect.flip(client.openPreferences(payload)),
        (request) => {
          request.headers.set("x-deskohub-locale", caller.locale);
          return server.handler(request);
        }
      );
      expect(failure).toEqual(new BackendUnavailable({ reason: "caller" }));
    } finally {
      await server.dispose();
    }
  });

  for (const [status, contentType, reason] of [
    [429, rpcContentType, "http-status"],
    [503, "text/html", "http-status"],
    [200, "application/json", "content-type"],
    [200, `${rpcContentType}; charset=utf-8, text/html`, "content-type"],
  ] as const) {
    test(`rejects HTTP ${status} ${contentType} before reading the body`, async () => {
      let cancelled = false;
      const failure = await runClient(
        (client) => Effect.flip(client.openPreferences(payload)),
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status, headers: { "content-type": contentType } }
          )
      );
      expect(failure).toEqual(new BackendUnavailable({ reason, status }));
      expect(cancelled).toBe(true);
    });
  }

  test("maps a broken frame to backend unavailable", async () => {
    const failure = await runClient(
      (client) => Effect.flip(client.openPreferences(payload)),
      () =>
        new Response("bad frame", {
          headers: { "content-type": rpcContentType },
        })
    );
    expect(failure).toEqual(new BackendUnavailable({ reason: "protocol" }));
  });

  test("maps a schema decode defect in an otherwise valid exit frame", async () => {
    const serialization = Effect.runSync(
      RpcSerialization.RpcSerialization.pipe(
        Effect.provide(WorkspaceRpcSerialization)
      )
    );
    const server = makeTestServer();
    try {
      const failure = await runClient(
        (client) => Effect.flip(client.openPreferences(payload)),
        async (request) => {
          const reply = await server.handler(request);
          const parser = serialization.makeUnsafe();
          const [frame] = parser.decode(
            new Uint8Array(await reply.arrayBuffer())
          );
          const envelope = Schema.decodeUnknownSync(RpcMessage.EncodedSchema)(
            frame
          );
          if (envelope._tag !== "Exit")
            throw new Error("Expected an exit frame");
          const encoded = parser.encode({
            ...envelope,
            exit: Uint8Array.of(255),
          });
          if (!(encoded instanceof Uint8Array))
            throw new Error("Expected binary response");
          return new Response(new Uint8Array(encoded), {
            headers: { "content-type": rpcContentType },
          });
        }
      );
      expect(failure).toEqual(new BackendUnavailable({ reason: "protocol" }));
    } finally {
      await server.dispose();
    }
  });

  test("preserves unexpected RPC defects with an opaque diagnostic", async () => {
    const server = makeTestServer(
      EmailPreferencesRpcs.toLayer({
        ...handlers,
        "EmailPreferences.openPreferences": () =>
          Effect.die(new Error("synthetic private backend detail")),
      })
    );
    try {
      const exit = await runClient(
        (client) => Effect.exit(client.openPreferences(payload)),
        (request) => server.handler(request)
      );
      if (Exit.isSuccess(exit)) throw new Error("Expected a failed RPC exit");
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toMatchObject({
        message: "Unexpected Workspace RPC defect",
      });
    } finally {
      await server.dispose();
    }
  });

  test("preserves campaign rejection when the exit also contains a defect", async () => {
    const server = makeTestServer(
      EmailPreferencesRpcs.toLayer({
        ...handlers,
        "EmailPreferences.openPreferences": () =>
          Effect.failCause(
            Cause.fromReasons([
              Cause.makeFailReason(new CampaignUnsubscribeRejected()),
              Cause.makeDieReason(
                new Error("synthetic private backend detail")
              ),
            ])
          ),
      })
    );
    try {
      const exit = await runClient(
        (client) => Effect.exit(client.openPreferences(payload)),
        (request) => server.handler(request)
      );
      if (Exit.isSuccess(exit)) throw new Error("Expected a failed RPC exit");
      expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
        CampaignUnsubscribeRejected
      );
      expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toMatchObject({
        message: "Unexpected Workspace RPC defect",
      });
      expect(exit.cause.reasons).toHaveLength(2);
    } finally {
      await server.dispose();
    }
  });

  test("maps a failed token mint without issuing an HTTP request", async () => {
    const error = new BackendUnavailable({ reason: "authorization" });
    const failure = await runClient(
      (client) => Effect.flip(client.openPreferences(payload)),
      () => {
        throw new Error("Unexpected RPC HTTP request");
      },
      Effect.fail(error)
    );
    expect(failure).toBe(error);
  });

  test("preserves an interrupted call", async () => {
    const exit = await runClient(
      (client) => Effect.exit(client.openPreferences(payload)),
      () => {
        throw new Error("Unexpected RPC HTTP request");
      },
      Effect.interrupt
    );
    if (Exit.isSuccess(exit))
      throw new Error("Expected an interrupted RPC exit");
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(false);
    expect(Cause.hasDies(exit.cause)).toBe(false);
  });

  test("evicts the rejected token and retries the same one-click request once", async () => {
    let minted = 0;
    const evicted: string[] = [];
    const sent: ArrayBuffer[] = [];
    const server = makeTestServer();
    try {
      const result = await runClient(
        (client) => client.unsubscribeOneClick(payload),
        async (request) => {
          sent.push(await request.clone().arrayBuffer());
          if (
            request.headers.get("authorization") === "Bearer synthetic-id-1"
          ) {
            return new Response("rejected", { status: 401 });
          }
          return server.handler(request);
        },
        Effect.sync(() => Redacted.make(`synthetic-id-${++minted}`)),
        (token) =>
          Effect.sync(() => {
            evicted.push(Redacted.value(token));
          })
      );
      expect(result).toBe("withdrawn");
      expect(evicted).toEqual(["synthetic-id-1"]);
      expect(minted).toBe(2);
      expect(sent[0]).toEqual(sent[1]);
    } finally {
      await server.dispose();
    }
  });

  test("evicts an ambiguously rejected token without replaying token issuance", async () => {
    let attempt = 0;
    const evicted: string[] = [];
    const failure = await runClient(
      (client) => Effect.flip(client.openPreferences(payload)),
      () => {
        attempt++;
        return new Response("rejected", { status: 401 });
      },
      undefined,
      (token) =>
        Effect.sync(() => {
          evicted.push(Redacted.value(token));
        })
    );
    expect(failure).toEqual(
      new BackendUnavailable({ reason: "http-status", status: 401 })
    );
    expect(evicted).toEqual(["synthetic-id-token"]);
    expect(attempt).toBe(1);
  });

  test("401 eviction is committed before canceling the response body", async () => {
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const controller = new AbortController();
    const token = Redacted.make("synthetic-rejected-id");
    const evicted: Redacted.Redacted<string>[] = [];
    const outcome = runClient(
      (client) => client.openPreferences(payload),
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cleanupStarted.resolve();
              return releaseCleanup.promise;
            },
          }),
          { status: 401 }
        ),
      Effect.succeed(token),
      (rejected) =>
        Effect.sync(() => {
          evicted.push(rejected);
        }),
      controller.signal
    ).then(Exit.succeed, Exit.die);

    try {
      await cleanupStarted.promise;
      controller.abort();
      expect(Exit.isFailure(await outcome)).toBe(true);
      expect(evicted).toHaveLength(1);
      expect(evicted[0]).toBe(token);
    } finally {
      releaseCleanup.resolve();
    }
  });

  test("evicts both rejected token identities after two one-click 401 responses", async () => {
    const tokens = [
      Redacted.make("synthetic-id-1"),
      Redacted.make("synthetic-id-2"),
    ];
    const evicted: Redacted.Redacted<string>[] = [];
    let minted = 0;
    let sent = 0;
    const failure = await runClient(
      (client) => Effect.flip(client.unsubscribeOneClick(payload)),
      () => {
        sent++;
        return new Response("denied", { status: 401 });
      },
      Effect.sync(() => {
        const token = tokens[minted++];
        if (!token) throw new Error("Unexpected mint");
        return token;
      }),
      (token) =>
        Effect.sync(() => {
          evicted.push(token);
        })
    );
    expect(failure).toEqual(
      new BackendUnavailable({ reason: "http-status", status: 401 })
    );
    expect(evicted).toHaveLength(2);
    expect(evicted[0]).toBe(tokens[0]);
    expect(evicted[1]).toBe(tokens[1]);
    expect(minted).toBe(2);
    expect(sent).toBe(2);
  });

  test("a Google front end 403 does not evict authorization or replay one-click", async () => {
    let sent = 0;
    let evicted = false;
    const failure = await runClient(
      (client) => Effect.flip(client.unsubscribeOneClick(payload)),
      () => {
        sent++;
        return new Response("denied", {
          status: 403,
          headers: { server: "Google Frontend", "content-type": "text/html" },
        });
      },
      undefined,
      () =>
        Effect.sync(() => {
          evicted = true;
        })
    );
    expect(failure).toEqual(
      new BackendUnavailable({ reason: "http-status", status: 403 })
    );
    expect(sent).toBe(1);
    expect(evicted).toBe(false);
  });

  test("can surface a Google front end denial after issuance without replaying", async () => {
    const server = makeTestServer();
    let dispatches = 0;
    try {
      const failure = await runClient(
        (client) => Effect.flip(client.openPreferences(payload)),
        async (request) => {
          const reply = await server.handler(request);
          await reply.arrayBuffer();
          expect(reply.status).toBe(200);
          dispatches++;
          return new Response("denied", {
            status: 403,
            headers: { server: "Google Frontend", "content-type": "text/html" },
          });
        }
      );
      expect(failure).toEqual(
        new BackendUnavailable({ reason: "http-status", status: 403 })
      );
      expect(dispatches).toBe(1);
    } finally {
      await server.dispose();
    }
  });

  test("a broken response leaves another logical client's pending call intact", async () => {
    const server = makeTestServer();
    const goodRequestArrived = Promise.withResolvers<void>();
    const releaseGoodResponse = Promise.withResolvers<void>();
    let calls = 0;
    const fetchStub = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (calls++ === 0) {
          goodRequestArrived.resolve();
          await releaseGoodResponse.promise;
          return server.handler(request);
        }
        return new Response("bad frame", {
          headers: { "content-type": rpcContentType },
        });
      },
      { preconnect: () => {} }
    );
    const protocol = layerWorkspaceRpcProtocol({
      url: "https://workspace.invalid/",
      authorization: Effect.succeed(Redacted.make("synthetic-id-token")),
      invalidateAuthorization: () => Effect.void,
    }).pipe(Layer.provide(FetchHttpClient.layer));
    try {
      const [success, failure] = await Effect.runPromise(
        Effect.gen(function* () {
          const first = yield* makeWorkspaceRpcClient();
          const second = yield* makeWorkspaceRpcClient();
          return yield* Effect.all(
            [
              first.openPreferences(payload),
              Effect.promise(() => goodRequestArrived.promise).pipe(
                Effect.andThen(Effect.flip(second.openPreferences(payload))),
                Effect.ensuring(
                  Effect.sync(() => releaseGoodResponse.resolve())
                )
              ),
            ],
            { concurrency: "unbounded" }
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(protocol, layerCallerContextClient(caller))
          ),
          Effect.provideService(FetchHttpClient.Fetch, fetchStub)
        )
      );
      expect(success).toEqual(grant);
      expect(failure).toEqual(new BackendUnavailable({ reason: "protocol" }));
    } finally {
      releaseGoodResponse.resolve();
      await server.dispose();
    }
  });
});
