import {
  type CallToolResult,
  createMcpHandler,
  isSpecType,
  McpServer,
  originValidationResponse,
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import {
  Context,
  Effect,
  Exit,
  FiberSet,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { env } from "@/env";
import { scheduleAgentTrafficEvent } from "@/shared/backend/agent-traffic/agent-traffic-events";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import type { RequestBudget } from "@/shared/backend/request-budget/request-budget.service";
import { CurrentAgentTraffic } from "@/shared/backend/workspace-request-context";
import {
  containerPublicOrigin,
  publicUrl,
} from "@/shared/deployment/public-origin";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { currentInstant } from "@/shared/utils/temporal";
import {
  type AgentTool,
  type AgentToolAttachment,
  type AgentToolDownload,
  AgentToolReply,
  CallableAgentTools,
  getCustomerToolScopes,
  getRequestedAgentToolLocale,
} from "./agent-tool";
import { AgentToolAdmission } from "./agent-tool-admission.service";
import {
  BrowserAgentAccount,
  spendBrowserCallBudget,
  spendSignedInCallBudgets,
} from "./agent-tool-call-budget";
import type { AgentToolClient } from "./agent-tool-client";
import {
  AgentToolError,
  type AgentToolErrorCode,
  toAgentToolErrorResult,
} from "./agent-tool-error";
import {
  AgentToolRequestRefused,
  authorizeAgentToolRequest,
  isAgentToolGranted,
} from "./agent-tool-mcp-authorization";
import type { McpRequest } from "./agent-tool-mcp-messages";
import {
  agentToolAccessMetaKey,
  getAgentToolSecuritySchemes,
} from "./agent-tool-metadata";
import {
  agentToolViewMimeType,
  getAgentToolViews,
  getViewLinkMeta,
  getViewResourceMeta,
} from "./agent-tool-view";
import type { CustomerAgentCaller } from "./customer-agent-caller";

/** The version of the tool contract agents see; bump it on breaking changes. */
const agentToolServerVersion = "1.0.0";

/**
 * Rejects a browser request from any origin but the site's own. The SDK
 * compares hostnames only, which on Vercel's HTTPS-only hosts names the
 * origin, and lets an empty Origin through. A container's own host may also
 * answer on other schemes or ports, so there any Origin a request carries
 * must be its public origin exactly; a request without one stays allowed.
 * The rejection has the SDK's own shape.
 */
const originRejection = (request: Request): Response | undefined => {
  const siteUrl = publicUrl(request.url);
  const origin = request.headers.get("origin");
  if (
    containerPublicOrigin(env) &&
    origin !== null &&
    origin !== siteUrl.origin
  ) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: `Invalid Origin: ${origin}` },
        id: null,
      },
      { status: 403 }
    );
  }
  return originValidationResponse(request, [siteUrl.hostname]);
};

/**
 * Answers one MCP request with a set of agent tools: stateless Streamable
 * HTTP with a fresh server per request. Tools emit no progress messages, so
 * the SDK answers 2026-era calls with JSON. A browser may call only from the
 * host that serves the request, so a request whose `Origin` names another
 * site is rejected with 403. Clients that send no `Origin`, such as hosted
 * agent connectors, are served.
 *
 * The host comes from the request itself, so every domain and alias of the
 * deployment serves its own pages. That guards against DNS rebinding only
 * where the platform routes no foreign hostname to the deployment, as Vercel
 * routes only a project's own domains.
 *
 * The caller passes the tools to serve and the server instructions, both
 * chosen for the request's client (`customerAgentCatalog`), and the client
 * also chooses the view's `_meta`. Everything else follows from each tool's
 * own definition, so tools added beside the customer tools are served as
 * they are.
 *
 * An agent may send an OAuth bearer token. A token that grants nothing,
 * or a signed-in tool called without a token granting its scope, is answered
 * with a 401 or 403 OAuth challenge before the MCP server runs. Every tool
 * publishes its access in `_meta`, and a call can read which tools its
 * caller may call through `CallableAgentTools`.
 *
 * The views tools render in are served as MCP Apps `ui://` resources. The
 * server can't see which clients render them, so tools always link their
 * view, and every result stays complete without it.
 *
 * `callerTools` adds the tools only the request's caller may see, after
 * its token is verified and before any called tool is authorized; they are
 * listed after `tools`. Its failure fails the request.
 *
 * Tool calls run as fibers of the returned Effect, so they share its
 * services, request context, and trace, and are interrupted with it.
 */
export const answerAgentToolMcpRequest = <
  R,
  RCaller = never,
  E = never,
  RCallerTools = never,
