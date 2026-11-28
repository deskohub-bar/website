import { baseLocale, supportedLocales } from "@deskohub/i18n/locale-registry";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { CustomerAgentScope } from "@/features/account";
import type { Locale } from "@/features/i18n";
import { toClosedStandardJSONSchemaV1 } from "@/shared/utils/closed-json-schema";
import { getFirstInvalidFieldPath } from "@/shared/utils/schema-issue";
import type { AgentToolAccountBudget } from "./agent-tool-call-budget";
import {
  AgentToolError,
  type AgentToolUnavailableCode,
  agentToolErrorResultSchema,
  publicAgentToolErrorResultSchema,
} from "./agent-tool-error";
import type { AgentToolView } from "./agent-tool-view";
import {
  type CustomerAgentCaller,
  CustomerAgentCallServices,
  type SignedInAgentToolRequirements,
  type SignedInAgentToolServices,
} from "./customer-agent-caller";

/**
 * Who may call a tool. A signed-in tool also names the OAuth scope the
 * customer must have granted the agent; public tools need no token. An
 * administration tool needs the administration scope, and the MCP route
 * publishes it only to an agent whose account holds the administrator grant
 * at that moment.
 */
type ArgumentScope = {
  readonly argument: string;
  readonly scope: CustomerAgentScope;
};

export type AgentToolAuthorization = (
  | { readonly access: "public" }
  | {
      readonly access: "signed-in";
      readonly scope: CustomerAgentScope;
    }
  | { readonly access: "administration" }
) & { readonly scopeWhenArgument?: ArgumentScope };

export const hasAgentToolArgument = (
  args: Schema.Json | undefined,
  argument: string
) => Predicate.isObject(args) && Object.hasOwn(args, argument);

/** The scopes needed for this call, including fields that opt into account data. */
export const getCustomerToolScopes = (
  tool: AgentToolAuthorization,
  args?: Schema.Json
): ReadonlyArray<CustomerAgentScope> => {
  const scopes = tool.access === "signed-in" ? [tool.scope] : [];
  const conditional = tool.scopeWhenArgument;
  return conditional && hasAgentToolArgument(args, conditional.argument)
    ? [...scopes, conditional.scope]
    : scopes;
};

/** A schema that validates a value and describes it as JSON Schema. */
type AgentToolSchema<Input, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

/** The structured result of a call; each tool's output schema owns its shape. */
const agentToolResultSchema = Schema.Record(Schema.String, Schema.Unknown);

type AgentToolResult = typeof agentToolResultSchema.Type;

/** A resource a result carries in full, such as a PDF document. */
export interface AgentToolAttachment {
  readonly uri: string;
  readonly mimeType: string;
  /** The content, base64-encoded. */
  readonly blob: string;
  /** Where the user can also open it, for hosts that can't show `blob`. */
  readonly download?: AgentToolDownload;
}

/** An address that serves an attachment until it expires. */
export interface AgentToolDownload {
  readonly url: string;
  /** An ISO 8601 instant. */
  readonly expiresAt: string;
}

/**
 * A result that also carries attachments, which the protocol edge sends
 * beside the structured result rather than inside it.
 */
export class AgentToolReply extends Data.Class<{
  readonly result: AgentToolResult;
  readonly attachments: ReadonlyArray<AgentToolAttachment>;
}> {}

/**
 * A capability customers' AI agents can call. Each protocol edge, such as the
 * MCP server, publishes the name, copy, and schemas, and runs `call` with the
 * raw arguments it received.
 */
export type AgentTool<R> = AgentToolAuthorization & {
  /** Stable snake_case name agents call the tool by. */
  readonly name: string;
  readonly title: string;
  /** Static English guidance for the agent; never interpolates input. */
  readonly description: string;
  /**
   * Whether the tool only reads. A tool that creates a hold or any other
   * state is transactional.
   */
  readonly readOnly: boolean;
  /**
   * Whether a call can cancel or replace state the customer made before.
   * Defaults to false.
   */
  readonly destructive?: boolean;
  /**
   * Whether repeating a call with the same arguments changes nothing more.
   * Defaults to `readOnly`.
   */
  readonly idempotent?: boolean;
  readonly accountBudget?: AgentToolAccountBudget;
  /** The code an unexpected failure is reported with. */
  readonly unavailableCode: AgentToolUnavailableCode;
  /** The MCP Apps view the tool's result renders in, if any. */
  readonly view?: AgentToolView;
  readonly input: StandardJSONSchemaV1;
  /**
   * Every structured result the tool answers with: its success result, or
   * the error result of a failed call.
   */
  readonly output: AgentToolSchema<AgentToolResult>;
  /**
   * Validates the arguments, parsed from the request JSON, and runs the tool
   * for the agent whose token the request carried, if any.
   */
  readonly call: (
    args: Schema.Json,
    caller?: Option.Option<CustomerAgentCaller>
  ) => Effect.Effect<AgentToolResult | AgentToolReply, AgentToolError, R>;
};

