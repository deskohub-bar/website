import {
  type SupportedLocale,
  supportedLocales,
} from "@deskohub/i18n/locale-registry";
import { Context, Effect, Option, Schema } from "effect";
import { Headers } from "effect/http";
import { RpcMiddleware } from "effect/rpc";
import { CorrelationId, correlationIdHeader } from "./correlation";
import { BackendUnavailable } from "./errors";

export interface AnonymousCaller {
  readonly correlationId: string;
  readonly locale: SupportedLocale;
  readonly clientAddress: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
}

export class Caller extends Context.Service<Caller, AnonymousCaller>()(
  "@deskohub/workspace-rpc/Caller"
) {}

export class InvalidCallerHeaders extends Schema.TaggedError<InvalidCallerHeaders>()(
  "InvalidCallerHeaders",
  {}
) {}

export class CallerContext extends RpcMiddleware.Service<
  CallerContext,
  { provides: Caller; clientError: BackendUnavailable }
>()("@deskohub/workspace-rpc/CallerContext", {
  error: InvalidCallerHeaders,
  requiredForClient: true,
}) {}

const localeHeader = "x-deskohub-locale";
const addressHeader = "x-deskohub-client-address";
// Fetch can add its own transport User-Agent. The RPC server joins it with
// the per-RPC headers, so the browser value needs a separate header name.
const userAgentHeader = "x-deskohub-user-agent";

const decodeIpAddress = Schema.decodeUnknownOption(Schema.IpAddressFromString);

// A browser user-agent can contain commas. Its wire value cannot, so a
// transport header joined with an RPC header fails before it is decoded.
// Base64url needs up to four characters per UTF-16 code unit of the UA.
const maxUserAgentLength = 2048;
const UserAgent = Schema.String.check(
  Schema.isMaxLength(maxUserAgentLength * 4),
  Schema.isBase64Url()
).pipe(
  Schema.decodeTo(Schema.StringFromBase64Url),
  Schema.check(
    Schema.isMaxLength(maxUserAgentLength),
    Schema.isPattern(/^[^\r\n]+$/),
    Schema.makeFilter((value) => !value.includes("\0"), {
      expected: "no NUL bytes",
    })
  )
);

export const CallerHeaders = Schema.Struct({
  [correlationIdHeader]: CorrelationId,
  [localeHeader]: Schema.Literals(supportedLocales),
  [addressHeader]: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter((value) => Option.isSome(decodeIpAddress(value)), {
        expected: "a single IP address",
      })
    )
  ),
  [userAgentHeader]: Schema.optionalKey(UserAgent),
});

const decodeHeaders = Schema.decodeUnknownEffect(CallerHeaders);

export const decodeCallerHeaders = (
  headers: Headers.Headers
): Effect.Effect<AnonymousCaller, InvalidCallerHeaders> =>
  decodeHeaders(headers).pipe(
    Effect.map((caller) => ({
      correlationId: caller[correlationIdHeader],
      locale: caller[localeHeader],
      clientAddress: Option.fromNullishOr(caller[addressHeader]),
      userAgent: Option.fromNullishOr(caller[userAgentHeader]),
    })),
    Effect.mapError(() => new InvalidCallerHeaders())
  );

const encodeHeaders = Schema.encodeEffect(CallerHeaders);

export const encodeCallerHeaders = (caller: AnonymousCaller) =>
  encodeHeaders({
    [correlationIdHeader]: caller.correlationId,
    [localeHeader]: caller.locale,
    ...Option.match(caller.clientAddress, {
      onNone: () => ({}),
      onSome: (address) => ({ [addressHeader]: address }),
    }),
    ...Option.match(caller.userAgent, {
      onNone: () => ({}),
      onSome: (userAgent) => ({ [userAgentHeader]: userAgent }),
    }),
  }).pipe(
    Effect.map(Headers.fromInput),
    Effect.mapError(() => new BackendUnavailable({ reason: "caller" }))
  );

export const layerCallerContextClient = (caller: AnonymousCaller) =>
  RpcMiddleware.layerClient(CallerContext, ({ next, request }) =>
    encodeCallerHeaders(caller).pipe(
      Effect.flatMap((headers) => next({ ...request, headers }))
    )
  );
