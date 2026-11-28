import { customerAccountIdSchema } from "@/features/account/customer-account";
import type { Money } from "@/shared/money/money";
import { withdrawalIdSchema } from "../withdrawal-identifiers";
import type { ContractWithdrawal } from "./withdrawal.repository";

const synthetic: Money = { value: 35_000, exponent: 2, currency: "CZK" };
const noRetry = { attempts: 0, failureCode: null, retryAt: null };

/**
 * A recorded, fully refunded withdrawal of a reservation that no settlement
 * step has run for yet, with `overrides` applied.
 */
export const contractWithdrawalFixture = (
  overrides: Partial<ContractWithdrawal> = {}
): ContractWithdrawal => {
  const submittedAt = Temporal.Instant.from("2027-01-10T08:00:00Z");
  return {
    id: withdrawalIdSchema.make("withdrawal-1"),
    contract: { kind: "reservation", id: "reservation-1" },
    accountId: customerAccountIdSchema.make("account-1"),
    locale: "en-US",
    contractLabel: "Synthetic reservation",
    statementName: null,
    submittedAt,
    periodEndsAt: submittedAt.add({ hours: 14 * 24 }),
    paidAmount: synthetic,
    refundAmount: synthetic,
    refundBasis: { kind: "full" },
    receiptSentAt: null,
    operatorNotifiedAt: null,
    contractCancelledAt: null,
    settledAt: null,
    settlementClaimedAt: null,
    stepRetries: {
      receipt: noRetry,
      operator_notice: noRetry,
      contract_cancellation: noRetry,
    },
    ...overrides,
  };
};