>({
  tools,
  instructions,
  callerTools,
  client,
  request,
}: {
  readonly tools: ReadonlyArray<AgentTool<R>>;
  readonly instructions: string;
  readonly callerTools?: (
    caller: Option.Option<CustomerAgentCaller>
  ) => Effect.Effect<ReadonlyArray<AgentTool<RCaller>>, E, RCallerTools>;
  readonly client: AgentToolClient;
  readonly request: McpRequest;
}) =>
  // One Effect type for both branches, so callers can handle its errors.
  Effect.suspend(() =>
    Option.fromNullishOr(originRejection(request.request)).pipe(
      Option.match({
        onSome: (rejection) =>
          Effect.logWarning(
            "Agent tool MCP request from another origin was rejected"
          ).pipe(Effect.as(rejection)),
        onNone: () =>
          authorizeAgentToolRequest<AgentTool<R | RCaller>, E, RCallerTools>({
            tools,
            callerTools,
            request,
          }).pipe(
            Effect.flatMap(({ caller, tools: served }) =>
              serveAgentToolMcpRequest({
                tools: served,
                instructions,
                client,
                request: request.request,
                caller,
              })
            ),
            Effect.catchIf(
              (error) => error instanceof AgentToolRequestRefused,
              ({ response }) => Effect.succeed(response)
            )
          ),
      })
    )
  );

/**
 * Serves the request in a scope that stays open until its response body ends
 * or the client cancels it: a 2025-era call answers with an event stream
 * before the tool has finished, and closing the scope interrupts the tool.
 */
const serveAgentToolMcpRequest = <R>(exchange: McpExchange<R>) =>
  Effect.Do.pipe(
    Effect.bind("scope", () => Scope.make()),
    Effect.bind("response", ({ scope }) =>
      exchangeAgentToolMcpRequest(exchange).pipe(
        Scope.provide(scope),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit)
        )
      )
    ),
    Effect.flatMap(closeScopeAfterBody)
  );

/** The browser transport is already authenticated by the WebMCP route. */
export const serveBrowserAgentToolMcpRequest = <R>({
  tools,
  request,
}: {
  readonly tools: ReadonlyArray<AgentTool<R>>;
  readonly request: Request;
}) =>
  serveAgentToolMcpRequest({
    tools,
    request,
    instructions: "",
    client: "other",
    caller: Option.none(),
  });

/** One MCP request and the tools and caller it is served with. */
type McpExchange<R> = {
  readonly tools: ReadonlyArray<AgentTool<R>>;
  readonly instructions: string;
  readonly client: AgentToolClient;
  readonly request: Request;
  readonly caller: Option.Option<CustomerAgentCaller>;
};

type ToolCallServices<R> =
  | Exclude<R, CallableAgentTools>
  | AgentToolAdmission
  | RequestBudget;

const exchangeAgentToolMcpRequest = <R>({
  tools,
  instructions,
  client,
  request,
  caller,
}: McpExchange<R>) =>
  Effect.Do.pipe(
    Effect.bind("runInRequest", () =>
      FiberSet.makeRuntimePromise<ToolCallServices<R>>()
    ),
    Effect.bind("siteOrigin", () => getWorkspaceRuntimeCallbackOrigin),
    Effect.bind("handler", ({ runInRequest, siteOrigin }) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          createMcpHandler(
            () =>
              makeAgentToolMcpServer({
                tools,
                instructions,
                client,
                headers: request.headers,
                caller,
                siteOrigin: siteOrigin.origin,
                runInRequest,
              }),
            {
              onerror: (cause) =>
                void runInRequest(
                  Effect.logError("Agent tool MCP request failed", { cause })
                ),
            }
          )
        ),
        (handler) => Effect.promise(() => handler.close())
      )
    ),
    Effect.flatMap(({ handler }) =>
      Effect.tryPromise(() => handler.fetch(request))
    )
  );

/** The response, with `scope` closed once its body ends or is cancelled. */
const closeScopeAfterBody = ({
  scope,
  response,
}: {
  readonly scope: Scope.Closeable;
  readonly response: Response;
}) =>
  Option.fromNullishOr(response.body).pipe(
    Option.match({
      onNone: () => Scope.close(scope, Exit.void).pipe(Effect.as(response)),
      onSome: (body) =>
        Effect.succeed(
          new Response(
            Stream.fromReadableStream({
              evaluate: () => body,
              onError: (cause) => cause,
            }).pipe(
              Stream.ensuring(Scope.close(scope, Exit.void)),
              Stream.toReadableStreamWith(Context.empty())
            ),
            response
          )
        ),
    })
  );

