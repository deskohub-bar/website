import "server-only";

import { Effect, Option, Schema } from "effect";
import { cache } from "react";
import { runAdministrationPage } from "@/features/administrators/server/administration-request.server";
import { FioPaymentSettlementRepository } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";
import { orderIdSchema } from "@/features/order/order";
import { administrationFioSettlements } from "./fio-settlement-layer.server";

const decodeOrderId = Schema.decodeUnknownOption(orderIdSchema);

export const loadAdministrationFioMovements = cache(async (id: string) => {
  const orderId = decodeOrderId(id);
  if (Option.isNone(orderId)) return [];
  return runAdministrationPage(
    "administration.fio-order-movements",
    Effect.gen(function* () {
      const settlements = yield* FioPaymentSettlementRepository;
      return yield* settlements.listForOrder(orderId.value);
    }),
    administrationFioSettlements
  );
});

export type FioStaffQueue = "unmatched" | "refund_required";

const decodeCursor = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isUUID())
);

export const loadAdministrationFioQueue = (
  kind: FioStaffQueue,
  cursor: string | undefined
) =>
  runAdministrationPage(
    "administration.fio-settlement-queue",
    Effect.gen(function* () {
      const settlements = yield* FioPaymentSettlementRepository;
      const beforeId = Option.getOrUndefined(decodeCursor(cursor));
      const movements = yield* settlements.listForStaff({
        kind,
        ...(beforeId && { beforeId }),
      });
      return {
        movements,
        beforeId,
        nextCursor: movements.length === 100 ? movements.at(-1)?.id : undefined,
      };
    }),
    administrationFioSettlements
  );
