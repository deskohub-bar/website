import {
  Cache,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { DotyposRuntimeConfig, type DotyposRuntimeConfigObj } from "../config";
import {
  type DotyposClient,
  type ErrorResponse as DotyposErrorResponse,
  ErrorResponse,
  make,
} from "../generated/effect.gen";

/** The error body Dotypos sends with a failed request. */
type DotyposProviderError = {
  readonly error?: string;
  readonly errorDescription?: string;
  readonly code?: number;
};

/**
 * What went wrong on the wire, before the package classifies it into a public
 * outcome by the request's profile:
 * - `status`: Dotypos answered with this HTTP status. A 2xx status means its
 *   body could not be read.
 * - `transport`: the request never got an answer.
 * - `unreadable`: anything else, such as a response that failed generated
 *   decoding. It carries no status.
 */
export type DotyposWireOutcome =
  | {
      readonly kind: "status";
      readonly status: number;
      readonly providerError: DotyposProviderError | undefined;
    }
  | { readonly kind: "transport" }
  | { readonly kind: "unreadable" };

/**
 * A failed Dotypos exchange. `fromAccessToken` marks failures of the
 * access-token request, which runs before the addressed request is sent.
 */
export class DotyposWireFailure extends Data.TaggedError("DotyposWireFailure")<{
  readonly outcome: DotyposWireOutcome;
  readonly fromAccessToken: boolean;
  readonly cause?: unknown;
}> {}

interface IDotyposAccessToken {
  readonly get: Effect.Effect<string, DotyposWireFailure>;
  /** Forgets a cached token that Dotypos no longer accepts. */
  readonly invalidate: Effect.Effect<void>;
}

interface IDotyposGeneratedClient {
  /** Fails with the access token's failure when the token can't be acquired. */
  readonly client: DotyposClient<
    HttpClientError.HttpClientError | DotyposWireFailure
  >;
}

/** Tracks token acquisition for a write that must distinguish a timeout from a sent request. */
export const DotyposRequestDispatch = Context.Reference<
  { waitingForToken: boolean; expiredBeforeDispatch: boolean } | undefined
>("@deskohub/dotypos/DotyposRequestDispatch", {
  defaultValue: () => undefined,
});

type GeneratedClientError = {
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly cause: unknown;
};

/** A strong entity tag uses the opaque-tag grammar from RFC 9110 §8.8.3. */
export const isStrongEtag = (etag: string | undefined): etag is string =>
  etag !== undefined && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag);

export const makeDotyposClient = ({
  config,
  httpClient,
}: {
  config: DotyposRuntimeConfigObj;
  httpClient: HttpClient.HttpClient;
}): DotyposClient =>
  make(httpClient, {
    transformClient: (client) =>
      Effect.succeed(
        client.pipe(
          HttpClient.mapRequestInput((request) =>
            request.pipe(HttpClientRequest.prependUrl(config.apiUrl))
          )
        )
      ),
  });

export class DotyposAccessToken extends Context.Service<
  DotyposAccessToken,
  IDotyposAccessToken
>()("@deskohub/dotypos/DotyposAccessToken") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* DotyposRuntimeConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const client = makeDotyposClient({ config, httpClient });
      const tokenCache = yield* Cache.makeWith(
        (_key: "access-token") =>
          client
            .getAccessToken({
              params: { Authorization: `User ${config.refreshToken}` },
              payload: { _cloudId: config.cloudId },
            })
            .pipe(
              Effect.map((response) => response.accessToken),
              Effect.mapError((error) =>
                toDotyposWireFailure(error, { fromAccessToken: true })
              )
            ),
        {
          capacity: 1,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? "59 minutes" : 0),
        }
      );

      return {
        get: Cache.get(tokenCache, "access-token"),
        invalidate: Cache.invalidate(tokenCache, "access-token"),
      };
    })
  );
}

export class DotyposGeneratedClient extends Context.Service<
  DotyposGeneratedClient,
  IDotyposGeneratedClient
