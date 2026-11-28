import "server-only";

import { createHash } from "node:crypto";
import { stripLocaleFromPathname } from "@deskohub/i18n/pathname";
import { Duration, Effect, Schema } from "effect";
import {
  CurrentCustomerAccount,
  type CustomerAgentClientId,
} from "@/features/account";
import { customerPassesAgentScope } from "@/features/account/agent-scopes";
import type { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { type Locale, locales } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import type { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { customerPassPurchaseLayers } from "@/features/passes/backend/customer-pass-purchase-layers";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import { findOwnedPassPurchaseOrder } from "@/features/passes/backend/entry-pack-order";
import {
  entryPackProductSchema,
  passTiers,
} from "@/features/passes/pass-offer";
import { getPassPurchaseStatusPath } from "@/features/passes/routes";
import { unlimitedPassSelectionSchema } from "@/features/passes/unlimited-pass";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import {
  agentToolLocaleField,
  defineAgentTool,
  defineSignedInAgentTool,
  getAgentToolLocale,
} from "./agent-tool";
import { BrowserAgentAccount } from "./agent-tool-call-budget";
import { AgentToolError } from "./agent-tool-error";
import { CurrentCustomerAgentGrant } from "./customer-agent-caller";
import { requireAgentPassesOpen } from "./pass-funding";

const heldPassFields = {
  pass_id: Schema.String,
  tier: Schema.Literals(passTiers),
  valid_from: Schema.String,
  last_usable_date: Schema.String,
  status: Schema.String,
};

const listPasses = {
  name: "list_passes",
  title: "List the customer's Deskohub Workspace entry packs and memberships",
  description:
    "Lists the customer's entry packs with remaining entries and expiry, and Unlimited memberships with their dates. Use show_pass_access for the customer's membership access link.",
  input: Schema.Struct({ locale: agentToolLocaleField }),
  output: Schema.Struct({
    passes: Schema.Array(
      Schema.Union([
        Schema.Struct({
          ...heldPassFields,
          kind: Schema.Literal("entry-pack"),
          entries_left: Schema.Int,
        }),
        Schema.Struct({ ...heldPassFields, kind: Schema.Literal("unlimited") }),
      ])
    ),
  }),
  readOnly: true,
  unavailableCode: "passes_unavailable",
  run: Effect.fn("agentTools.listPasses")(
    (input: { readonly locale?: Locale }) =>
      requireAgentPassesOpen.pipe(
        Effect.andThen(CustomerPasses),
        Effect.flatMap((passes) => passes.list(getAgentToolLocale(input))),
        Effect.map(({ held }) => ({
          passes: held.map((pass) => {
            const common = {
              pass_id: pass.passId,
              tier: pass.tier,
              status: pass.status,
              valid_from: pass.validFrom,
              last_usable_date: pass.lastUsableDate,
            };
            return pass.kind === "entry-pack"
              ? { ...common, kind: pass.kind, entries_left: pass.entriesLeft }
              : { ...common, kind: pass.kind };
          }),
        })),
        Effect.mapError(AgentToolError.passesUnavailable)
      )
  ),
} as const;

const accessInput = Schema.Struct({
  pass_id: orderIdSchema.annotate({
    description:
      "The ID of the customer's Unlimited membership from list_passes.",
  }),
  locale: agentToolLocaleField,
});

const showPassAccess = {
  name: "show_pass_access",
  title: "Open a Deskohub Workspace Unlimited membership access page",
  description:
    "Returns the account-only access page for the customer's Unlimited membership. Give the link to the customer to open while signed in on the website.",
  input: accessInput,
  output: Schema.Struct({ access_url: Schema.String }),
  readOnly: true,
  unavailableCode: "passes_unavailable",
  run: Effect.fn("agentTools.showPassAccess")(
    (input: typeof accessInput.Type) =>
      requireAgentPassesOpen.pipe(
        Effect.andThen(CustomerPasses),
        Effect.flatMap((passes) =>
          passes.accessPath(input.pass_id, getAgentToolLocale(input))
        ),
        Effect.bindTo("path"),
        Effect.bind("origin", () => getWorkspaceRuntimeCallbackOrigin),
        Effect.map(({ path, origin }) => {
          const url = new URL("/", origin);
          url.pathname = stripLocaleFromPathname(
            new URL(path, origin).pathname,
            locales
          );
          return { access_url: url.href };
        }),
        Effect.mapError(AgentToolError.passesUnavailable)
      )
  ),
} as const;

const purchaseRequestId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PassPurchaseRequestId"))
  .annotate({
    identifier: "PassPurchaseRequestId",
    description:
      "Generate a UUID for this purchase request. Reuse it with the same product after an interruption or missing response. Generate a fresh UUID only when the customer asks to start a new purchase.",
  });

const purchaseInput = Schema.Struct({
  purchase_request_id: purchaseRequestId,
  product: Schema.Union([
    entryPackProductSchema,
    Schema.Struct({
      kind: Schema.Literal("unlimited"),
      selection: unlimitedPassSelectionSchema,
    }),
  ]),
  locale: agentToolLocaleField,
});

const purchaseOutput = Schema.Union([
  Schema.Struct({ pay_url: Schema.String }),
  Schema.Struct({ status_url: Schema.String }),
]);

type PassPurchaseInput = typeof purchaseInput.Type;

type PassPurchaseCaller = {
  readonly accountId: CustomerAccountId;
  readonly channel:
    | readonly ["web-mcp"]
    | readonly ["oauth-mcp", CustomerAgentClientId];
};

const getPassPurchaseOrderId = (
  { accountId, channel }: PassPurchaseCaller,
  { purchase_request_id, product }: PassPurchaseInput
) => {
  const selection =
    product.kind === "entry-pack"
      ? [product.kind, product.tier, product.size]
      : [
          product.kind,
          product.selection.tier,
          product.selection.startDate,
          "coffee" in product.selection ? product.selection.coffee : null,
          "monitorOption" in product.selection
            ? product.selection.monitorOption
            : null,
        ];
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "deskohub-workspace/agent-pass-purchase/v1",
        accountId,
        channel,
        purchase_request_id.toLowerCase(),
        selection,
      ])
    )
    .digest();
  // Keep the same ID across retries and deployments. Mark it as a UUIDv8.
  digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x80, 6);
  digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = digest.toString("hex", 0, 16);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return orderIdSchema.make(uuid);
};

