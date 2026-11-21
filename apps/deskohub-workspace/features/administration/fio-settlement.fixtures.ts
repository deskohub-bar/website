import "@/shared/polyfills/temporal";

import type { FioStaffSettlement } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { orderIdSchema } from "@/features/order/order";

export const fioPendingRefund: FioStaffSettlement = {
  id: "01980000-0000-7000-8000-000000000044",
  orderId: orderIdSchema.make("01980000-0000-7000-8000-000000000040"),
  paymentAttemptId: paymentAttemptIdSchema.make(
    "01980000-0000-7000-8000-000000000041"
  ),
  accountKey: "synthetic-receiving-account",
  movementId: "9012345001",
  variableSymbol: "1200042091",
  amountValue: 12_345,
  currency: "CZK",
  decimalAmount: null,
  bookingDate: "2026-11-19",
  observedAt: Temporal.Instant.from("2026-11-20T09:21:00Z"),
  disposition: "refund_required",
  discrepancyReason: null,
  refundedAt: null,
  refundTargetValue: null,
};

export const fioDiscrepancy: FioStaffSettlement = {
  ...fioPendingRefund,
  id: "01980000-0000-7000-8000-000000000043",
  movementId: "9012345002",
  orderId: null,
  paymentAttemptId: null,
  variableSymbol: null,
  amountValue: null,
  currency: "EUR",
  decimalAmount: "100.2500",
  disposition: "discrepancy",
  discrepancyReason: "reference_invalid",
};
