import type { WorkspaceReservationRow } from "@/db/schema";

export const reservationSummaryRowValues = (row: WorkspaceReservationRow) =>
  [
    row.id,
    row.activePaymentAttemptId,
    row.dotyposCustomerId,
    row.dotyposReservationId,
    row.reservationState,
    row.paymentState,
    row.fulfillmentState,
    row.reservationDetails,
    row.reservationPurpose,
    row.reservationCreatedAt?.toString() ?? null,
    row.reservationConfirmedAt?.toString() ?? null,
    row.reservationCancelledAt?.toString() ?? null,
    row.cancellationCause,
    row.reservationHoldExpiredAt?.toString() ?? null,
    row.paidAt?.toString() ?? null,
    row.fulfilledAt?.toString() ?? null,
    row.fulfillmentFailedAt?.toString() ?? null,
    row.failureCode,
    row.createdAt.toString(),
    row.updatedAt.toString(),
  ] as const;

export const reservationDetailRowValues = (row: WorkspaceReservationRow) =>
  [
    ...reservationSummaryRowValues(row),
    row.authorAccountId ?? null,
    row.passId,
    row.cancellationEmailSentAt?.toString() ?? null,
    row.checkoutSessionKey,
  ] as const;