/** Runs an Effect as a fiber of the request that serves the MCP exchange. */
type RequestRunner<R> = <A>(
  effect: Effect.Effect<A, never, R>,
  options?: Effect.RunOptions
) => Promise<A>;

const makeAgentToolMcpServer = <R>({
  tools,
  instructions,
  client,
  headers,
  caller,
  siteOrigin,
  runInRequest,
}: {
  readonly tools: ReadonlyArray<AgentTool<R>>;
  readonly instructions: string;
  readonly client: AgentToolClient;
  readonly headers: Headers;
  readonly caller: Option.Option<CustomerAgentCaller>;
  readonly siteOrigin: string;
  readonly runInRequest: RequestRunner<ToolCallServices<R>>;
}) => {
  const server = new McpServer(
    {
      name: "dh-workspace",
      title: workspaceSiteConstants.brand.name,
      version: agentToolServerVersion,
      websiteUrl: siteOrigin,
      icons: [
        {
          src: new URL("/favicon.png", siteOrigin).toString(),
          mimeType: "image/png",
          sizes: ["512x512"],
        },
        {
          src: new URL("/favicon.svg", siteOrigin).toString(),
          mimeType: "image/svg+xml",
          sizes: ["any"],
        },
      ],
    },
    { instructions }
  );
  for (const view of getAgentToolViews(tools)) {
    const resourceMeta = getViewResourceMeta({ view, siteOrigin, client });
    server.registerResource(
      view.name,
      view.uri,
      {
        title: view.title,
        description: view.description,
        mimeType: agentToolViewMimeType,
        _meta: resourceMeta,
      },
      () => ({
        contents: [
          {
            uri: view.uri,
            mimeType: agentToolViewMimeType,
            text: view.html,
            _meta: resourceMeta,
          },
        ],
      })
    );
  }
  const callable = new Set(
    tools.filter((tool) => isAgentToolGranted(tool, caller)).map(toName)
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: acceptArguments(tool.input),
        outputSchema: tool.output,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? tool.readOnly,
          openWorldHint: false,
        },
        _meta: {
          [agentToolAccessMetaKey]: tool.access,
          securitySchemes: getAgentToolSecuritySchemes(tool),
          ...(tool.view && getViewLinkMeta(tool.view)),
        },
      },
      (args, context) =>
        runInRequest(callAgentTool({ tool, args, headers, caller, callable }), {
          signal: context.mcpReq.signal,
        })
    );
  }
  listSecuritySchemes(server);
  return server;
};

const parseJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown)
);

/** A value as JSON carries it: undefined members dropped, non-finite numbers null. */
const toWireJson = <Value>(value: Value) => parseJson(JSON.stringify(value));

/**
 * Lists each tool's `securitySchemes` beside its definition as well as in
 * its `_meta`, where ChatGPT reads it: the SDK's `tools/list` keeps only
 * the definition fields it knows, so the listing is wrapped. The SDK keeps
 * the stored handler protected; a route test pins both protocol eras.
 */
/**
 * The SDK's lookup of a stored request handler. It is protected, and
 * TypeScript lets only element access reach a protected member.
 */
const storedRequestHandlerLookup = "_getRequestHandler";

const listSecuritySchemes = (server: McpServer) => {
  const listTools = server.server[storedRequestHandlerLookup]("tools/list");
  if (listTools === undefined) return;
  server.server.setRequestHandler("tools/list", async (request, context) => {
    // The stored handler is typed for any method. Its listing is checked as
    // the wire carries it, so a listing the wire would send still passes.
    const listed = toWireJson(
      await listTools({ jsonrpc: "2.0", id: 0, ...request }, context)
    );
    // A non-object outputSchema is spec-invalid and now fails the listing.
    if (!isSpecType.ListToolsResult(listed)) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        "The tool listing isn't a tools/list result."
      );
    }
    return {
      ...listed,
      tools: listed.tools.map((tool) => ({
        ...tool,
        securitySchemes: tool._meta?.securitySchemes,
      })),
    };
  });
};

const toName = ({ name }: { readonly name: string }) => name;

const jsonArguments = Schema.toStandardSchemaV1(Schema.Json);

/**
 * Publishes the tool's input JSON Schema but checks only that the arguments
 * are JSON, leaving validation to the tool: it answers invalid arguments with
 * a typed, localized error instead of the SDK's English message.
 */
const acceptArguments = (
  input: StandardJSONSchemaV1
): StandardSchemaWithJSON<Schema.Json, Schema.Json> => ({
  "~standard": {
    version: 1,
    vendor: input["~standard"].vendor,
    jsonSchema: input["~standard"].jsonSchema,
    validate: jsonArguments["~standard"].validate,
  },
});

