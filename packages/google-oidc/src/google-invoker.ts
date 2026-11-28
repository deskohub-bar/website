import { Context, Data, Effect, Option, Schema } from "effect";
import {
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from "jose";

/**
 * A Google service account allowed to call a private worker: the account a
 * Cloud Tasks queue or Cloud Scheduler job signs its OIDC token as, and the
 * audience it signs the token for.
 */
export interface GoogleInvoker {
  readonly email: string;
  readonly audience: string;
}

const googleCertificatesUrl = new URL(
  "https://www.googleapis.com/oauth2/v3/certs"
);
let googleSigningKeys: JWTVerifyGetKey | undefined;

/**
 * The keys Google signs OIDC tokens with. The default fetches and caches
 * Google's published key set, refetching for an unknown key ID; tests provide
 * a local key set.
 */
export const GoogleIdentityKeys = Context.Reference<JWTVerifyGetKey>(
  "@deskohub-workspace/GoogleIdentityKeys",
  {
    defaultValue: () => {
      googleSigningKeys ??= createRemoteJWKSet(googleCertificatesUrl);
      return googleSigningKeys;
    },
  }
);

const googleIssuers = ["https://accounts.google.com", "accounts.google.com"];

/** Google OIDC tokens live one hour; allow for clock drift either side. */
const maxTokenAgeSeconds = 60 * 60;
const clockToleranceSeconds = 30;

/**
 * Why a request is not from the expected invoker. It never carries the token
 * or its claims, so it is safe to log.
 */
class GoogleInvokerRejection extends Data.TaggedError(
  "GoogleInvokerRejection"
)<{
  /**
   * 401 without a valid Google token, including while Google's keys are
   * unreachable; 403 for a valid, verified one from another account.
   */
  readonly status: 401 | 403;
  readonly reason:
    | "invoker-not-configured"
    | "missing-bearer-token"
    | "invalid-token"
    | "key-set-unavailable"
    | "unexpected-invoker";
  /** The jose error code, such as `ERR_JWT_EXPIRED`. */
  readonly code?: string;
}> {}

const decodeVerifiedIdentity = Schema.decodeUnknownOption(
  Schema.Struct({
    email: Schema.NonEmptyString,
    email_verified: Schema.Literal(true),
  })
);

/**
 * The token of a Bearer credential. The scheme is case-insensitive and one or
 * more spaces separate it from the token (RFC 9110, RFC 6750).
 */
const bearerToken = (request: Request) =>
  request.headers
    .get("authorization")
    ?.match(/^bearer +([\w-]+\.[\w-]+\.[\w-]+)$/i)?.[1];

/**
 * Fetching Google's key set fails with a timeout, an invalid set, a generic
 * JOSE error for a non-200 or non-JSON response, or a plain fetch error; any
 * other JOSE error rejects the token itself.
 */
const keySetErrorCodes = new Set<string>([
  joseErrors.JWKSTimeout.code,
  joseErrors.JWKSInvalid.code,
  joseErrors.JOSEError.code,
]);

const verifyToken = Effect.fnUntraced(function* (
  token: string,
  invoker: GoogleInvoker
) {
  const keys = yield* GoogleIdentityKeys;
  return yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: googleIssuers,
        audience: invoker.audience,
        maxTokenAge: maxTokenAgeSeconds,
        clockTolerance: clockToleranceSeconds,
        requiredClaims: ["exp", "iat", "email"],
      }),
    catch: (error) =>
      new GoogleInvokerRejection({
        status: 401,
        ...(error instanceof joseErrors.JOSEError
          ? {
              reason: keySetErrorCodes.has(error.code)
                ? "key-set-unavailable"
                : "invalid-token",
              code: error.code,
            }
          : { reason: "key-set-unavailable", code: "ERR_KEY_SET_FETCH" }),
      }),
  });
});

/**
 * Authenticates a request as `invoker`: a Google-signed RS256 OIDC bearer
 * token for exactly its audience, from Google's issuer, unexpired, whose
 * verified `email` is the invoker's account. Without an invoker, every request
 * is rejected, so a host missing its settings fails closed. Transport headers
 * such as `X-CloudTasks-*` never authenticate a request.
 */
export const authenticateGoogleInvoker = Effect.fn(
  "googleOidc.authenticateInvoker"
)(function* (request: Request, invoker: GoogleInvoker | undefined) {
  if (invoker === undefined) {
    return yield* new GoogleInvokerRejection({
      status: 401,
      reason: "invoker-not-configured",
    });
  }
  const token = bearerToken(request);
  if (token === undefined) {
    return yield* new GoogleInvokerRejection({
      status: 401,
      reason: "missing-bearer-token",
    });
  }

  const { payload } = yield* verifyToken(token, invoker);
  // jose accepts an audience array that contains the audience; Google signs
  // a single audience.
  if (payload.aud !== invoker.audience) {
    return yield* new GoogleInvokerRejection({
      status: 401,
      reason: "invalid-token",
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
  }
  // Only a verified identity can be the wrong account.
  const identity = decodeVerifiedIdentity(payload);
  if (Option.isNone(identity)) {
    return yield* new GoogleInvokerRejection({
      status: 401,
      reason: "invalid-token",
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
  }
  if (identity.value.email !== invoker.email) {
    return yield* new GoogleInvokerRejection({
      status: 403,
      reason: "unexpected-invoker",
    });
  }
});
