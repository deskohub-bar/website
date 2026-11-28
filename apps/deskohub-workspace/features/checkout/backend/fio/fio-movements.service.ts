import "server-only";

import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import {
  BigDecimal,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientResponse,
} from "effect/http";
import type { createPatchedFetcher } from "next/dist/server/lib/patch-fetch";
import { parsePlainDate } from "@/shared/utils/temporal";

interface FioReceivingAccount {
  readonly accountNumber: string;
  readonly accountPrefix?: string;
  readonly bankCode: string;
}

export interface FioPeriod {
  readonly account: FioReceivingAccount;
  readonly readToken: Redacted.Redacted<string>;
  readonly from: string;
  readonly to: string;
}

export interface FioMovement {
  readonly movementId: string;
  readonly bookingDate: string;
  readonly constantSymbol: string | null;
  readonly amount:
    | { readonly _tag: "CZK"; readonly minorUnits: number }
    | {
        readonly _tag: "OtherCurrency";
        readonly currency: string;
        readonly decimalAmount: string;
      };
  readonly reference:
    | { readonly _tag: "VariableSymbol"; readonly value: string }
    | { readonly _tag: "Absent" }
    | { readonly _tag: "Invalid" };
}

class FioUnavailable extends Data.TaggedError("FioUnavailable")<{
  readonly reason:
    | "request-failed"
    | "timeout"
    | "rate-limited"
    | "http-status";
  readonly httpStatus?: number;
}> {}

export class FioRejected extends Data.TaggedError("FioRejected")<{
  readonly reason:
    | "invalid-request"
    | "invalid-response"
    | "account-mismatch"
    | "incomplete-period"
    | "period-too-large"
    | "http-status";
  readonly httpStatus?: number;
}> {}

export class FioHistoryAccessRequired extends Data.TaggedError(
  "FioHistoryAccessRequired"
) {}

type FioReadFailure = FioUnavailable | FioRejected | FioHistoryAccessRequired;

interface FioMovementsService {
  readonly readPeriod: (
    period: FioPeriod
  ) => Effect.Effect<readonly FioMovement[], FioReadFailure>;
}

export class FioMovements extends Context.Service<
  FioMovements,
  FioMovementsService
>()("FioMovements") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const http = HttpClient.withScope(yield* HttpClient.HttpClient);
      const readPeriod = Effect.fn("FioMovements.readPeriod")(
        function* (period: FioPeriod) {
          const { account, readToken, from, to } = period;
          const token = Redacted.value(readToken);
          if (
            !isValidPeriod(account, from, to) ||
            !/^[A-Za-z0-9_-]+$/.test(token)
          ) {
            return yield* new FioRejected({ reason: "invalid-request" });
          }
          const url = `https://fioapi.fio.cz/v1/rest/periods/${token}/${from}/${to}/transactions.json`;
          const response = yield* http
            .get(url)
            .pipe(
              Effect.mapError(
                () => new FioUnavailable({ reason: "request-failed" })
              )
            );
          if (response.status !== 200) {
            return yield* periodStatusFailure(response.status);
          }
          const body = yield* readStatementBody(response);
          return yield* decodePeriod(body, period);
        },
        (effect) =>
          effect.pipe(
            Effect.scoped,
            Effect.provideService(FetchHttpClient.RequestInit, {
              redirect: "error",
              cache: "no-store",
            }),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () =>
                Effect.fail(new FioUnavailable({ reason: "timeout" })),
            })
          )
      );
      return { readPeriod };
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(FetchHttpClient.Fetch, (fetch) =>
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, withoutFetchTracing(fetch))
            )
          )
        )
      )
    )
  );
}

function isValidPeriod(
  { accountNumber, accountPrefix = "0", bankCode }: FioReceivingAccount,
  from: string,
  to: string
): boolean {
  return (
    /^\d{1,10}$/.test(accountNumber) &&
    /^\d{1,6}$/.test(accountPrefix) &&
    /^\d{4}$/.test(bankCode) &&
    from <= to &&
    isIsoDate(from) &&
    isIsoDate(to)
  );
}

function isIsoDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) && Option.isSome(parsePlainDate(value))
  );
}

function withoutFetchTracing(
  fetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  // The Next.js wrapper collects fetch metrics independently of tracing.
  const originFetch = isNextPatchedFetch(fetch)
    ? fetch._nextOriginalFetch
    : fetch;
  // The origin can still include Vercel or other OpenTelemetry instrumentation.
  return Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      context.with(
        suppressTracing(context.active()),
        originFetch,
        undefined,
        input,
        init
      ),
    { preconnect: originFetch.preconnect }
  );
}

function isNextPatchedFetch(
  fetch: typeof globalThis.fetch
): fetch is ReturnType<typeof createPatchedFetcher> {
  return "__nextPatched" in fetch && fetch.__nextPatched === true;
}

