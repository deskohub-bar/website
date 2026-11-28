import { Effect } from "effect";
import { browserPassTools } from "@/features/agent-tools/agent-pass-tools";
import { BrowserAgentAccount } from "@/features/agent-tools/agent-tool-call-budget";
import { serveBrowserAgentToolMcpRequest } from "@/features/agent-tools/agent-tool-mcp-handler";
import { serveBrowserPassRequest } from "@/features/agent-tools/browser-pass-request";
import { getBrowserPassQuoteTool } from "@/features/agent-tools/get-quote.tool";
import {
  defineWorkspaceRoute,
  WorkspaceRouteFailure,
} from "@/shared/backend/workspace-route";

type BrowserPassTool =
  | typeof getBrowserPassQuoteTool
  | (typeof browserPassTools)[number];
type BrowserPassToolServices = Effect.Services<
  ReturnType<BrowserPassTool["call"]>
>;

/** WebMCP uses the current browser session. The remote MCP resource uses OAuth. */
export const POST = defineWorkspaceRoute(
  {
    operation: "agentToolsWebMcp",
    cancellation: "interrupt-on-disconnect",
    caller: "client",
  },
  (request: Request) =>
    serveBrowserPassRequest(request, (accountId) =>
      serveBrowserAgentToolMcpRequest<BrowserPassToolServices>({
        tools: [getBrowserPassQuoteTool, ...browserPassTools],
        request,
      }).pipe(Effect.provideService(BrowserAgentAccount, accountId))
    ).pipe(
      Effect.mapError(
        WorkspaceRouteFailure.internal("The WebMCP request failed.")
      )
    )
);
