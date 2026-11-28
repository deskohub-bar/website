"use server";

import { Effect, Layer, Schema } from "effect";
import { accountActionError } from "@/features/account/account-action-guards";
import { requireAccountFeature } from "@/features/account/backend/account-feature-withheld";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { requireVerifiedSession } from "@/features/account/backend/verified-customer-session";
import type {
  CustomerAccountAccessError,
  CustomerAccountId,
} from "@/features/account/customer-account";
import type { Locale } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { CoworkPassesReleaseGateRequest } from "@/features/passes/backend/cowork-passes-release-gate.server";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  type WithdrawalRefusedError,
  WithdrawalService,
  type WithdrawalUnavailableError,
} from "@/features/withdrawal/backend/withdrawal.service";
import { WithdrawalReleaseGate } from "@/features/withdrawal/backend/withdrawal-release-gate";
import { WithdrawalReleaseGateRequest } from "@/features/withdrawal/backend/withdrawal-release-gate.server";
import type { WithdrawableContractRef } from "@/features/withdrawal/withdrawable-contract";
import {
  toWithdrawalQuoteData,
  toWithdrawalReceiptData,
  type WithdrawalQuoteData,
  type WithdrawalReceiptData,
  type WithdrawalRefusal,
} from "@/features/withdrawal/withdrawal-read-model";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";

const withdrawalContractSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("reservation"),
    orderId: workspaceReservationIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literals(["entry-pack", "unlimited-pass"]),
    orderId: orderIdSchema,
  }),
]);

const withdrawalQuoteSchema = Schema.toStandardSchemaV1(
  Schema.Struct({ contract: withdrawalContractSchema }),
  { parseOptions: { errors: "all", onExcessProperty: "error" } }
);

const withdrawalStatementSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    contract: withdrawalContractSchema,
    refundTermsKey: Schema.optionalKey(Schema.String),
    customerName: Schema.optionalKey(Schema.String),
  }),
  { parseOptions: { errors: "all", onExcessProperty: "error" } }
);

/** The quote, or why the customer can't withdraw from the reservation now. */
export type WithdrawalQuoteResult =
  | { readonly status: "available"; readonly quote: WithdrawalQuoteData }
  | { readonly status: "refused"; readonly reason: WithdrawalRefusal };

/**
 * The receipt, why the withdrawal wasn't accepted, or that the statement
 * needs the customer's name (the profile has none and none was typed).
 */
export type WithdrawalResult =
  | { readonly status: "withdrawn"; readonly receipt: WithdrawalReceiptData }
  | { readonly status: "refund_changed"; readonly quote: WithdrawalQuoteData }
  | { readonly status: "refused"; readonly reason: WithdrawalRefusal }
  | { readonly status: "name_required" };

/**
 * Runs a withdrawal operation for the signed-in customer while the online
 * withdrawal function is released; a closed gate reads as "unavailable".
 * Refusals are result data the client acts on; account failures read as the
 * account's errors, and anything else as the runtime's unexpected failure.
 */
const runForSignedInCustomer = <A>(
  locale: Locale,
  kind: WithdrawableContractRef["kind"],
  operation: (
    withdrawals: WithdrawalService["Service"],
    accountId: CustomerAccountId
  ) => Effect.Effect<
    A,
    | WithdrawalRefusedError
    | WithdrawalUnavailableError
    | CustomerAccountAccessError
  >
) =>
  Effect.gen(function* () {
    yield* requireAccountFeature("withdrawal", WithdrawalReleaseGate.isOpen);
    if (kind !== "reservation") {
      yield* requireAccountFeature(
        "withdrawal",
        CoworkPassesReleaseGate.isOpen.pipe(
          Effect.provide(CoworkPassesReleaseGateRequest)
        )
      );
    }
    const user = yield* requireVerifiedSession;
    const withdrawals = yield* WithdrawalService;
    return yield* operation(withdrawals, user.accountId);
  }).pipe(
    Effect.map((value) => ({ status: "done" as const, value })),
    Effect.catchTag("WithdrawalRefusedError", ({ reason }) =>
      Effect.succeed({ status: "refused" as const, reason })
    ),
    Effect.catchTags({
      CustomerAccountAccessError: (error) =>
        Effect.fail(accountActionError(locale)(error)),
      AccountFeatureWithheldError: (error) =>
        Effect.fail(accountActionError(locale)(error)),
    }),
    Effect.provide(
      Layer.mergeAll(
        WithdrawalService.Live,
        CustomerAuthentication.Default,
        WithdrawalReleaseGateRequest
      )
    )
  );

const quoteWithdrawal = (locale: Locale, contract: WithdrawableContractRef) =>
  runForSignedInCustomer(locale, contract.kind, (withdrawals, accountId) =>
    withdrawals.quote({
      accountId,
      locale,
      contract,
    })
  ).pipe(
    Effect.map(
      (result): WithdrawalQuoteResult =>
        result.status === "done"
          ? {
              status: "available",
              quote: toWithdrawalQuoteData(result.value),
            }
          : result
    )
  );

const submitWithdrawal = (
  locale: Locale,
  contract: WithdrawableContractRef,
  input: { readonly refundTermsKey?: string; readonly customerName?: string }
) =>
  runForSignedInCustomer(locale, contract.kind, (withdrawals, accountId) =>
    withdrawals
      .withdraw({
        accountId,
        locale,
        contract,
        ...(input.refundTermsKey !== undefined && {
          refundTermsKey: input.refundTermsKey,
        }),
        ...(input.customerName !== undefined && {
          customerName: input.customerName,
        }),
      })
      .pipe(
        Effect.map(
          (receipt): WithdrawalResult => ({
            status: "withdrawn",
            receipt: toWithdrawalReceiptData(receipt),
          })
        ),
        Effect.catchTags({
          WithdrawalNameRequiredError: () =>
            Effect.succeed<WithdrawalResult>({
              status: "name_required",
            }),
          WithdrawalRefundChangedError: ({ quote }) =>
            Effect.succeed<WithdrawalResult>({
              status: "refund_changed",
              quote: toWithdrawalQuoteData(quote),
            }),
        })
      )
  ).pipe(
    Effect.map(
      (result): WithdrawalResult =>
        result.status === "done" ? result.value : result
    )
  );

const quoteContractWithdrawalAction = defineWorkspaceAction(
  {
    operation: "account.quote-contract-withdrawal",
    schema: withdrawalQuoteSchema,
  },
  ({ contract }, { locale }) =>
    quoteWithdrawal(locale, { kind: contract.kind, id: contract.orderId })
);

const withdrawFromContractAction = defineWorkspaceAction(
  {
    operation: "account.withdraw-from-contract",
    schema: withdrawalStatementSchema,
  },
  ({ contract, ...statement }, { locale }) =>
    submitWithdrawal(
      locale,
      { kind: contract.kind, id: contract.orderId },
      statement
    )
);

export const quoteContractWithdrawal: typeof quoteContractWithdrawalAction =
  async (...args: Parameters<typeof quoteContractWithdrawalAction>) => {
    "use server";
    return await quoteContractWithdrawalAction(...args);
  };

export const withdrawFromContract: typeof withdrawFromContractAction = async (
  ...args: Parameters<typeof withdrawFromContractAction>
) => {
  "use server";
  return await withdrawFromContractAction(...args);
};
