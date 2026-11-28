import "server-only";

import { Context, Duration, Effect, Match } from "effect";
import type { CustomerAgentGrant } from "@/features/account";
import type { CustomerAccountId } from "@/features/account/customer-account";
import {
  RequestBudget,
  type RequestBudgetPolicy,
} from "@/shared/backend/request-budget/request-budget.service";
import { budgetKeyDigest } from "@/shared/backend/request-budget/request-budget-key";
import { AgentToolError } from "./agent-tool-error";

/**
 * A tighter per-account budget a signed-in tool spends on top of the
 * general signed-in budgets, such as a tool that calls Dotypos live.
 */
export interface AgentToolAccountBudget {
  readonly limit: number;
  readonly window: Duration.Duration;
}

/**
 * Calls one agent client may make for one account: a burst bound for a
 * runaway or looping assistant. Listing reservations, checking a status,
 * and starting a booking take a handful of calls.
 */
const grantCallBudget = { limit: 10, window: Duration.minutes(10) };

/**
 * Signed-in calls all of an account's agents may make together. Signed-in
 * tools read live Dotypos data, one to three requests per call, and the
 * whole site shares 150 Dotypos requests per 30 minutes, so one account's
 * agents can take at most two fifths of that window.
 */
const accountCallBudget = { limit: 20, window: Duration.minutes(30) };

/** The account verified by the same-origin browser route. */
export const BrowserAgentAccount = Context.Reference<
  CustomerAccountId | undefined
>("@deskohub-workspace/agent-tools/BrowserAgentAccount", {
  defaultValue: () => undefined,
});

interface BudgetedTool {
  readonly name: string;
  readonly accountBudget?: AgentToolAccountBudget;
}

const accountPolicies = (
  accountId: CustomerAccountId,
  tool: BudgetedTool
): ReadonlyArray<RequestBudgetPolicy> => {
  const account = digest("account", accountId);
  return [
    { key: `agent-tool:account:${account}`, ...accountCallBudget },
    ...(tool.accountBudget
      ? [
          {
            key: `agent-tool:${tool.name}:account:${account}`,
            ...tool.accountBudget,
          },
        ]
      : []),
  ];
};

export const spendBrowserCallBudget = (
  accountId: CustomerAccountId,
  tool: BudgetedTool
) => spendAgentBudgets(accountPolicies(accountId, tool));

/**
 * Spends the per-grant, per-account, and the tool's own account budgets of
 * one signed-in call. The per-IP limit stays the firewall rule every call
 * passes first. An exhausted budget refuses the call as rate limited; a
 * budget that can't be checked fails closed.
 */
export const spendSignedInCallBudgets = Effect.fn(
  "agentTools.spendSignedInCallBudgets"
)(function* ({
  grant,
  tool,
}: {
  readonly grant: CustomerAgentGrant;
  readonly tool: BudgetedTool;
}) {
  const policies: RequestBudgetPolicy[] = [
    {
      key: `agent-tool:grant:${digest("grant", grant.accountId, grant.clientId)}`,
      ...grantCallBudget,
    },
    ...accountPolicies(grant.accountId, tool),
  ];
  yield* spendAgentBudgets(policies);
});

const spendAgentBudgets = Effect.fn("agentTools.spendBudgets")(function* (
  policies: ReadonlyArray<RequestBudgetPolicy>
) {
  const budget = yield* RequestBudget;
  yield* Effect.forEach(policies, (policy) =>
    budget.spend(policy).pipe(
      Effect.mapError(AgentToolError.unavailableService),
      Effect.flatMap((spend) =>
        Match.value(spend).pipe(
          Match.tagsExhaustive({
            Granted: () => Effect.void,
            Exhausted: () => Effect.fail(AgentToolError.rateLimited()),
          })
        )
      )
    )
  );
});

const digest = (...parts: ReadonlyArray<string>) =>
  budgetKeyDigest("deskohub-workspace/agent-tool-budget", ...parts);
