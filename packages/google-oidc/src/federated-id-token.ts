import {
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Tracer,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { decodeJwt } from "jose";

interface TokenTarget {
  readonly serviceAccount: string;
  readonly audience: string;
  /** The provider's full STS audience, starting with //iam.googleapis.com/. */
  readonly workloadIdentityProvider: string;
}

interface FederatedTokenRequest extends TokenTarget {
  /** Loads the external credential from the request that starts the mint. */
  readonly getSubjectToken: () => Promise<string>;
}

interface GoogleIdTokenService {
  readonly get: (
    request: FederatedTokenRequest
  ) => Effect.Effect<Redacted.Redacted<string>, GoogleIdTokenMintError>;
  readonly evict: (
    target: TokenTarget,
    token: Redacted.Redacted<string>
  ) => Effect.Effect<void>;
}

interface CachedToken {
  readonly state: "ready";
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

interface PendingMint {
  readonly state: "minting";
  readonly result: Deferred.Deferred<CachedToken, GoogleIdTokenMintError>;
}

const refreshSkewMillis = 5 * 60 * 1000;

const tokenKey = ({
  serviceAccount,
  audience,
  workloadIdentityProvider,
}: TokenTarget) =>
  JSON.stringify([serviceAccount, audience, workloadIdentityProvider]);

export class GoogleIdToken extends Context.Service<
  GoogleIdToken,
  GoogleIdTokenService
>()("@deskohub/google-oidc/GoogleIdToken") {
  /** Share one layer per deployment identity to reuse tokens across requests. */
  static readonly Default = Layer.effect(
    GoogleIdToken,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const scope = yield* Effect.scope;
      const cache = yield* Ref.make(
        new Map<string, CachedToken | PendingMint>()
      );

      const get: GoogleIdTokenService["get"] = (request) =>
        Effect.uninterruptibleMask(
          Effect.fnUntraced(function* (restore) {
            const now = yield* Clock.currentTimeMillis;
            const key = tokenKey(request);
            const pending: PendingMint = {
              state: "minting",
              result: yield* Deferred.make<
                CachedToken,
                GoogleIdTokenMintError
              >(),
            };
            const entry = yield* Ref.modify(cache, (entries) => {
              const current = entries.get(key);
              if (
                current?.state === "minting" ||
                (current?.state === "ready" &&
                  current.expiresAt - now >= refreshSkewMillis)
              ) {
                return [current, entries];
              }
              return [pending, new Map(entries).set(key, pending)];
            });
            if (entry.state === "ready") {
              return entry.token;
            }
            if (entry === pending) {
              // The layer owns the mint so disconnecting one caller does not
              // strand other callers already awaiting the same token.
              yield* Effect.forkIn(
                Effect.gen(function* () {
                  const exit = yield* Effect.exit(
                    Effect.interruptible(mintToken(client, request))
                  );
                  yield* Ref.update(cache, (entries) => {
                    const updated = new Map(entries);
                    if (Exit.isSuccess(exit)) {
                      updated.set(key, exit.value);
                    } else {
                      updated.delete(key);
                    }
                    return updated;
                  });
                  yield* Deferred.done(pending.result, exit);
                }),
                scope,
                { startImmediately: true, uninterruptible: true }
              );
            }
            const { token } = yield* restore(Deferred.await(entry.result));
            return token;
          })
        );

      const evict: GoogleIdTokenService["evict"] = (target, token) =>
        Ref.update(cache, (entries) => {
          const key = tokenKey(target);
          const entry = entries.get(key);
          if (entry?.state !== "ready" || entry.token !== token) {
            return entries;
          }
          const updated = new Map(entries);
          updated.delete(key);
          return updated;
        });

      return { get, evict };
    })
  );
}

type MintPhase = "subject-token" | "sts" | "iam";

/** Contains only fixed labels and a status, since HTTP errors can hold tokens. */
export class GoogleIdTokenMintError extends Data.TaggedError(
  "GoogleIdTokenMintError"
)<{
  readonly phase: MintPhase;
  readonly reason:
    | "subject-token-unavailable"
    | "transport"
    | "timeout"
    | "http-status"
    | "invalid-response";
  readonly status?: number;
}> {}

const stsResponse = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.NonEmptyString.check(
      Schema.isPattern(/^[a-z0-9._~+/-]+=*$/i)
    ),
  })
);
const iamResponse = Schema.fromJsonString(
  Schema.Struct({ token: Schema.NonEmptyString })
);
const tokenClaims = Schema.Struct({ exp: Schema.Int });