>()("@deskohub/dotypos/DotyposGeneratedClient") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* DotyposRuntimeConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const accessToken = yield* DotyposAccessToken;
      const authenticatedHttpClient = httpClient.pipe(
        HttpClient.mapRequestInputEffect(
          Effect.fnUntraced(function* (request) {
            const dispatch = yield* DotyposRequestDispatch;
            if (dispatch) dispatch.waitingForToken = true;
            const token = yield* accessToken.get;
            if (dispatch?.expiredBeforeDispatch) return yield* Effect.interrupt;
            if (dispatch) dispatch.waitingForToken = false;
            return request.pipe(
              HttpClientRequest.prependUrl(config.apiUrl),
              HttpClientRequest.setHeaders({
                Authorization: `Bearer ${token}`,
              })
            );
          })
        ),
        HttpClient.tap((response) =>
          Effect.when(
            accessToken.invalidate,
            Effect.succeed(response.status === 401)
          )
        )
      );

      return {
        client: make(authenticatedHttpClient),
      };
    })
  );
}

/**
 * Describes a failed Dotypos exchange. An access-token failure that surfaces
 * through the addressed request keeps its access-token origin.
 */
export const toDotyposWireFailure = (
  cause: unknown,
  { fromAccessToken }: { readonly fromAccessToken: boolean }
): DotyposWireFailure => {
  if (cause instanceof DotyposWireFailure) return cause;

  if (HttpClientError.isHttpClientError(cause)) {
    return httpClientWireFailure(cause, fromAccessToken);
  }

  if (isGeneratedClientError(cause)) {
    return statusFailure({
      providerError: providerErrorFrom(cause.cause),
      status: cause.response.status,
      fromAccessToken,
    });
  }

  if (isTransportException(cause)) {
    return new DotyposWireFailure({
      outcome: { kind: "transport" },
      fromAccessToken,
      cause,
    });
  }

  const providerError = providerErrorFrom(cause);
  if (providerError) {
    return statusFailure({
      providerError,
      status: providerError.code ?? 500,
      fromAccessToken,
    });
  }

  return new DotyposWireFailure({
    outcome: { kind: "unreadable" },
    fromAccessToken,
    cause,
  });
};

const httpClientWireFailure = (
  error: HttpClientError.HttpClientError,
  fromAccessToken: boolean
): DotyposWireFailure => {
  const reason = error.reason;
  if (
    Predicate.isTagged(reason, "TransportError") ||
    Predicate.isTagged(reason, "InvalidUrlError")
  ) {
    return new DotyposWireFailure({
      outcome: { kind: "transport" },
      fromAccessToken,
      cause: error,
    });
  }

  return statusFailure({
    providerError: providerErrorFrom(
      Predicate.hasProperty(reason, "description")
        ? reason.description
        : undefined
    ),
    status: error.response?.status,
    fromAccessToken,
  });
};

/** A thrown error that means the request never got an answer. */
const isTransportException = (cause: unknown) =>
  Predicate.isError(cause) &&
  (cause.name === "AbortError" ||
    cause.message.includes("fetch") ||
    cause.message.includes("ECONNREFUSED"));

/** A Dotypos error body, decoded or still as its JSON text. */
const decodeProviderErrorBody = Schema.decodeUnknownOption(
  Schema.Union([ErrorResponse, Schema.fromJsonString(ErrorResponse)])
);

/** The provider error a failure carries, if it carries a Dotypos error body. */
const providerErrorFrom = (cause: unknown) =>
  Option.match(decodeProviderErrorBody(cause), {
    onNone: () => undefined,
    onSome: toProviderError,
  });

const toProviderError = (
  error: DotyposErrorResponse
): DotyposProviderError | undefined => {
  const providerError: DotyposProviderError = {
    error: error.error,
    errorDescription: error.error_description,
    code: error.code,
  };

  return providerError.error ||
    providerError.errorDescription ||
    providerError.code !== undefined
    ? providerError
    : undefined;
};

const isGeneratedClientError = (
  cause: unknown
): cause is GeneratedClientError =>
  Predicate.hasProperty(cause, "response") &&
  Predicate.hasProperty(cause, "cause");

/**
 * A failure Dotypos answered with a status. It keeps only the parsed provider
 * error, never the request or response, as the cause.
 */
const statusFailure = ({
  providerError,
  status,
  fromAccessToken,
}: {
  readonly providerError: DotyposProviderError | undefined;
  readonly status: number | undefined;
  readonly fromAccessToken: boolean;
}) => {
  const httpStatus = status ?? providerError?.code;
  return new DotyposWireFailure({
    outcome:
      httpStatus === undefined
        ? { kind: "unreadable" }
        : { kind: "status", status: httpStatus, providerError },
    fromAccessToken,
    ...(providerError && { cause: providerError }),
  });
};
