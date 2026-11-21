"use server";

import { Clock, Data, Effect, Schema } from "effect";
import { defineAdministrationAction } from "@/features/administrators/server/administration-request.server";
import { FioPaymentSettlementRepository } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";
import type { OrderId } from "@/features/order/order";
import { administrationHref } from "./administration-href";
import { administrationFioSettlements } from "./fio-settlement-layer.server";
import { m } from "./i18n";

class FioRefundUnavailable extends Data.TaggedError("FioRefundUnavailable") {}

type RecordedFioRefund = {
  readonly orderId: OrderId;
  readonly refundedAt: string;
};

const recordRefund = defineAdministrationAction(
  {
    operation: "administration.record-fio-manual-refund",
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({ settlementId: Schema.String.check(Schema.isUUID()) }),
      { parseOptions: { errors: "all", onExcessProperty: "error" } }
    ),
    logInput: false,
    failureCopy: {
      timeout: m.administrationActionTimedOut,
      unexpected: m.administrationActionFailedUnexpectedly,
    },
    capabilities: administrationFioSettlements,
    fallback: m.administrationFioRefundFailed,
    publicFailure: (failure, locale) =>
      failure instanceof FioRefundUnavailable
        ? m.administrationFioRefundUnavailable({}, { locale })
        : undefined,
    revalidates: (_, { orderId }: RecordedFioRefund) => [
      administrationHref("/[locale]/admin"),
      administrationHref("/[locale]/admin/orders"),
      administrationHref("/[locale]/admin/orders/[orderId]", { orderId }),
      administrationHref("/[locale]/admin/reservations/[reservationId]", {
        reservationId: orderId,
      }),
    ],
  },
  Effect.fn(function* ({ settlementId }) {
    const settlements = yield* FioPaymentSettlementRepository;
    const now = yield* Clock.currentTimeMillis;
    const row = yield* settlements.markManualRefunded(
      settlementId,
      Temporal.Instant.fromEpochMilliseconds(now)
    );
    if (!row?.refundedAt || !row.orderId)
      return yield* new FioRefundUnavailable();
    return { orderId: row.orderId, refundedAt: row.refundedAt.toString() };
  })
);

export const recordFioManualRefund: typeof recordRefund = async (
  ...args: Parameters<typeof recordRefund>
) => await recordRefund(...args);