function periodStatusFailure(httpStatus: number): FioReadFailure {
  switch (httpStatus) {
    case 409:
    case 429:
      return new FioUnavailable({ reason: "rate-limited", httpStatus });
    case 413:
      return new FioRejected({ reason: "period-too-large", httpStatus });
    case 422:
      return new FioHistoryAccessRequired();
    default:
      return httpStatus >= 500
        ? new FioUnavailable({ reason: "http-status", httpStatus })
        : new FioRejected({ reason: "http-status", httpStatus });
  }
}

const maxStatementBytes = 32 * 1024 * 1024;

const readStatementBody = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse
) {
  if (Number(response.headers["content-length"]) > maxStatementBytes) {
    return yield* new FioRejected({ reason: "period-too-large" });
  }

  const decoder = new TextDecoder();
  const { text } = yield* response.stream.pipe(
    Stream.mapError(() => new FioRejected({ reason: "invalid-response" })),
    Stream.runFoldEffect(
      () => ({ bytes: 0, text: "" }),
      (body, chunk) => {
        const bytes = body.bytes + chunk.byteLength;
        if (bytes > maxStatementBytes) {
          return Effect.fail(new FioRejected({ reason: "period-too-large" }));
        }
        const text = body.text + decoder.decode(chunk, { stream: true });
        return Effect.succeed({ bytes, text });
      }
    )
  );
  return text + decoder.decode();
});

class JsonNumberLexeme {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
}

const numericText = Schema.Union([
  Schema.String,
  Schema.instanceOf(JsonNumberLexeme),
]);
const numericColumn = Schema.Struct({ value: numericText });
const constantSymbolColumn = Schema.decodeUnknownOption(numericColumn);
const referenceColumn = Schema.decodeUnknownOption(
  Schema.Struct({ value: Schema.NullOr(Schema.String) })
);
const movement = Schema.Struct({
  column22: numericColumn,
  column0: numericColumn,
  column1: numericColumn,
  column14: Schema.Struct({ value: Schema.String }),
  column4: Schema.optionalKey(Schema.Unknown),
  column5: Schema.optionalKey(Schema.Unknown),
});
const statement = Schema.Struct({
  accountStatement: Schema.Struct({
    info: Schema.Struct({
      accountId: Schema.String,
      bankId: Schema.String,
      iban: Schema.String,
      dateStart: numericText,
      dateEnd: numericText,
      idFrom: Schema.optionalKey(Schema.NullOr(numericText)),
      idTo: Schema.optionalKey(Schema.NullOr(numericText)),
    }),
    transactionList: Schema.Struct({ rows: Schema.Array(movement) }).pipe(
      Schema.encodeKeys({ rows: "transaction" })
    ),
  }),
});

const decodeStatement = Schema.decodeUnknownOption(statement);
const parseJson = Option.liftThrowable((body: string): unknown =>
  // Preserve numeric literals before binary floating-point rounding can change them.
  JSON.parse(body, (_key, value, context?: { readonly source?: string }) => {
    const source = context?.source;
    return source && /^-?\d/.test(source)
      ? new JsonNumberLexeme(source)
      : value;
  })
);

function originalNumericText(value: typeof numericText.Type): string {
  return value instanceof JsonNumberLexeme ? value.source : value;
}

const decodePeriod = Effect.fnUntraced(function* (
  body: string,
  period: FioPeriod
) {
  const decoded = Option.flatMap(parseJson(body), decodeStatement);
  if (Option.isNone(decoded)) {
    return yield* new FioRejected({ reason: "invalid-response" });
  }

  const {
    info,
    transactionList: { rows },
  } = decoded.value.accountStatement;
  if (!matchesReceivingAccount(info, period.account)) {
    return yield* new FioRejected({ reason: "account-mismatch" });
  }
  if (
    fioBookingDate(originalNumericText(info.dateStart)) !== period.from ||
    fioBookingDate(originalNumericText(info.dateEnd)) !== period.to
  ) {
    return yield* new FioRejected({ reason: "incomplete-period" });
  }

  const movements: FioMovement[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const evidence = decodeMovement(row);
    if (
      !evidence ||
      evidence.bookingDate < period.from ||
      evidence.bookingDate > period.to ||
      ids.has(evidence.movementId)
    ) {
      return yield* new FioRejected({ reason: "invalid-response" });
    }
    ids.add(evidence.movementId);
    movements.push(evidence);
  }
  if (
    (info.idFrom != null &&
      !matchesMovementId(info.idFrom, movements[0]?.movementId)) ||
    (info.idTo != null &&
      !matchesMovementId(info.idTo, movements.at(-1)?.movementId))
  ) {
    return yield* new FioRejected({ reason: "incomplete-period" });
  }
  return movements;
});

