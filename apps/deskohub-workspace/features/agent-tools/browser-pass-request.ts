import "server-only";

import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account";
import { CustomerAccountServices } from "@/features/account/backend/customer-account-services";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { RequestBudget } from "@/shared/backend/request-budget/request-budget.service";
import { publicUrl } from "@/shared/deployment/public-origin";
import { AgentToolAdmission } from "./agent-tool-admission.service";
import { CustomerAgentToolsLive } from "./customer-agent-tools";

const browserPassServices = Layer.mergeAll(
  CustomerAgentToolsLive,
  CustomerAccountServices.pipe(
    Layer.provideMerge(CustomerAuthentication.Default)
  ),
  AgentToolAdmission.Default,
  RequestBudget.Live
).pipe(Layer.provideMerge(WorkspaceDatabase.Default));

/** Use the live browser session on pass requests from this exact site origin. */
export const serveBrowserPassRequest = Effect.fnUntraced(
  function* <E, R>(
    request: Request,
    serve: (accountId: CustomerAccountId) => Effect.Effect<Response, E, R>
  ) {
    if (
      request.headers.get("origin") !== publicUrl(request.url).origin ||
      request.headers.has("authorization")
    ) {
      return new Response(null, { status: 403 });
    }
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return new Response(null, { status: 415 });
    }
    if (!(yield* CoworkPassesReleaseGate.isOpen))
      return new Response(null, { status: 404 });

    const account = yield* CurrentCustomerAccount;
    return yield* account.requireActive.pipe(
      Effect.map((session) => ({ accountId: session.accountId })),
      Effect.catchTag("CustomerAccountAccessError", ({ reason }) =>
        Effect.succeed(
          new Response(null, { status: reason === "unavailable" ? 503 : 401 })
        )
      ),
      Effect.flatMap((result) =>
        result instanceof Response
          ? Effect.succeed(result)
          : serve(result.accountId)
      )
    );
  },
  Effect.map((response) => {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }),
  Effect.provide(browserPassServices)
);
