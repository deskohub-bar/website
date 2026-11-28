import "server-only";

import { createHash } from "node:crypto";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { env } from "@/env";

export interface FioReceivingAccountDisplay {
  readonly accountKey: string;
  readonly accountNumber: string;
  readonly accountPrefix?: string | undefined;
  readonly bankCode: string;
}

export interface FioReceivingAccount {
  readonly accountKey: string;
  readonly account: Omit<FioReceivingAccountDisplay, "accountKey">;
  readonly readToken: Redacted.Redacted<string>;
}

interface IFioAccounts {
  readonly getReceivingAccount: (
    accountKey: string
  ) => FioReceivingAccount | undefined;
  readonly getDefaultReceivingAccount: () =>
    | FioReceivingAccountDisplay
    | undefined;
  readonly getReceivingAccountDisplay: (
    accountKey: string
  ) => FioReceivingAccountDisplay | undefined;
}

export class FioAccounts extends Context.Service<FioAccounts, IFioAccounts>()(
  "FioAccounts"
) {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const accounts = parseAccounts(env.FIO_RECEIVING_ACCOUNTS ?? "[]");
      const enabled = env.FIO_QR_PAYMENTS_ENABLED === "true";
      if (!accounts || (enabled && accounts.length === 0)) {
        yield* Effect.logError(
          "Fio receiving accounts unavailable. Check Workspace FIO_RECEIVING_ACCOUNTS configuration."
        );
      }
      const byKey = new Map(
        accounts?.map((account) => [account.accountKey, account])
      );
      const defaultAccount = enabled ? accounts?.[0] : undefined;

      return {
        getReceivingAccount: (accountKey) => byKey.get(accountKey),
        getDefaultReceivingAccount: () => displayAccount(defaultAccount),
        getReceivingAccountDisplay: (accountKey) =>
          enabled ? displayAccount(byKey.get(accountKey)) : undefined,
      };
    })
  );
}

const displayAccount = (configured: FioReceivingAccount | undefined) =>
  configured && { accountKey: configured.accountKey, ...configured.account };

const decodeAccounts = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        accountNumber: Schema.String.check(
          Schema.isPattern(/^(?=.*[1-9])[0-9]{1,10}$/)
        ),
        accountPrefix: Schema.optional(
          Schema.String.check(Schema.isPattern(/^[0-9]{1,6}$/))
        ),
        bankCode: Schema.String.check(Schema.isPattern(/^[0-9]{4}$/)),
        readToken: Schema.String.check(Schema.isPattern(/^\S+$/)),
      })
    )
  )
);

const parseAccounts = (
  raw: string
): ReadonlyArray<FioReceivingAccount> | undefined => {
  const decoded = decodeAccounts(raw);
  if (Option.isNone(decoded)) return undefined;

  const accounts = decoded.value.map((input) => {
    const accountNumber = input.accountNumber.replace(/^0+/, "");
    const accountPrefix = input.accountPrefix?.replace(/^0+/, "");
    const { bankCode } = input;
    const accountKey = createHash("sha256")
      .update(`${accountPrefix ?? ""}:${accountNumber}:${bankCode}`)
      .digest("hex");

    return {
      accountKey,
      account: accountPrefix
        ? { accountNumber, accountPrefix, bankCode }
        : { accountNumber, bankCode },
      readToken: Redacted.make(input.readToken),
    };
  });

  const uniqueAccounts = new Set(accounts.map(({ accountKey }) => accountKey));
  const uniqueTokens = new Set(decoded.value.map(({ readToken }) => readToken));
  return uniqueAccounts.size === accounts.length &&
    uniqueTokens.size === accounts.length
    ? accounts
    : undefined;
};
