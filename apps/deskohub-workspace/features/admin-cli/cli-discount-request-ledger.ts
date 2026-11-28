import {
  type AdministrationDiscountMutationType,
  type CliMutationRequestIdType,
  CurrentAdministrationCaller,
  discountOperations,
  type LedgerOperationName,
} from "@deskohub/workspace-admin-api";
import { Effect } from "effect";
import {
  type OperationLedger,
  startOperationSettlement,
} from "@/features/administration/administration-operation-port";
import {
  type DiscountRequestLedger,
  discountOperationSettlements,
} from "@/features/discounts/admin/discount-operations.service";
import { discountMutationRecovery } from "./administration-mutation-recovery";
import {
  type AdministrationRequestLedger,
  StoredResult,
} from "./administration-request-ledger.service";
import { toOperationLedgerFailure } from "./cli-administration-operations.server";

type DiscountOperationRegistry =
  DiscountRequestLedger["Service"] extends OperationLedger<infer Ops>
    ? Ops
    : never;

/**
 * The result schema of each ledger operation, by name. Typed per name, so an
 * operation's name picks its own result schema.
 */
type DiscountResults = {
  readonly [Name in LedgerOperationName<DiscountOperationRegistry>]: DiscountOperationRegistry[Name]["output"];
};

const discountResults: DiscountResults = {
  mutateDiscounts: discountOperations.mutateDiscounts.output,
};

/**
 * The administration API's discount ledger for one request: the caller's
 * channel keeps the request ID, so a retried request replays its first
 * result. The calendar refresh and customer-page revalidation the mutation
 * declares start best effort once a successful result is known, applied or
 * replayed; a failure settles nothing.
 */
export const cliDiscountRequestLedger = (
  ledger: AdministrationRequestLedger["Service"],
  caller: CurrentAdministrationCaller["Service"],
  payload: {
    readonly requestId: CliMutationRequestIdType;
    readonly mutation: AdministrationDiscountMutationType;
  }
): DiscountRequestLedger["Service"] => ({
  applyOnce: (entry) =>
    ledger
      .applyOnceWithEffects({
        requestId: payload.requestId,
        mutation: payload.mutation,
        stored: StoredResult.unchanged(discountResults[entry.operation]),
        apply: entry.apply,
        afterSettled: startOperationSettlement(
          discountOperationSettlements.mutateDiscounts,
          payload.mutation
        ),
        recovery: discountMutationRecovery,
      })
      .pipe(
        Effect.mapError(toOperationLedgerFailure),
        Effect.provideService(CurrentAdministrationCaller, caller)
      ),
});
