import { Context, Effect, Layer, Option } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import type {
  FioPaymentSettlement,
  FioSettlementDiscrepancyReason,
} from "@/db/schema/fio-payment-settlements";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import type { OrderId } from "@/features/order/order";
import { reservationIdForOrder } from "@/features/reservation/persistence-contracts";
import type { Money } from "@/shared/money/money";
import { FioAccounts } from "../fio/fio-accounts.service";
import {
  type PaidFulfillmentQueueError,
  PaidFulfillmentQueueService,
} from "../fulfillment/paid-fulfillment-queue.service";
import {
  type FioAccountSettlementPage,
  FioPaymentSettlementRepository,
} from "../repositories/fio-payment-settlement.repository";
import {
  PaymentLifecycleRepository,
  type PaymentLifecycleRepositoryError,
} from "../repositories/payment-lifecycle.repository";
import { QrPaymentRepository } from "../repositories/qr-payment.repository";
import {
  type ILatePaymentRecoveryQueueService,
  LatePaymentRecoveryQueueService,
} from "./late-payment-recovery-queue.service";

type FioMovementAmount =
  | { readonly _tag: "CZK"; readonly minorUnits: number }
  | {
      readonly _tag: "OtherCurrency";
      readonly currency: string;
      readonly decimalAmount: string;
    };

export interface VerifiedFioMovement {
  readonly accountKey: string;
  readonly movementId: string;
  readonly variableSymbol: string | null;
  readonly referenceStatus?: "absent" | "invalid";
  readonly amount: FioMovementAmount;
  readonly bookingDate: Temporal.PlainDate;
  readonly observedAt: Temporal.Instant;
}

type RecordMovementError =
  | DatabaseQueryError
  | PaymentLifecycleRepositoryError
  | PaidFulfillmentQueueError
  | Effect.Error<ReturnType<ILatePaymentRecoveryQueueService["enqueue"]>>;

interface IFioPaymentSettlementService {
  readonly recordMovement: (
    movement: VerifiedFioMovement
  ) => Effect.Effect<void, RecordMovementError>;
  readonly retryPendingDispatch: (
    accountKey: string
  ) => Effect.Effect<void, RecordMovementError>;
  readonly listForAccount: (
    input: FioAccountSettlementPage
  ) => Effect.Effect<readonly FioPaymentSettlement[], DatabaseQueryError>;
  readonly listForOrder: (
    orderId: OrderId
  ) => Effect.Effect<readonly FioPaymentSettlement[], DatabaseQueryError>;
  readonly markManualRefunded: (
    settlementId: string,
    refundedAt: Temporal.Instant
  ) => Effect.Effect<FioPaymentSettlement | null, DatabaseQueryError>;
}

export class FioPaymentSettlementService extends Context.Service<
  FioPaymentSettlementService,
  IFioPaymentSettlementService