const mintToken = (
  client: HttpClient.HttpClient,
  request: FederatedTokenRequest
) => {
  const unavailable = new GoogleIdTokenMintError({
    phase: "subject-token",
    reason: "subject-token-unavailable",
  });
  return Effect.tryPromise({
    try: () => request.getSubjectToken(),
    catch: () => unavailable,
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(unavailable),
    }),
    Effect.filterOrFail(
      (token) => token.length > 0,
      () => unavailable
    ),
    Effect.flatMap((subjectToken) =>
      exchangeToken(client, request, subjectToken)
    )
  );
};

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

const exchangeToken = (
  client: HttpClient.HttpClient,
  target: TokenTarget,
  subjectToken: string
) =>
  Effect.suspend(() => {
    // Local to this mint. An IAM retry can reuse a successful STS exchange.
    let accessToken = Option.none<string>();
    const fetchAccessToken = exchangeSubjectToken(
      client,
      target.workloadIdentityProvider,
      subjectToken
    ).pipe(
      Effect.tap((token) =>
        Effect.sync(() => {
          accessToken = Option.some(token);
        })
      )
    );
    return Effect.suspend(() =>
      Option.match(accessToken, {
        onNone: () => fetchAccessToken,
        onSome: Effect.succeed,
      })
    ).pipe(
      Effect.flatMap((token) => generateIdToken(client, target, token)),
      Effect.flatMap(decodeIssuedToken),
      Effect.retry({
        schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
        times: 2,
        while: (error) =>
          error.reason === "transport" ||
          error.reason === "timeout" ||
          (error.status !== undefined && transientStatuses.has(error.status)),
      })
    );
  });

const exchangeSubjectToken = (
  client: HttpClient.HttpClient,
  workloadIdentityProvider: string,
  subjectToken: string
) =>
  readGoogleResponse(
    client,
    "sts",
    HttpClientRequest.post("https://sts.googleapis.com/v1/token").pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: workloadIdentityProvider,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        subject_token: subjectToken,
      })
    ),
    stsResponse
  ).pipe(Effect.map(({ access_token }) => access_token));

const generateIdToken = (
  client: HttpClient.HttpClient,
  { serviceAccount, audience }: TokenTarget,
  accessToken: string
) =>
  readGoogleResponse(
    client,
    "iam",
    HttpClientRequest.post(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateIdToken`
    ).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.bodyJsonUnsafe({ audience, includeEmail: true })
    ),
    iamResponse
  ).pipe(Effect.map(({ token }) => token));

const decodeIssuedToken = Effect.fnUntraced(function* (token: string) {
  const invalid = new GoogleIdTokenMintError({
    phase: "iam",
    reason: "invalid-response",
  });
  // IAM returned this token directly over HTTPS. Decode exp for caching.
  const payload = yield* Effect.try({
    try: () => decodeJwt(token),
    catch: () => invalid,
  });
  const { exp } = yield* Schema.decodeUnknownEffect(tokenClaims)(payload).pipe(
    Effect.mapError(() => invalid)
  );
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = exp * 1000;
  if (expiresAt <= now) {
    return yield* invalid;
  }
  return {
    state: "ready" as const,
    token: Redacted.make(token),
    expiresAt,
  };
});

const readGoogleResponse = Effect.fnUntraced(
  function* <A>(
    client: HttpClient.HttpClient,
    phase: "sts" | "iam",
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, string>
  ) {
    const transportFailure = () =>
      new GoogleIdTokenMintError({ phase, reason: "transport" });
    const response = yield* HttpClient.withScope(client)
      .execute(request)
      .pipe(Effect.mapError(transportFailure));
    if (response.status < 200 || response.status >= 300) {
      return yield* new GoogleIdTokenMintError({
        phase,
        reason: "http-status",
        status: response.status,
      });
    }
    return yield* response.text.pipe(
      Effect.mapError(transportFailure),
      Effect.flatMap((text) =>
        Schema.decodeEffect(schema)(text).pipe(
          Effect.mapError(
            () =>
              new GoogleIdTokenMintError({ phase, reason: "invalid-response" })
          )
        )
      )
    );
  },
  (effect, _client, phase) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () =>
          Effect.fail(new GoogleIdTokenMintError({ phase, reason: "timeout" })),
      }),
      Effect.provideService(Tracer.DisablePropagation, true),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" })
    )
);
