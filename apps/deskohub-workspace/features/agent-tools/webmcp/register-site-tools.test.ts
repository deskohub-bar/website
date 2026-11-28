import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { m } from "@/features/i18n";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { registerSiteTools } from "./register-site-tools";
import {
  agentToolEventStream,
  installFakeModelContext,
  mockAgentToolEndpoint,
  pendingBodyResponse,
  publishedAgentTools,
  publishedFundedQuoteTool,
  recordUnhandledRejections,
} from "./webmcp.test-utils";

let modelContext: ReturnType<typeof installFakeModelContext>;
let endpoint: ReturnType<typeof mockAgentToolEndpoint>;

const register = (signal = new AbortController().signal) =>
  registerSiteTools({
    locale: "cs-CZ",
    modelContext: modelContext.context,
    signal,
  });

describe("registerSiteTools", () => {
  beforeAll(() => {
    registerWorkspaceComponentTestEnv();
  });

  beforeEach(() => {
    modelContext = installFakeModelContext();
    endpoint = mockAgentToolEndpoint();
  });

  afterEach(() => {
    modelContext.uninstall();
    endpoint.restore();
  });

  afterAll(async () => {
    await unregisterWorkspaceComponentTestEnv();
  });

  test("lists the tools once and registers each read-only, with its published schema and a localized title", async () => {
    await register();

    expect(endpoint.requests.map(({ method }) => method)).toEqual([
      "tools/list",
    ]);
    expect(
      [...modelContext.registered.values()].map(({ tool }) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }))
    ).toEqual([
      {
        name: "list_offerings",
        title: m.siteToolListOfferingsTitle({}, { locale: "cs-CZ" }),
        description: publishedAgentTools[0].description,
        inputSchema: publishedAgentTools[0].inputSchema,
        annotations: { readOnlyHint: true },
      },
      {
        name: "check_availability",
        title: m.siteToolCheckAvailabilityTitle({}, { locale: "cs-CZ" }),
        description: publishedAgentTools[1].description,
        inputSchema: publishedAgentTools[1].inputSchema,
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_quote",
        title: m.siteToolGetQuoteTitle({}, { locale: "cs-CZ" }),
        description: publishedAgentTools[2].description,
        inputSchema: publishedAgentTools[2].inputSchema,
        annotations: { readOnlyHint: true },
      },
    ]);
  });

  test("registers neither signed-in tools, which need a token the page doesn't send, nor a tool that renders an MCP Apps view", async () => {
    await register();

    expect(
      publishedAgentTools
        .map(({ name }) => name)
        .filter((name) => !modelContext.registered.has(name))
    ).toEqual(["start_reservation", "show_booking"]);
  });

  test("uses the browser session to call pass tools and fetch their quote summaries", async () => {
    const passId = "11111111-1111-4111-8111-111111111111";
    const purchase = {
      ...publishedFundedQuoteTool,
      name: "start_pass_purchase",
      annotations: { readOnlyHint: false },
    };
    endpoint.restore();
    endpoint = mockAgentToolEndpoint(
      ({ params }) =>
        agentToolEventStream({
          structuredContent:
            params.name === "get_quote"
              ? {
                  total: { amount: 0, currency: "CZK" },
                }
              : {
                  pay_url:
                    "https://deskohub.test/en-US/passes/entry-pack?step=pay",
                },
        }),
      ({ path }) =>
        agentToolEventStream({
          tools:
            path === "/api/mcp/web"
              ? [publishedFundedQuoteTool, purchase]
              : [publishedFundedQuoteTool],
        })
    );
    await register();
    expect(endpoint.requests.map(({ path }) => path)).toEqual([
      "/api/mcp",
      "/api/mcp/web",
    ]);
    expect([...modelContext.registered.keys()]).toEqual([
      "get_quote",
      "start_pass_purchase",
    ]);
    const starter = modelContext.getTool("start_pass_purchase");
    expect(starter.annotations).toEqual({
      readOnlyHint: false,
      consequentialHint: true,
    });
    expect(await starter.execute({})).toEqual({
      pay_url: "https://deskohub.test/en-US/passes/entry-pack?step=pay",
    });

    const quote = modelContext.getTool("get_quote");
    expect(await quote.execute({ pass_id: passId })).toEqual({
      total: { amount: 0, currency: "CZK" },
    });
    expect(endpoint.requests.at(-1)?.path).toBe("/api/mcp/web");
    await quote.execute({});
    expect(endpoint.requests.at(-1)?.path).toBe("/api/mcp");
  });

  test("unregisters every tool when the registration aborts", async () => {
    const registration = new AbortController();
    await register(registration.signal);
    expect(modelContext.registered.size).toBe(3);

    registration.abort();

    expect(modelContext.registered.size).toBe(0);
  });

  test("a remount aborting the previous registration leaves one registration per tool and no rejection", async () => {
    const first = new AbortController();
    const firstRun = register(first.signal);
    first.abort();
    const second = new AbortController();
    const secondRun = register(second.signal);

    await expect(firstRun).resolves.toBeUndefined();
    await secondRun;

    expect([...modelContext.registered.keys()]).toEqual([
      "list_offerings",
      "check_availability",
      "get_quote",
    ]);
    // Registering again while every name is live rejects in the browser; the
    // registration reports it instead of throwing.
    await register();
    expect(modelContext.registered.size).toBe(3);
  });

  describe("execute", () => {
    test("calls the tool on /api/mcp with the page locale and returns its structured content", async () => {
      const structuredContent = { business: "DH Workspace", offerings: [] };
      endpoint.restore();
      endpoint = mockAgentToolEndpoint(() =>
        agentToolEventStream({
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        })
      );
      await register();
      const signal = new AbortController().signal;

      const result = await modelContext
        .getTool("check_availability")
        .execute({ family: "cowork", date: "2099-07-30" }, { signal });

      expect(result).toEqual(structuredContent);
      const { method, params } = endpoint.requests.at(-1) ?? {};
      expect({ method, params }).toEqual({
        method: "tools/call",
        params: {
          name: "check_availability",
          arguments: { family: "cowork", date: "2099-07-30", locale: "cs-CZ" },
        },
      });
    });

    test("runs when the browser passes the input alone, as Chrome 151 does", async () => {
      await register();

      await expect(
        modelContext.getTool("list_offerings").execute({})
      ).resolves.toEqual({});
      expect(endpoint.requests.at(-1)?.params).toEqual({
        name: "list_offerings",
        arguments: { locale: "cs-CZ" },
      });
    });

    test("keeps the locale the agent sends", async () => {
      await register();

      await modelContext
        .getTool("list_offerings")
        .execute({ locale: "en-US" }, {});

      expect(endpoint.requests.at(-1)?.params.arguments).toEqual({
        locale: "en-US",
      });
    });

    test("forwards the agent's cancellation to the request", async () => {
      let requestSignal: AbortSignal | null | undefined;
      endpoint.restore();
      endpoint = mockAgentToolEndpoint(
        ({ signal }) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = signal;
            signal?.addEventListener("abort", () => reject(signal.reason));
          })
      );
      await register();
      const call = new AbortController();

      const result = modelContext
        .getTool("list_offerings")
        .execute({}, { signal: call.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      call.abort();

      await expect(result).rejects.toBeDefined();
      expect(requestSignal?.aborted).toBe(true);
    });

    test("forwards the agent's cancellation while the response body is arriving, without a rejection", async () => {
      const unhandled = recordUnhandledRejections();
      const answer = pendingBodyResponse();
      endpoint.restore();
      endpoint = mockAgentToolEndpoint(() => answer.response);
      try {
        await register();
        const call = new AbortController();

        const result = modelContext
          .getTool("list_offerings")
          .execute({}, { signal: call.signal });
        await answer.reading;
        call.abort();

        await expect(result).rejects.toBeDefined();
        expect(endpoint.requests.at(-1)?.signal?.aborted).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled.rejections).toEqual([]);
      } finally {
        unhandled.stop();
      }
    });

    test("returns a tool error as its typed error object", async () => {
      const error = {
        code: "date_out_of_range",
        message: "Vyber datum mezi 2099-07-01 a 2099-07-31.",
        earliest: "2099-07-01",
        latest: "2099-07-31",
      };
      endpoint.restore();
      endpoint = mockAgentToolEndpoint(() =>
        agentToolEventStream({
          content: [{ type: "text", text: error.message }],
          structuredContent: { error },
          isError: true,
        })
      );
      await register();

      await expect(
        modelContext
          .getTool("check_availability")
          .execute({ family: "cowork", date: "2000-01-01" }, {})
      ).resolves.toEqual({ error });
    });

    test.each([403, 429, 500])(
      "rejects an HTTP %p response with a localized Error",
      async (status) => {
        endpoint.restore();
        endpoint = mockAgentToolEndpoint(
          () =>
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Invalid Origin" },
                id: null,
              }),
              { status, headers: { "Content-Type": "application/json" } }
            )
        );
        await register();

        const call = modelContext.getTool("list_offerings").execute({}, {});

        await expect(call).rejects.toBeInstanceOf(Error);
        await expect(call).rejects.toThrow(
          m.siteToolRequestFailed({}, { locale: "cs-CZ" })
        );
      }
    );

    test("reads a JSON body as well as an event stream", async () => {
      endpoint.restore();
      endpoint = mockAgentToolEndpoint(
        () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { structuredContent: { offerings: [] } },
            }),
            { headers: { "Content-Type": "application/json" } }
          )
      );
      await register();

      await expect(
        modelContext.getTool("list_offerings").execute({}, {})
      ).resolves.toEqual({ offerings: [] });
    });
  });
});