/**
 * The names of the published tools the calling agent may call in this
 * request: every public tool, and the signed-in tools its token grants.
 */
export class CallableAgentTools extends Context.Service<
  CallableAgentTools,
  ReadonlySet<string>
>()("@deskohub-workspace/agent-tools/CallableAgentTools") {}

/** The optional `locale` every tool accepts; messages default to English. */
export const agentToolLocaleField = Schema.optionalKey(
  Schema.Literals(supportedLocales).annotate({
    description: `Language of messages and product names in the result. Defaults to ${baseLocale}.`,
  })
);

export const getAgentToolLocale = (input: { readonly locale?: Locale }) =>
  input.locale ?? baseLocale;

const agentToolLocaleInputSchema = Schema.Struct({
  locale: Schema.optionalKey(Schema.Literals(supportedLocales)),
});

/**
 * The locale raw tool arguments ask for, for messages about arguments that
 * failed validation as a whole.
 */
export const getRequestedAgentToolLocale = (args: Schema.Json): Locale =>
  Option.match(Schema.decodeUnknownOption(agentToolLocaleInputSchema)(args), {
    onNone: () => baseLocale,
    onSome: getAgentToolLocale,
  });

type AgentToolDefinition<
  Input extends Schema.Top & { readonly DecodingServices: never },
  Output extends Schema.Codec<AgentToolResult, AgentToolResult>,
  R,
> = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly accountBudget?: AgentToolAccountBudget;
  /** The code an unexpected failure is reported with. */
  readonly unavailableCode: AgentToolUnavailableCode;
  /** The MCP Apps view the tool's result renders in, if any. */
  readonly view?: AgentToolView;
  readonly input: Input;
  readonly output: Output;
  readonly run: (
    input: Input["Type"]
  ) => Effect.Effect<Output["Type"], AgentToolError, R>;
};

/** A tool anyone may call, without an access token. */
export const defineAgentTool = <
  Input extends Schema.Top & { readonly DecodingServices: never },
  Output extends Schema.Codec<AgentToolResult, AgentToolResult>,
  R,
>(
  definition: AgentToolDefinition<Input, Output, R> & {
    readonly access: "public";
  }
): AgentTool<R> =>
  makeAgentTool({ access: "public" }, definition, definition.run);

/** A public tool whose optional argument uses the customer's OAuth grant. */
export const defineMixedAccessAgentTool = <
  Input extends Schema.Top & { readonly DecodingServices: never },
  Output extends Schema.Codec<AgentToolResult, AgentToolResult>,
  R,
  RWithGrant,
>(
  definition: AgentToolDefinition<Input, Output, R> & {
    readonly scopeWhenArgument: ArgumentScope;
    readonly run: (
      input: Input["Type"]
    ) => Effect.Effect<Output["Type"], AgentToolError, R>;
    readonly runWithGrant: (
      input: Input["Type"]
    ) => Effect.Effect<Output["Type"], AgentToolError, RWithGrant>;
  }
): AgentTool<
  | R
  | Exclude<RWithGrant, SignedInAgentToolServices>
  | SignedInAgentToolRequirements
> => {
  const authorization = {
    access: "public",
    scopeWhenArgument: definition.scopeWhenArgument,
  } as const;
  return makeAgentTool<
    Input,
    Output,
    R,
    | R
    | Exclude<RWithGrant, SignedInAgentToolServices>
    | SignedInAgentToolRequirements
  >(authorization, definition, (input, caller, args) => {
    const scopes = getCustomerToolScopes(authorization, args);
    return scopes.length === 0
      ? definition.run(input)
      : provideAgentGrant(() => definition.runWithGrant(input), caller, scopes);
  });
};

