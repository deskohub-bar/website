import {
  type CreateDotyposReservationInput,
  DotyposCustomerIdSchema,
  type DotyposReservation,
  DotyposReservationIdSchema,
  DotyposReservationSchema,
} from "@deskohub/dotypos";
import { NexiCorrelationIdSchema } from "@deskohub/nexi";
import { Schema } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import type { PayableReservation } from "@/features/checkout/backend/checkout/payable-checkout.service";
import {
  checkoutAttemptKeySchema,
  checkoutSessionKeySchema,
} from "@/features/checkout/checkout-identifiers";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { dotyposCustomerFixture } from "@/shared/testing/dotypos-customer.test-utils";
import type { WorkspaceReservation } from "./workspace-reservation.repository";
import type { WorkspaceReservationDetails } from "./workspace-reservation.service";

/**
 * A stored, paid and fulfilled open-space cowork reservation, with
 * `overrides` applied.
 */
export const workspaceReservationFixture = (
  overrides: Partial<WorkspaceReservation> = {}
): WorkspaceReservation => {
  const createdAt = Temporal.Instant.from("2099-06-01T08:00:00Z");
  return {
    id: workspaceReservationIdSchema.make("reservation-1"),
    authorAccountId: customerAccountIdSchema.make("account-1"),
    dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-1"),
    passId: null,
    serviceDate: null,
    passDayTableId: null,
    passDayHoldRequestedAt: null,
    passDayHoldGeneration: null,
    checkoutSessionKey: checkoutSessionKeySchema.make("session-key"),
    checkoutAttemptKey: checkoutAttemptKeySchema.make("attempt-key"),
    correlationId: NexiCorrelationIdSchema.make("correlation-id"),
    agentClientId: null,
    agentSelectionKey: null,
    reservationPurpose: null,
    dotyposReservationId: null,
    reservationState: "confirmed",
    paymentState: "paid",
    fulfillmentState: "fulfilled",
    activePaymentAttemptId: null,
    activeCustomerEmailDeliveryId: null,
    activeCustomerEmailDeliveryLocale: null,
    activeCustomerEmailDeliveryOpenSpaceTables: null,
    reservationDetails: {
      kind: "cowork",
      entryTier: "open-space",
      coffee: false,
    },
    officeContactAttends: null,
    locale: "cs-CZ",
    paymentReturnTarget: null,
    reservationHoldExpiresAt: null,
    reservationHoldExpiredAt: null,
    reservationCreatedAt: createdAt,
    reservationConfirmedAt: createdAt,
    reservationCancelledAt: null,
    cancellationCause: null,
    cancellationEmailSentAt: null,
    paidAt: createdAt,
    fulfilledAt: createdAt,
    fulfillmentFailedAt: null,
    failureCode: null,
    fulfillmentFailureCode: null,
    createdAt,
    updatedAt: createdAt,
    productTier: "open-space",
    productCoffee: false,
    productMonitorOption: null,
    ...overrides,
  };
};

/**
 * A confirmed `WorkspaceReservationDetails` fixture for Workspace reservation tests, with `overrides` applied.
 */
export const workspaceReservationDetailsFixture = (
  overrides: Partial<WorkspaceReservationDetails> = {}
): WorkspaceReservationDetails => {
  const reservation = workspaceReservationFixture();
  const reservedFrom = Temporal.Instant.from("2099-06-01T08:00:00Z");
  const reservedUntil = Temporal.Instant.from("2099-06-01T16:00:00Z");
  return {
    id: reservation.id,
    dotyposCustomerId: reservation.dotyposCustomerId,
    authorAccountId: reservation.authorAccountId,
    reservationDetails: reservation.reservationDetails,
    locale: reservation.locale,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-reservation-1"
    ),
    customer: dotyposCustomerFixture(
      overrides.dotyposCustomerId ?? reservation.dotyposCustomerId
    ),
    reservedFrom,
    reservedUntil,
    providerStatus: "CONFIRMED",
    seats: 1,
    placement: {},
    ...overrides,
  };
};

/**
 * A held, unpaid reservation whose Pay state is still payable, with
 * `overrides` applied.
 */
export const payableReservationFixture = (
  overrides: Partial<PayableReservation> = {}
): PayableReservation => ({
  ...workspaceReservationFixture({
    reservationState: "held",
    paymentState: "not_started",
    fulfillmentState: "not_started",
    reservationConfirmedAt: null,
    paidAt: null,
    fulfilledAt: null,
  }),
  dotyposReservationId: DotyposReservationIdSchema.make(
    "dotypos-reservation-1"
  ),
  reservationHoldExpiresAt: Temporal.Instant.from("2099-06-01T10:10:00Z"),
  ...overrides,
});

export const dotyposHoldFixture = (id: string) =>
  Schema.decodeSync(DotyposReservationSchema)({
    id,
    _branchId: "branch",
    _cloudId: "cloud",
    _customerId: "customer",
    _tableId: "table-id",
    startDate: "2099-07-01T07:00:00.000Z",
    endDate: "2099-07-01T16:00:00.000Z",
    seats: "1",
    status: "NEW",
  });

export const dotyposCreatedReservationFixture = (
  id: string,
  input: CreateDotyposReservationInput
): DotyposReservation => ({
  ...dotyposHoldFixture(id),
  _customerId: input.customerId,
  _tableId: input.tableId,
  startDate: input.startDate.toISOString(),
  endDate: input.endDate.toISOString(),
  seats: String(input.seats),
  status: input.status,
  note: input.note,
});
