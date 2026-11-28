import { Effect, Schema } from "effect";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { getRequestedAgentToolLocale } from "@/features/agent-tools/agent-tool";
import { AgentToolAdmission } from "@/features/agent-tools/agent-tool-admission.service";
import { spendBrowserCallBudget } from "@/features/agent-tools/agent-tool-call-budget";
import {
  AgentToolError,
  toAgentToolErrorResult,
} from "@/features/agent-tools/agent-tool-error";
import { serveBrowserPassRequest } from "@/features/agent-tools/browser-pass-request";
import { getBrowserPassPreparationQuote } from "@/features/agent-tools/get-quote.tool";
import {
  defineWorkspaceRoute,
  WorkspaceRouteFailure,
} from "@/shared/backend/workspace-route";

const readPreparationQuote = Effect.fnUntraced(function* (
  request: Request,
  accountId: CustomerAccountId
) {
  const input = yield* Effect.tryPromise({
    try: () => request.json(),
    catch: () => AgentToolError.invalidInput(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    Effect.orElseSucceed(() => null)
  );
  const admission = yield* AgentToolAdmission;
  return yield* admission.isCallAllowed(request.headers).pipe(
    Effect.mapError(AgentToolError.unavailableService),
    Effect.filterOrFail(Boolean, AgentToolError.rateLimited),
    Effect.andThen(spendBrowserCallBudget(accountId, { name: "get_quote" })),
    Effect.andThen(getBrowserPassPreparationQuote(input)),
    Effect.map((quote) => Response.json({ quote })),
    Effect.catchTag("AgentToolError", (error) =>
      Effect.succeed(
        Response.json(
          toAgentToolErrorResult(
            error.details,
            getRequestedAgentToolLocale(input)
          )
        )
      )
    )
  );
});

/** An internal fetch for the mounted form. MCP results carry the quote summary. */
export const POST = defineWorkspaceRoute(
  {
    operation: "agentToolsWebMcpPrepareQuote",
    cancellation: "interrupt-on-disconnect",
    caller: "client",
  },
  (request: Request) =>
    serveBrowserPassRequest(request, (accountId) =>
      readPreparationQuote(request, accountId)
    ).pipe(
      Effect.mapError(
        WorkspaceRouteFailure.internal(
          "The WebMCP quote could not be prepared."
        )
      )
    )
);
