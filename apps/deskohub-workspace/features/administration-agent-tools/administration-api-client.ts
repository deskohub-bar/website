import { WorkspaceAdminApi } from "@deskohub/workspace-admin-api";
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Record,
  Redacted,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  type HttpApi,
  HttpApiClient,
  type HttpApiGroup,
} from "effect/http-api";

/**
 * Serves one request with the administration API that administrators'
 * agents use: the server's handlers behind assistant authentication, never
 * mounted on a URL.
 */
export class AdministrationApiTransport extends Context.Service<
  AdministrationApiTransport,
  (request: Request) => Promise<Response>
>()(
  "@deskohub-workspace/administration-agent-tools/AdministrationApiTransport"
) {}

/** The OAuth access token of the agent an administration call acts for. */
export class AdministrationAgentAccessToken extends Context.Service<
  AdministrationAgentAccessToken,
  Redacted.Redacted<string>
>()(
  "@deskohub-workspace/administration-agent-tools/AdministrationAgentAccessToken"
) {}

/** One administration API request, with each part as its schema's type. */
export interface AdministrationApiRequest {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly payload?: unknown;
}

/** An operation's decoded success and the content type it was sent with. */
interface AdministrationApiResponse {
  readonly value: unknown;
  readonly contentType: Option.Option<string>;
}

type EndpointCall = (
  request: AdministrationApiRequest & {
    readonly responseMode: "decoded-and-response";
  }
) => Effect.Effect<
  readonly [unknown, HttpClientResponse.HttpClientResponse],
  unknown,
  AdministrationAgentAccessToken
>;

/** The member a client object holds as its own property `name`, if any. */
const memberOf =
  (name: string) =>
  <Value>(value: Value) =>
    Predicate.isObject(value) ? Record.get(value, name) : Option.none();

/**
 * Whether a client member is an endpoint's method. This is a trust boundary,
 * not a proof: the runtime check is only that the member is callable. The
 * client builds one method per endpoint, as its own property of its group,
 * and the tools check each request part against the endpoint's schemas
 * themselves, so a method is called with the request they checked.
 */
const isEndpointCall = <Value>(value: Value): value is Value & EndpointCall =>
  Predicate.isFunction(value);

interface IAdministrationApiClient {
  /**
   * Calls `<group>.<endpoint>` with the calling agent's access token. Fails
   * with the operation's typed error, or a transport or schema error.
   */
  readonly call: (
    operation: string,
    request: AdministrationApiRequest
  ) => Effect.Effect<
    AdministrationApiResponse,
    unknown,
    AdministrationAgentAccessToken
  >;
}

// The transport ignores the host; requests never leave the process.
const baseUrl = "https://administration.invalid";

/**
 * The administration API client administrators' agents call through: the
 * API's own client, over a fetch that hands each request to the transport,
 * so requests run the same handlers, schemas and errors as the CLI's.
 */
export class AdministrationApiClient extends Context.Service<
  AdministrationApiClient,
  IAdministrationApiClient
>()("@deskohub-workspace/administration-agent-tools/AdministrationApiClient") {
  /** A client of `api`, served by the transport. */
  static forApi = <Id extends string, Groups extends HttpApiGroup.Constraint>(
    api: HttpApi.HttpApi<Id, Groups>
  ) =>
    Layer.effect(
      AdministrationApiClient,
      Effect.gen(function* () {
        const transport = yield* AdministrationApiTransport;
        const fetch: typeof globalThis.fetch = Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) =>
            transport(new Request(input, init)),
          { preconnect: globalThis.fetch.preconnect }
        );
        const httpClient = (yield* HttpClient.HttpClient).pipe(
          // The fetch client reads `Fetch` from the fiber that sends each
          // request, so the transport is pinned on every request here:
          // none of them may reach the network.
          HttpClient.transformResponse(
            Effect.provideService(FetchHttpClient.Fetch, fetch)
          ),
          HttpClient.mapRequestEffect(
            Effect.fn("AdministrationApiClient.authorize")(function* (
              request: HttpClientRequest.HttpClientRequest
            ) {
              const token = yield* AdministrationAgentAccessToken;
              return HttpClientRequest.bearerToken(
                request,
                Redacted.value(token)
              );
            })
          )
        );
        const client = yield* HttpApiClient.makeWith(api, {
          httpClient,
          baseUrl,
        });
        return {
          call: (operation, request) =>
            Option.some(client).pipe(
              Option.flatMap(memberOf(operation.split(".")[0] ?? "")),
              Option.flatMap(memberOf(operation.split(".")[1] ?? "")),
              Option.filter(isEndpointCall),
              Option.match({
                onNone: () =>
                  Effect.die(new Error(`Unknown operation ${operation}.`)),
                onSome: (call) =>
                  call({
                    ...request,
                    responseMode: "decoded-and-response",
                  }).pipe(
                    Effect.map(([value, response]) => ({
                      value,
                      contentType: Option.fromNullishOr(
                        response.headers["content-type"]
                      ),
                    }))
                  ),
              })
            ),
        } satisfies IAdministrationApiClient;
      })
    ).pipe(Layer.provide(FetchHttpClient.layer));

  static Default = this.forApi(WorkspaceAdminApi);
}
