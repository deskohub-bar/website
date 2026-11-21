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

const reservationWithdrawalSchema = Schema.toStandardSchemaV1(
  Schema.Struct({ orderId: workspaceReservationIdSchema }),
  { parseOptions: { errors: "all", onExcessProperty: "error" } }
);

const reservationWithdrawalStatementSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    orderId: workspaceReservationIdSchema,
    refundTermsKey: Schema.optionalKey(Schema.String),
    /** The name the customer typed; used only when the profile has none. */
    customerName: Schema.optionalKey(Schema.String),
  }),
  { parseOptions: { errors: "all", onExcessProperty: "error" } }
);

const passWithdrawalSchema = Schema.toStandardSchemaV1(
  Schema.Struct({ orderId: orderIdSchema }),
  { parseOptions: { errors: "all", onExcessProperty: "error" } }
);

const passWithdrawalStatementSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    orderId: orderIdSchema,
    refundTermsKey: Schema.optionalKey(Schema.String),
    customerName: Schema.optionalKey(Schema.String),
  }),
  { parseOptions: { errors: "all", onExcessProperty: "error" } }
);

/** The quote, or why the customer can't withdraw from the reservation now. */
export type ReservationWithdrawalQuoteResult =
  | { readonly status: "available"; readonly quote: WithdrawalQuoteData }
  | { readonly status: "refused"; readonly reason: WithdrawalRefusal };

/**
 * The receipt, why the withdrawal wasn't accepted, or that the statement
 * needs the customer's name (the profile has none and none was typed).
 */
export type ReservationWithdrawalResult =
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
  runForSignedInCustomer(locale, (withdrawals, accountId) =>
    withdrawals.quote({
      accountId,
      locale,
      contract,
    })
  ).pipe(
    Effect.map(
      (result): ReservationWithdrawalQuoteResult =>
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
  runForSignedInCustomer(locale, (withdrawals, accountId) =>
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
          (receipt): ReservationWithdrawalResult => ({
            status: "withdrawn",
            receipt: toWithdrawalReceiptData(receipt),
          })
        ),
        Effect.catchTags({
          WithdrawalNameRequiredError: () =>
            Effect.succeed<ReservationWithdrawalResult>({
              status: "name_required",
            }),
          WithdrawalRefundChangedError: ({ quote }) =>
            Effect.succeed<ReservationWithdrawalResult>({
              status: "refund_changed",
              quote: toWithdrawalQuoteData(quote),
            }),
        })
      )
  ).pipe(
    Effect.map(
      (result): ReservationWithdrawalResult =>
        result.status === "done" ? result.value : result
    )
  );

const quoteReservationWithdrawalAction = defineWorkspaceAction(
  {
    operation: "account.quote-reservation-withdrawal",
    schema: reservationWithdrawalSchema,
  },
  (input, { locale }) =>
    quoteWithdrawal(locale, { kind: "reservation", id: input.orderId })
);

const withdrawFromReservationAction = defineWorkspaceAction(
  {
    operation: "account.withdraw-from-reservation",
    schema: reservationWithdrawalStatementSchema,
  },
  (input, { locale }) =>
    submitWithdrawal(locale, { kind: "reservation", id: input.orderId }, input)
);

const quoteUnlimitedPassWithdrawalAction = defineWorkspaceAction(
  {
    operation: "account.quote-unlimited-pass-withdrawal",
    schema: passWithdrawalSchema,
  },
  (input, { locale }) =>
    quoteWithdrawal(locale, { kind: "unlimited-pass", id: input.orderId })
);

const withdrawFromUnlimitedPassAction = defineWorkspaceAction(
  {
    operation: "account.withdraw-from-unlimited-pass",
    schema: passWithdrawalStatementSchema,
  },
  (input, { locale }) =>
    submitWithdrawal(
      locale,
      { kind: "unlimited-pass", id: input.orderId },
      input
    )
);

export const quoteReservationWithdrawal: typeof quoteReservationWithdrawalAction =
  async (...args: Parameters<typeof quoteReservationWithdrawalAction>) => {
    "use server";
    return await quoteReservationWithdrawalAction(...args);
  };

export const withdrawFromReservation: typeof withdrawFromReservationAction =
  async (...args: Parameters<typeof withdrawFromReservationAction>) => {
    "use server";
    return await withdrawFromReservationAction(...args);
  };

export const quoteUnlimitedPassWithdrawal: typeof quoteUnlimitedPassWithdrawalAction =
  async (...args: Parameters<typeof quoteUnlimitedPassWithdrawalAction>) => {
    "use server";
    return await quoteUnlimitedPassWithdrawalAction(...args);
  };

export const withdrawFromUnlimitedPass: typeof withdrawFromUnlimitedPassAction =
  async (...args: Parameters<typeof withdrawFromUnlimitedPassAction>) => {
    "use server";
    return await withdrawFromUnlimitedPassAction(...args);
  };