>()("FioPaymentSettlementService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { transaction } = yield* WorkspaceDatabase;
      const settlements = yield* FioPaymentSettlementRepository;
      const accounts = yield* FioAccounts;
      const references = yield* QrPaymentRepository;
      const lifecycle = yield* PaymentLifecycleRepository;
      const fulfillmentQueue = yield* PaidFulfillmentQueueService;
      const recoveryQueue = yield* LatePaymentRecoveryQueueService;

      const dispatchSettlement = Effect.fn("fioPaymentSettlement.dispatch")(
        function* (settlement: FioPaymentSettlement) {
          if (settlement.disposition === "winner" && settlement.orderId) {
            yield* fulfillmentQueue.enqueue({
              orderId: reservationIdForOrder(settlement.orderId),
            });
          }
          if (
            settlement.disposition === "recovery_pending" &&
            settlement.paymentAttemptId
          ) {
            yield* recoveryQueue.enqueue({
              paymentAttemptId: settlement.paymentAttemptId,
            });
          }
        }
      );

      const retryPendingDispatch = Effect.fn(
        "fioPaymentSettlement.retryPendingDispatch"
      )(function* (accountKey: string) {
        let beforeId: string | undefined;
        // A receipt can close the last payable attempt before its queue
        // publication succeeds. Redelivery can finish that local work.
        while (true) {
          const page = yield* settlements.listPendingDispatch({
            accountKey,
            beforeId,
          });
          const oldest = page.at(-1);
          if (!oldest) return;
          yield* Effect.forEach(page, dispatchSettlement, { discard: true });
          beforeId = oldest.id;
        }
      });

      const recordMovement = Effect.fn("fioPaymentSettlement.recordMovement")(
        function* (movement: VerifiedFioMovement) {
          if (
            Option.isSome(yield* Effect.serviceOption(WorkspaceTransaction))
          ) {
            return yield* Effect.die(
              new Error(
                "Fio movement ingress must start outside a transaction."
              )
            );
          }
          if (!accounts.getReceivingAccount(movement.accountKey)) return;

          const settlement = yield* transaction(
            Effect.gen(function* () {
              const variableSymbol = validSymbol(movement.variableSymbol);
              const reference = variableSymbol
                ? yield* references.findByReference({
                    accountKey: movement.accountKey,
                    variableSymbol,
                  })
                : null;
              const discrepancyReason = reference
                ? compareAmount(movement.amount, reference.amount)
                : unresolvedReference(movement, variableSymbol);
              const amount =
                movement.amount._tag === "CZK"
                  ? {
                      currency: "CZK",
                      amountValue: movement.amount.minorUnits,
                      decimalAmount: null,
                    }
                  : {
                      currency: movement.amount.currency,
                      amountValue: null,
                      decimalAmount: movement.amount.decimalAmount,
                    };

              const claim = yield* settlements.claimMovement({
                accountKey: movement.accountKey,
                movementId: movement.movementId,
                bookingDate: movement.bookingDate.toString({
                  calendarName: "never",
                }),
                observedAt: movement.observedAt,
                variableSymbol,
                ...amount,
                // Exact credits claim the movement before acquiring the order
                // lock. Adding foreign keys here would take locks in reverse order.
                orderId: discrepancyReason ? reference?.orderId : null,
                paymentAttemptId: discrepancyReason
                  ? reference?.attemptId
                  : null,
                disposition: "discrepancy",
                discrepancyReason: discrepancyReason ?? "reference_unmatched",
              });
              if (!claim.inserted || !reference || discrepancyReason)
                return claim.settlement;

              const decision = yield* lifecycle.recordVerifiedQrPayment({
                orderId: reference.orderId,
                id: reference.attemptId,
                providerOperationId: movement.movementId,
                paidAt: movement.observedAt,
              });
              return yield* settlements.settleExactCredit({
                settlementId: claim.settlement.id,
                orderId: reference.orderId,
                paymentAttemptId: reference.attemptId,
                disposition: dispositionsByDecision[decision.status],
              });
            })
          );

          yield* dispatchSettlement(settlement);
        }
      );

      return FioPaymentSettlementService.of({
        recordMovement,
        retryPendingDispatch,
        listForAccount: settlements.listForAccount,
        listForOrder: settlements.listForOrder,
        markManualRefunded: settlements.markManualRefunded,
      });
    })
  );
}

const dispositionsByDecision = {
  winner: "winner",
  recover: "recovery_pending",
  refund: "refund_required",
} as const;

const validSymbol = (symbol: string | null) =>
  symbol && /^[0-9]{1,10}$/.test(symbol) ? symbol : null;

const unresolvedReference = (
  movement: VerifiedFioMovement,
  variableSymbol: string | null
): FioSettlementDiscrepancyReason => {
  if (variableSymbol) return "reference_unmatched";
  if (
    movement.variableSymbol !== null ||
    movement.referenceStatus === "invalid"
  ) {
    return "reference_invalid";
  }
  return "reference_absent";
};

const compareAmount = (
  amount: FioMovementAmount,
  quoted: Money
): FioSettlementDiscrepancyReason | null => {
  if (amount._tag !== "CZK" || quoted.currency !== "CZK")
    return "currency_mismatch";
  if (amount.minorUnits <= 0) return "non_credit";
  return quoted.exponent === 2 && amount.minorUnits === quoted.value
    ? null
    : "amount_mismatch";
};