type PassPurchaseToolServices =
  | CoworkPassesReleaseGate
  | CurrentCustomerAccount
  | CustomerAuthentication
  | CustomerPasses;

const startPassPurchase = Effect.fn("agentTools.startPassPurchase")(function* (
  input: PassPurchaseInput,
  caller: PassPurchaseCaller
) {
  yield* requireAgentPassesOpen;
  const account = yield* CurrentCustomerAccount;
  const { accountId } = yield* account.requireActive;
  if (accountId !== caller.accountId)
    return yield* AgentToolError.passesUnavailable();
  const passes = yield* CustomerPasses;
  const orderId = getPassPurchaseOrderId(caller, input);
  const purchase = yield* Effect.catchIf(
    passes.startPurchase({
      orderId,
      locale: getAgentToolLocale(input),
      product: input.product,
    }),
    (error) =>
      error._tag === "EntryPackPurchaseError" &&
      error.reason === "purchase-conflict",
    // The buyer can edit a Details handoff before its order is recorded.
    (error) =>
      findOwnedPassPurchaseOrder(orderId, accountId, input.product.kind).pipe(
        Effect.flatMap((owned) => {
          if (!owned?.order.activePaymentAttemptId) return Effect.fail(error);
          return Effect.succeed({
            status: "status" as const,
            checkoutPath: getPassPurchaseStatusPath(
              owned.purchase.locale,
              orderId
            ),
          });
        })
      )
  ).pipe(Effect.provide(customerPassPurchaseLayers.agentStart));
  const origin = yield* getWorkspaceRuntimeCallbackOrigin;
  const url = new URL(purchase.checkoutPath, origin);
  if (purchase.status === "details_required") {
    url.pathname = stripLocaleFromPathname(url.pathname, locales);
  }
  return purchase.status === "status"
    ? { status_url: url.href }
    : { pay_url: url.href };
}, Effect.mapError(AgentToolError.passesUnavailable));

const passPurchaseTool = {
  name: "start_pass_purchase",
  title: "Start a Deskohub Workspace entry pack or membership purchase",
  description:
    "Prepares the selected entry pack or Unlimited membership for the signed-in customer. An Unlimited membership purchase covers 30 days. Reuse the purchase_request_id and product when retrying. Give the customer the pay_url to finish any missing details, review the terms and start-date consent, and pay on the signed-in website. If payment already started, give them the status_url instead.",
  input: purchaseInput,
  output: purchaseOutput,
  readOnly: false,
  idempotent: true,
  accountBudget: { limit: 5, window: Duration.minutes(30) },
  unavailableCode: "passes_unavailable",
} as const;

export const listPassesTool = defineSignedInAgentTool({
  ...listPasses,
  scope: customerPassesAgentScope,
});
export const showPassAccessTool = defineSignedInAgentTool({
  ...showPassAccess,
  scope: customerPassesAgentScope,
});
export const startPassPurchaseTool = defineSignedInAgentTool<
  typeof purchaseInput,
  typeof purchaseOutput,
  PassPurchaseToolServices | CurrentCustomerAgentGrant
>({
  ...passPurchaseTool,
  scope: customerPassesAgentScope,
  run: (input) =>
    CurrentCustomerAgentGrant.pipe(
      Effect.flatMap(({ accountId, clientId }) =>
        startPassPurchase(input, {
          accountId,
          channel: ["oauth-mcp", clientId],
        })
      )
    ),
});

export const startBrowserPassPurchaseTool = defineAgentTool<
  typeof purchaseInput,
  typeof purchaseOutput,
  PassPurchaseToolServices
>({
  ...passPurchaseTool,
  access: "public",
  run: (input) =>
    BrowserAgentAccount.pipe(
      Effect.filterOrFail(
        (accountId) => accountId !== undefined,
        AgentToolError.passesUnavailable
      ),
      Effect.flatMap((accountId) =>
        startPassPurchase(input, { accountId, channel: ["web-mcp"] })
      )
    ),
});

/** Only the same-origin browser MCP route publishes this catalog. */
export const browserPassTools = [
  defineAgentTool({ ...listPasses, access: "public" }),
  defineAgentTool({ ...showPassAccess, access: "public" }),
  startBrowserPassPurchaseTool,
];
