import {
  DotyposCustomerIdSchema,
  type DotyposReservationId,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect } from "effect";
import type { WorkspaceReservation } from "@/features/reservation/backend/workspace-reservation.repository";
import type { WorkspaceReservationDetails } from "@/features/reservation/backend/workspace-reservation.service";
import {
  dotyposHoldFixture,
  workspaceReservationDetailsFixture,
  workspaceReservationFixture,
} from "@/features/reservation/backend/workspace-reservation.test-utils";
import { withCoworkProductFields } from "@/features/reservation/cowork-reservation-product";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { dotyposCustomerFixture } from "@/shared/testing/dotypos-customer.test-utils";
import { requireValue } from "@/shared/testing/require-value.test-utils";

export const fulfillmentReservationId =
  workspaceReservationIdSchema.make("reservation-id");

export const fulfillmentOrderFixture = (
  overrides: Partial<WorkspaceReservation> = {}
): WorkspaceReservation =>
  withCoworkProductFields(
    workspaceReservationFixture({
      id: fulfillmentReservationId,
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      reservationState: "held",
      reservationConfirmedAt: null,
      reservationDetails: { kind: "cowork", entryTier: "basic", coffee: false },
      paymentState: "paid",
      fulfillmentState: "not_started",
      fulfilledAt: null,
      ...overrides,
    })
  );

export const fulfillmentDetailsFixture = (
  order: WorkspaceReservation,
  overrides: Partial<WorkspaceReservationDetails> = {}
): WorkspaceReservationDetails =>
  workspaceReservationDetailsFixture({
    id: order.id,
    authorAccountId: order.authorAccountId,
    dotyposCustomerId: order.dotyposCustomerId,
    dotyposReservationId: requireValue(
      order.dotyposReservationId,
      "Dotypos reservation ID"
    ),
    locale: order.locale,
    reservationDetails: order.reservationDetails,
    customer: dotyposCustomerFixture(order.dotyposCustomerId, {
      email: testEmailAddress("customer"),
    }),
    ...overrides,
  });

export const customerAccessCodeFixture = ({
  reservedFrom,
  reservedUntil,
}: {
  readonly reservedFrom: Temporal.Instant;
  readonly reservedUntil: Temporal.Instant;
}) => ({
  code: "access-code",
  accessStartsAt: reservedFrom,
  accessEndsAt: reservedUntil,
});

export const confirmDotyposReservationFixture = (
  reservationId: DotyposReservationId
) =>
  Effect.succeed({
    ...dotyposHoldFixture(reservationId),
    status: "CONFIRMED",
  } as const);

export const fulfillmentQueryFailure = (query: string, message: string) =>
  new EffectDrizzleQueryError({
    query,
    params: [],
    cause: Cause.die(new Error(message)),
  });

export const bouncedReservationFixture = (
  reservation: WorkspaceReservation,
  failedAt: Temporal.Instant
): WorkspaceReservation => ({
  ...reservation,
  fulfillmentState: "failed",
  fulfilledAt: null,
  fulfillmentFailedAt: failedAt,
  fulfillmentFailureCode: "fulfillment_email_failed",
  updatedAt: Temporal.Now.instant(),
});

export const deliveredReservationFixture = (
  reservation: WorkspaceReservation,
  fulfilledAt: Temporal.Instant
): WorkspaceReservation => ({
  ...reservation,
  fulfillmentState: "fulfilled",
  fulfilledAt,
  fulfillmentFailureCode: null,
  updatedAt: Temporal.Now.instant(),
});
