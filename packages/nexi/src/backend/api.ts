import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
} from "effect/http";
import { NexiRuntimeConfig, type NexiRuntimeConfigObj } from "../config";
import { ExternalAPIError, NetworkError } from "../errors";
import {
  type CreateHostedPaymentPageRequest,
  type CreateHostedPaymentPageResponse,
  ErrorResponse,
  make,
  type NexiClient,
  type Operation,
  type OperationListResponse,
  type OrderListResponse,
  type OrderResponse,
} from "../generated/effect.gen";
import type { NexiCorrelationId, NexiOperationId, NexiOrderId } from "../types";
import { getNexiRequestPolicy } from "./request-policy";

const NEXI_API_PATH = "/api/phoenix-0.0/psp/api/v1";

export const makeNexiClient = ({
  config,
  headers,
  httpClient,
}: {
  config: NexiRuntimeConfigObj;
  headers?: Record<string, string>;
  httpClient: HttpClient.HttpClient;
}): NexiClient => {
  const baseUrl = new URL(NEXI_API_PATH, config.baseUrl).toString();
  return make(httpClient, {
    transformClient: (client) =>
      Effect.succeed(
        client.pipe(
          HttpClient.mapRequestInput((request) =>
            request.pipe(
              HttpClientRequest.prependUrl(baseUrl),
              HttpClientRequest.setHeaders({
                "X-API-KEY": config.apiKey,
                ...headers,
              })
            )
          )
        )
      ),
  });
};

interface INexiGeneratedClient {
  readonly createHostedPaymentPage: (input: {
    readonly correlationId: NexiCorrelationId;
    readonly payload: CreateHostedPaymentPageRequest;
  }) => Effect.Effect<
    CreateHostedPaymentPageResponse,
    ExternalAPIError | NetworkError
  >;
  readonly getOrder: (input: {
    readonly correlationId: NexiCorrelationId;
    readonly orderId: NexiOrderId;
  }) => Effect.Effect<OrderResponse, ExternalAPIError | NetworkError>;
  readonly listOrders: (input: {
    readonly correlationId: NexiCorrelationId;
    readonly fromTime?: string;
    readonly toTime?: string;
    readonly maxRecords?: number;
  }) => Effect.Effect<OrderListResponse, ExternalAPIError | NetworkError>;
  readonly getOperation: (input: {
    readonly correlationId: NexiCorrelationId;
    readonly operationId: NexiOperationId;
  }) => Effect.Effect<Operation, ExternalAPIError | NetworkError>;
  readonly listOperations: (input: {
    readonly correlationId: NexiCorrelationId;
    readonly fromTime?: string;
    readonly toTime?: string;
    readonly maxRecords?: number;
    readonly channel?: string;
    readonly operationType?: string;
  }) => Effect.Effect<OperationListResponse, ExternalAPIError | NetworkError>;
}

/** A failure the generated Nexi client raises for any operation. */
type NexiClientFailure = HttpClientError.HttpClientError | Schema.SchemaError;

const makeNexiGeneratedClient = Effect.gen(function* () {
  const config = yield* NexiRuntimeConfig;
  const httpClient = yield* HttpClient.HttpClient;

  const clientFor = (correlationId: NexiCorrelationId) =>
    makeNexiClient({
      config,
      httpClient,
      headers: { "Correlation-Id": correlationId },
    });

  const boundAttempt = getNexiRequestPolicy(config.apiTimeout).attempt(
    () =>
      new NetworkError({
        message: "Failed to connect to Nexi",
      })
  );

  const runNexiRequest = <A>(
    effect: Effect.Effect<A, NexiClientFailure>,
    operation: string
  ) =>
    effect.pipe(
      Effect.mapError((error) => mapNexiClientError(error, operation)),
      boundAttempt
    );

  return {
    createHostedPaymentPage: ({ correlationId, payload }) =>
      runNexiRequest(
        clientFor(correlationId).createHostedPaymentPage({ payload }),
        "Create hosted payment page"
      ),
    getOrder: ({ correlationId, orderId }) =>
      runNexiRequest(
        clientFor(correlationId).getOrder(orderId, undefined),
        "Get order"
      ),
    listOrders: ({ correlationId, ...options }) =>
      runNexiRequest(
        clientFor(correlationId).listOrders({ params: options }),
        "List orders"
      ),
    getOperation: ({ correlationId, operationId }) =>
      runNexiRequest(
        clientFor(correlationId).getOperation(operationId, undefined),
        "Get operation"
      ),
    listOperations: ({ correlationId, ...options }) =>
      runNexiRequest(
        clientFor(correlationId).listOperations({ params: options }),
        "List operations"
      ),
  } satisfies INexiGeneratedClient;
});

export class NexiGeneratedClient extends Context.Service<
  NexiGeneratedClient,
  INexiGeneratedClient
>()("NexiGeneratedClient") {
  static Default = Layer.effect(this, makeNexiGeneratedClient);
}

export const mapNexiClientError = (
  error: NexiClientFailure,
  operation: string
): ExternalAPIError | NetworkError =>
  error._tag === "SchemaError"
    ? toInvalidResponseError(operation)
    : mapHttpClientError(error, operation);

const toInvalidResponseError = (operation: string) =>
  new ExternalAPIError({
    service: "Nexi",
    operation,
    message: "Nexi returned an invalid response.",
  });

/**
 * A transport or URL failure never reached Nexi; any other HTTP client
 * failure carries the provider's error body in its description. The
 * provider's status, message (else its first error's description), and
 * errors (else its error code, else the reason's cause) take precedence.
 */
const mapHttpClientError = (
  error: HttpClientError.HttpClientError,
  operation: string
) => {
  const reason = error.reason;
  if (
    Predicate.isTagged(reason, "TransportError") ||
    Predicate.isTagged(reason, "InvalidUrlError")
  ) {
    return new NetworkError({
      message: "Failed to connect to Nexi",
      url: error.request.url,
      cause: error,
    });
  }

  const providerError = parseProviderError(
    "description" in reason ? reason.description : undefined
  );
  return new ExternalAPIError({
    service: "Nexi",
    operation,
    statusCode: providerError?.status ?? error.response?.status,
    message: providerError?.message ?? providerError?.errors?.[0]?.description,
    cause: providerError?.errors ?? providerError?.error ?? reason.cause,
  });
};

const decodeProviderErrorBody = Schema.decodeOption(
  Schema.fromJsonString(ErrorResponse)
);

const parseProviderError = (
  description: string | undefined
): ErrorResponse | undefined =>
  description === undefined
    ? undefined
    : Option.getOrUndefined(decodeProviderErrorBody(description));
