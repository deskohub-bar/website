import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";

/**
 * The note line naming the payment order. Late-payment recovery finds the
 * Dotypos reservations a payment order created by it.
 */
export const formatPaymentOrderLine = (
  paymentOrderId: WorkspaceReservationId
) => `Platební objednávka: ${paymentOrderId}`;

/** Notes written before staff notes were Czech name the order in English. */
const formatLegacyPaymentOrderLine = (paymentOrderId: WorkspaceReservationId) =>
  `Payment order: ${paymentOrderId}`;

/** Whether a Dotypos reservation note names the given payment order. */
export const noteNamesPaymentOrder = (
  note: string | null | undefined,
  paymentOrderId: WorkspaceReservationId
) => {
  const lines = note?.split("\n") ?? [];

  return (
    lines.includes(formatPaymentOrderLine(paymentOrderId)) ||
    lines.includes(formatLegacyPaymentOrderLine(paymentOrderId))
  );
};
