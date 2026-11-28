import { Duration, Schema } from "effect";
import { toStoredInstant } from "@/db/instant";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import { defineQueueTopic } from "@/shared/backend/queue/queue-topic";
import { clamp } from "@/shared/utils/number";
import { instantStringSchema } from "@/shared/utils/temporal";

export const reservationHoldCleanupScheduleMaxDelaySeconds = 7 * 24 * 60 * 60;
const reservationHoldCleanupRetryWindowSeconds = 60 * 60;

const ReservationHoldCleanupSchedulePayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  orderId: workspaceReservationIdSchema,
  reservationHoldExpiresAtIso: instantStringSchema,
  /**
   * After this instant the consumer acknowledges without cleanup. Messages
   * enqueued before it existed omit it. It stays optional under version 1
   * because the version 1 decoder drops unknown keys, so a rolled-back
   * consumer still runs the cleanup of a message that carries it.
   */
  cleanupDeadlineIso: Schema.optionalKey(instantStringSchema),
});

export type ReservationHoldCleanupSchedulePayload =
  typeof ReservationHoldCleanupSchedulePayloadSchema.Type;

export type ReservationHoldCleanupSchedule = {
  readonly orderId: WorkspaceReservationId;
  readonly reservationHoldExpiresAt: Temporal.Instant;
};

/**
 * Delivers the cleanup when the hold expires and keeps it for an hour of
 * retries after, both capped at the queue's seven-day limit. The deadline is
 * the end of that retention measured from enqueue, so a message delivered at
 * the cap gets no retries.
 */
const reservationHoldCleanupDelivery = (
  input: ReservationHoldCleanupSchedule & { readonly now: Temporal.Instant }
) => {
  const delaySeconds = clamp(
    Math.ceil(
      (input.reservationHoldExpiresAt.epochMilliseconds -
        input.now.epochMilliseconds) /
        1000
    ),
    0,
    reservationHoldCleanupScheduleMaxDelaySeconds
  );
  const retentionSeconds = clamp(
    delaySeconds + reservationHoldCleanupRetryWindowSeconds,
    60,
    reservationHoldCleanupScheduleMaxDelaySeconds
  );
  return {
    delaySeconds,
    retentionSeconds,
    // Full precision: truncating would make a delivery exactly at the end of
    // retention count as late.
    cleanupDeadline: input.now.add({ seconds: retentionSeconds }),
  };
};

/** One message per hold deadline. */
export const reservationHoldCleanupTopic = defineQueueTopic({
  topic: "workspace-reservation-hold-cleanup",
  label: "Reservation hold cleanup",
  message: Schema.toStandardSchemaV1(
    ReservationHoldCleanupSchedulePayloadSchema
  ),
  publish: (
    input: ReservationHoldCleanupSchedule & { readonly now: Temporal.Instant }
  ) => {
    const reservationHoldExpiresAtIso = toStoredInstant(
      input.reservationHoldExpiresAt
    ).toString();
    const delivery = reservationHoldCleanupDelivery(input);

    return {
      message: {
        schemaVersion: 1 as const,
        orderId: input.orderId,
        reservationHoldExpiresAtIso,
        cleanupDeadlineIso: delivery.cleanupDeadline.toString(),
      },
      key: `reservation-hold-cleanup:${input.orderId}:${reservationHoldExpiresAtIso}`,
      delay: Duration.seconds(delivery.delaySeconds),
      retention: Duration.seconds(delivery.retentionSeconds),
    };
  },
});