const provideAgentGrant = <A, R>(
  run: () => Effect.Effect<A, AgentToolError, R>,
  caller: Option.Option<CustomerAgentCaller>,
  scopes: ReadonlyArray<CustomerAgentScope>
): Effect.Effect<
  A,
  AgentToolError,
  Exclude<R, SignedInAgentToolServices> | SignedInAgentToolRequirements
> =>
  Option.match(caller, {
    // The route answers unauthorized calls with a challenge before execution.
    onNone: () => Effect.fail(AgentToolError.serviceUnavailable()),
    onSome: (signedIn) => {
      if (!scopes.every((scope) => signedIn.grant.scopes.has(scope))) {
        return Effect.fail(AgentToolError.serviceUnavailable());
      }
      return CustomerAgentCallServices.pipe(
        Effect.flatMap(({ forCaller }) =>
          // Never reuse account services built over the request's browser session.
          Effect.suspend(run).pipe(
            Effect.provide(forCaller(signedIn).pipe(Layer.orDie), {
              local: true,
            })
          )
        )
      );
    },
  });

/**
 * A tool only an agent the customer signed in through may call. The MCP
 * route refuses a call without a token granting `scope` before it runs; the
 * tool reads the customer through its `CurrentCustomerAgentGrant` and
 * the account services `CustomerAgentCallServices` builds for the caller,
 * backed by the caller's token unless a test provides its own.
 */
export const defineSignedInAgentTool = <
  Input extends Schema.Top & { readonly DecodingServices: never },
  Output extends Schema.Codec<AgentToolResult, AgentToolResult>,
  R,
>(
  definition: AgentToolDefinition<Input, Output, R> & {
    readonly scope: CustomerAgentScope;
    readonly scopeWhenArgument?: ArgumentScope;
  }
): AgentTool<
  Exclude<R, SignedInAgentToolServices> | SignedInAgentToolRequirements
> => {
  const authorization = {
    access: "signed-in",
    scope: definition.scope,
    ...(definition.scopeWhenArgument && {
      scopeWhenArgument: definition.scopeWhenArgument,
    }),
  } as const;
  return makeAgentTool(authorization, definition, (input, caller, args) =>
    provideAgentGrant(
      () => definition.run(input),
      caller,
      getCustomerToolScopes(authorization, args)
    )
  );
};

const makeAgentTool = <
  Input extends Schema.Top & { readonly DecodingServices: never },
  Output extends Schema.Codec<AgentToolResult, AgentToolResult>,
  R,
  RCall,
>(
  authorization: AgentToolAuthorization,
  definition: AgentToolDefinition<Input, Output, R>,
  run: (
    input: Input["Type"],
    caller: Option.Option<CustomerAgentCaller>,
    args: Schema.Json
  ) => Effect.Effect<AgentToolResult, AgentToolError, RCall>
): AgentTool<RCall> => {
  const decodeInput = Schema.decodeUnknownEffect(definition.input);

  return {
    ...authorization,
    name: definition.name,
    title: definition.title,
    description: definition.description,
    readOnly: definition.readOnly,
    ...(definition.destructive !== undefined && {
      destructive: definition.destructive,
    }),
    ...(definition.idempotent !== undefined && {
      idempotent: definition.idempotent,
    }),
    ...(definition.accountBudget && {
      accountBudget: definition.accountBudget,
    }),
    unavailableCode: definition.unavailableCode,
    ...(definition.view && { view: definition.view }),
    input: toClosedStandardJSONSchemaV1(definition.input),
    output: toClosedStandardJSONSchemaV1(
      Schema.toStandardSchemaV1(
        Schema.Union([
          definition.output,
          authorization.access === "public"
            ? publicAgentToolErrorResultSchema
            : agentToolErrorResultSchema,
        ])
      )
    ),
    call: (args, caller = Option.none()) =>
      decodeInput(args).pipe(
        Effect.mapError((error) =>
          AgentToolError.invalidInput(getFirstInvalidFieldPath(error.issue))
        ),
        Effect.flatMap((input) => run(input, caller, args)),
        Effect.catchDefect((defect) =>
          Effect.fail(
            AgentToolError.unavailable(definition.unavailableCode)(defect)
          )
        )
      ),
  };
};