const callAgentTool = <R>({
  tool,
  args,
  headers,
  caller,
  callable,
}: {
  readonly tool: AgentTool<R>;
  readonly args: Schema.Json;
  readonly headers: Headers;
  readonly caller: Option.Option<CustomerAgentCaller>;
  readonly callable: ReadonlySet<string>;
}): Effect.Effect<CallToolResult, never, ToolCallServices<R>> =>
  AgentToolAdmission.pipe(
    Effect.flatMap((admission) => admission.isCallAllowed(headers)),
    Effect.mapError(() => AgentToolError.serviceUnavailable()),
    Effect.filterOrFail(
      (allowed) => allowed,
      () => AgentToolError.rateLimited()
    ),
    Effect.andThen(spendCallBudgets({ tool, caller, args })),
    Effect.flatMap(() =>
      tool
        .call(args, caller)
        .pipe(Effect.provideService(CallableAgentTools, callable))
    ),
    Effect.map(toToolResult),
    Effect.tap(() => recordAgentToolCall(tool.name, "success")),
    Effect.catchTag("AgentToolError", (error) =>
      reportAgentToolError(error).pipe(
        Effect.andThen(recordAgentToolCall(tool.name, error.code)),
        Effect.as(toToolErrorResult(error, getRequestedAgentToolLocale(args)))
      )
    ),
    Effect.annotateLogs({ agentTool: tool.name }),
    Effect.withSpan(`agentTools.${tool.name}`)
  );

/**
 * A signed-in call spends its grant's and account's budgets; public tools
 * stay bounded by the per-IP rule alone.
 */
const spendCallBudgets = <R>({
  tool,
  caller,
  args,
}: {
  readonly tool: AgentTool<R>;
  readonly caller: Option.Option<CustomerAgentCaller>;
  readonly args: Schema.Json;
}) => {
  if (getCustomerToolScopes(tool, args).length > 0) {
    return Option.match(caller, {
      onNone: () => Effect.void,
      onSome: ({ grant }) => spendSignedInCallBudgets({ grant, tool }),
    });
  }
  return BrowserAgentAccount.pipe(
    Effect.flatMap((accountId) =>
      accountId ? spendBrowserCallBudget(accountId, tool) : Effect.void
    )
  );
};

/** Counts the call by the caller's agent category, after the response. */
const recordAgentToolCall = (
  tool: string,
  outcome: "success" | AgentToolErrorCode
) =>
  Effect.all({ traffic: CurrentAgentTraffic, timestamp: currentInstant }).pipe(
    Effect.flatMap(({ traffic, timestamp }) =>
      scheduleAgentTrafficEvent({
        event: "agent tool call",
        traffic,
        properties: { tool, outcome },
        timestamp,
      })
    )
  );

/**
 * A successful call's MCP result: the structured result, its JSON text,
 * and any attachments as embedded resources, each followed by a resource
 * link when it can also be downloaded.
 */
const toToolResult = (
  reply: AgentToolReply | AgentToolReply["result"]
): CallToolResult => {
  const { result, attachments } =
    reply instanceof AgentToolReply
      ? reply
      : { result: reply, attachments: [] };

  return {
    content: [
      { type: "text", text: JSON.stringify(result) },
      ...attachments.flatMap((attachment) => [
        toEmbeddedResource(attachment),
        ...(attachment.download === undefined
          ? []
          : [toResourceLink(attachment, attachment.download)]),
      ]),
    ],
    structuredContent: result,
  };
};

const toEmbeddedResource = ({ uri, mimeType, blob }: AgentToolAttachment) => ({
  type: "resource" as const,
  resource: { uri, mimeType, blob },
});

const toResourceLink = (
  { uri, mimeType }: AgentToolAttachment,
  { url, expiresAt }: AgentToolDownload
) => ({
  type: "resource_link" as const,
  uri: url,
  name: uri.split(":").at(-1) ?? uri,
  mimeType,
  description: `Expires at ${expiresAt}.`,
});

const reportAgentToolError = (error: AgentToolError) =>
  error.cause === undefined
    ? Effect.logInfo("Agent tool call was rejected", { code: error.code })
    : Effect.logError("Agent tool call failed", {
        code: error.code,
        cause: error.cause,
      });

const toToolErrorResult = (
  error: AgentToolError,
  locale: ReturnType<typeof getRequestedAgentToolLocale>
): CallToolResult => {
  const result = toAgentToolErrorResult(error.details, locale);

  return {
    isError: true,
    content: [{ type: "text", text: result.error.message }],
    structuredContent: result,
  };
};