function matchesReceivingAccount(
  info: {
    readonly accountId: string;
    readonly bankId: string;
    readonly iban: string;
  },
  account: FioReceivingAccount
): boolean {
  const { accountNumber, accountPrefix = "0", bankCode } = account;
  const prefix = accountPrefix.padStart(6, "0");
  const number = accountNumber.padStart(10, "0");
  const bban = `${bankCode}${prefix}${number}`;
  if (
    info.bankId !== bankCode ||
    !/^CZ\d{22}$/.test(info.iban) ||
    info.iban.slice(4) !== bban
  ) {
    return false;
  }
  if (BigInt(`${bban}1235${info.iban.slice(2, 4)}`) % 97n !== 1n) {
    return false;
  }

  // Fio specifies a 16-digit account field. The IBAN also distinguishes a
  // displayed base number from an account with a different prefix.
  if (/^\d{1,10}$/.test(info.accountId)) {
    return info.accountId.padStart(10, "0") === number;
  }
  if (/^\d{11,16}$/.test(info.accountId)) {
    return info.accountId.padStart(16, "0") === `${prefix}${number}`;
  }
  const domestic = /^(\d{1,6})-(\d{1,10})$/.exec(info.accountId);
  return (
    domestic?.[1]?.padStart(6, "0") === prefix &&
    domestic[2]?.padStart(10, "0") === number
  );
}

function decodeMovement(row: typeof movement.Type): FioMovement | undefined {
  const movementId = canonicalMovementId(row.column22.value);
  const date = fioBookingDate(originalNumericText(row.column0.value));
  const amount = decodeAmount(
    originalNumericText(row.column1.value),
    row.column14.value
  );
  if (!movementId || !date || !amount) {
    return undefined;
  }
  return {
    movementId,
    bookingDate: date,
    amount,
    constantSymbol: decodeConstantSymbol(row),
    reference: decodeReference(row),
  };
}

function canonicalMovementId(
  value: typeof numericText.Type
): string | undefined {
  const digits = originalNumericText(value);
  return /^\d+$/.test(digits) ? digits.replace(/^0+(?=\d)/, "") : undefined;
}

function matchesMovementId(
  value: typeof numericText.Type,
  movementId: string | undefined
): boolean {
  return movementId !== undefined && canonicalMovementId(value) === movementId;
}

function decodeAmount(
  decimalAmount: string,
  currency: string
): FioMovement["amount"] | undefined {
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimalAmount)
  ) {
    return undefined;
  }
  if (currency !== "CZK") {
    return { _tag: "OtherCurrency", currency, decimalAmount };
  }

  const decimal = BigDecimal.fromString(decimalAmount);
  if (Option.isNone(decimal)) {
    return undefined;
  }
  const scaled = BigDecimal.multiply(
    decimal.value,
    BigDecimal.fromBigInt(100n)
  );
  const minorUnits = BigDecimal.toNumberUnsafe(scaled);
  return BigDecimal.isInteger(scaled) && Number.isSafeInteger(minorUnits)
    ? { _tag: "CZK", minorUnits }
    : undefined;
}

function decodeConstantSymbol({
  column4,
}: Pick<typeof movement.Type, "column4">): FioMovement["constantSymbol"] {
  const decoded = constantSymbolColumn(column4);
  if (Option.isNone(decoded)) return null;

  const digits = originalNumericText(decoded.value.value);
  return /^\d{1,4}$/.test(digits) ? digits.padStart(4, "0") : null;
}

function decodeReference({
  column5,
}: Pick<typeof movement.Type, "column5">): FioMovement["reference"] {
  if (column5 == null) {
    return { _tag: "Absent" };
  }
  const decoded = referenceColumn(column5);
  if (Option.isNone(decoded)) {
    return { _tag: "Invalid" };
  }
  const { value } = decoded.value;
  if (value === null || value === "") {
    return { _tag: "Absent" };
  }
  if (!/^\d{1,10}$/.test(value)) {
    return { _tag: "Invalid" };
  }
  return { _tag: "VariableSymbol", value: value.replace(/^0+(?=\d)/, "") };
}

function fioBookingDate(value: string): string | undefined {
  if (/^-?\d{1,16}$/.test(value)) {
    const epochMilliseconds = Number(value);
    if (Math.abs(epochMilliseconds) <= 8_640_000_000_000_000) {
      return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
        .toZonedDateTimeISO("Europe/Prague")
        .toPlainDate()
        .toString();
    }
  }
  if (/^\d{4}-\d{2}-\d{2}(?:[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/.test(value)) {
    const date = value.slice(0, 10);
    return isIsoDate(date) ? date : undefined;
  }
  return undefined;
}
