import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Schedule,
  Schema,
  SynchronizedRef,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/**
 * No OAuth access token for Google APIs. Carries no token or response body.
 */
export class GoogleAccessTokenError extends Data.TaggedError(
  "GoogleAccessTokenError"
)<{
  readonly reason: "transport" | "timeout" | "status" | "invalid-response";
  readonly httpStatus?: number | undefined;
}> {}

interface IGoogleAccessToken {
  /** An OAuth access token of the runtime's service account. */
  readonly get: Effect.Effect<string, GoogleAccessTokenError>;
  /**
   * Drops `token` after a Google API rejected it, so the next `get` fetches
   * another. A newer token stays.
   */
  readonly invalidate: (token: string) => Effect.Effect<void>;
}

/** Authorizes calls to Google APIs as the runtime's service account. */
export class GoogleAccessToken extends Context.Service<
  GoogleAccessToken,
  IGoogleAccessToken
>()("@deskohub-workspace/GoogleAccessToken") {}

/** Where a Cloud Run service reads its service account's access token. */
const metadataServerTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Bounds each attempt, response body included. */
const attemptTimeout = Duration.seconds(10);
const retrySchedule = Schedule.exponential("200 millis");
const retries = 2;
/**
 * Bounds a whole refresh, retry waits included: a `Retry-After` may ask for
 * longer, and callers wait on the cache lock meanwhile.
 */
const refreshDeadline = Duration.seconds(30);
/** Refreshes a token this long before it expires. */
const expiryMargin = Duration.minutes(1);

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Finite,
});
type TokenResponse = typeof TokenResponse.Type;

type CachedToken = {
  readonly accessToken: string;
  readonly refreshAtMillis: number;
};

/**
 * Reads the token from the Cloud Run metadata server and reuses it until
 * shortly before it expires. Concurrent callers share one refresh.
 */
export const MetadataServerGoogleAccessToken: Layer.Layer<GoogleAccessToken> =
  Layer.effect(
    GoogleAccessToken,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const cache = yield* SynchronizedRef.make(Option.none<CachedToken>());

      // Each attempt reads the whole body under its timeout, and a body
      // that breaks off is retried like a lost connection.
      const metadataClient = client.pipe(
        HttpClient.filterStatusOk,
        HttpClient.transformResponse(
          Effect.tap((response) => response.arrayBuffer)
        ),
        HttpClient.timeout(attemptTimeout),
        HttpClient.retryTransient({
          schedule: retrySchedule,
          times: retries,
          while: isBodyReadFailure,
        })
      );

      const requestToken = metadataClient
        .execute(
          HttpClientRequest.get(metadataServerTokenUrl).pipe(
            HttpClientRequest.setHeader("Metadata-Flavor", "Google")
          )
        )
        .pipe(
          Effect.mapError(toTokenError),
          Effect.flatMap(readTokenResponse),
          Effect.timeoutOrElse({
            duration: refreshDeadline,
            orElse: () =>
              Effect.fail(new GoogleAccessTokenError({ reason: "timeout" })),
          })
        );

      const fetchToken = Effect.Do.pipe(
        Effect.bind("response", () => requestToken),
        Effect.bind("now", () => Clock.currentTimeMillis),
        Effect.map(toCachedToken)
      );

      const reuseOrRefresh = (cached: Option.Option<CachedToken>) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            Option.filter(
              cached,
              ({ refreshAtMillis }) => now < refreshAtMillis
            )
          ),
          Effect.flatMap(
            Option.match({
              onSome: ({ accessToken }) =>
                Effect.succeed([accessToken, cached] as const),
              onNone: () =>
                fetchToken.pipe(
                  Effect.map(
                    (token) => [token.accessToken, Option.some(token)] as const
                  )
                ),
            })
          )
        );

      return {
        get: SynchronizedRef.modifyEffect(cache, reuseOrRefresh).pipe(
          Effect.withSpan("GoogleAccessToken.get")
        ),
        invalidate: (token) =>
          SynchronizedRef.update(
            cache,
            Option.filter(({ accessToken }) => accessToken !== token)
          ),
      };
    })
  ).pipe(Layer.provide(FetchHttpClient.layer));

const readTokenResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
    Effect.mapError(
      () => new GoogleAccessTokenError({ reason: "invalid-response" })
    )
  );

const isBodyReadFailure = ({ reason }: HttpClientError.HttpClientError) =>
  reason._tag === "DecodeError";

const toTokenError = ({ reason }: HttpClientError.HttpClientError) =>
  Match.value(reason).pipe(
    Match.tag(
      "StatusCodeError",
      ({ response }) =>
        new GoogleAccessTokenError({
          reason: "status",
          httpStatus: response.status,
        })
    ),
    Match.when(
      { _tag: "TransportError", cause: Cause.isTimeoutError },
      () => new GoogleAccessTokenError({ reason: "timeout" })
    ),
    Match.orElse(() => new GoogleAccessTokenError({ reason: "transport" }))
  );

const toCachedToken = ({
  response,
  now,
}: {
  readonly response: TokenResponse;
  readonly now: number;
}): CachedToken => ({
  accessToken: response.access_token,
  refreshAtMillis:
    now + response.expires_in * 1000 - Duration.toMillis(expiryMargin),
});
