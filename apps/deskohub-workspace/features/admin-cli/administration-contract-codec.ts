import { Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/**
 * Every service the API's schemas need to decode or encode a request, a
 * success or an error, on the server or the client.
 */
export type ContractServices<Groups extends HttpApiGroup.Constraint> =
  | HttpApiEndpoint.ServerServices<HttpApiGroup.Endpoints<Groups>>
  | HttpApiEndpoint.ClientServices<HttpApiGroup.Endpoints<Groups>>;

/**
 * A group widened past the structure Effect reads its endpoints from, so its
 * endpoints' schemas and services are unknown.
 */
type UntypedGroup<Group> =
  Group extends HttpApiGroup.HttpApiGroup<
    infer _Id,
    infer _Endpoints,
    infer _TopLevel
  >
    ? never
    : Group;

/**
 * An endpoint widened past the request structure Effect reads its schemas'
 * services from, so they are unknown.
 */
type UntypedEndpoint<Endpoint> =
  Endpoint extends HttpApiEndpoint.ConstraintRequest ? never : Endpoint;

/**
 * Accepts only an API whose schemas are typed and need no services. An API
 * with a group or endpoint widened past the structure Effect reads services
 * from, or whose schemas need any service, fails to typecheck. Names don't
 * matter: a typed group with no endpoints, or a typed endpoint with a
 * `string` name, passes.
 */
export type ServiceFreeContract<Groups extends HttpApiGroup.Constraint> = [
  UntypedGroup<Groups> | UntypedEndpoint<HttpApiGroup.Endpoints<Groups>>,
] extends [never]
  ? [ContractServices<Groups>] extends [never]
    ? unknown
    : { readonly contractServices: ContractServices<Groups> }
  : {
      readonly erasedContract:
        | UntypedGroup<Groups>
        | UntypedEndpoint<HttpApiGroup.Endpoints<Groups>>;
    };

/**
 * A reflected Administration API schema as the codec it is. Reflection types
 * every endpoint schema as `Schema.Top`, whose services are unknown, and
 * Effect has no checked way to rebuild a service-free codec from one. The
 * typed contract proves it instead: the Administration API's schemas need no
 * services (`administration-contract-codec.typecheck.ts`), and every other
 * API the tools reflect is a `ServiceFreeContract`. The codec keeps the
 * schema's own AST, so it parses exactly as the schema does.
 */
export const administrationContractCodec = (schema: Schema.Top) =>
  Schema.make<Schema.Codec<unknown, unknown>>(schema.ast);
