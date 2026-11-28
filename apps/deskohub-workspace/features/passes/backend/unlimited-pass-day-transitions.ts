import "server-only";

import type { DotyposReservationId } from "@deskohub/dotypos";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  type WorkspaceReservationRow,
  workspaceReservations,
} from "@/db/schema";
import { recordCustomerEvent } from "@/shared/backend/customer-events/customer-event-outbox";

type PassDayAttempt = Pick<
  WorkspaceReservationRow,
  | "id"
  | "reservationState"
  | "passDayHoldGeneration"
  | "passDayHoldRequestedAt"
  | "dotyposReservationId"
  | "failureCode"
>;

/** Matches the pass day only while it still holds this hold attempt. */
export const matchesPassDayAttempt = (row: PassDayAttempt) =>
  and(
    eq(workspaceReservations.id, row.id),
    eq(workspaceReservations.reservationState, row.reservationState),
    row.passDayHoldGeneration === null
      ? isNull(workspaceReservations.passDayHoldGeneration)
      : eq(
          workspaceReservations.passDayHoldGeneration,
          row.passDayHoldGeneration
        ),
    row.passDayHoldRequestedAt === null
      ? isNull(workspaceReservations.passDayHoldRequestedAt)
      : eq(
          workspaceReservations.passDayHoldRequestedAt,
          row.passDayHoldRequestedAt
        ),
    row.dotyposReservationId === null
      ? isNull(workspaceReservations.dotyposReservationId)
      : eq(
          workspaceReservations.dotyposReservationId,
          row.dotyposReservationId
        ),
    row.failureCode === null
      ? isNull(workspaceReservations.failureCode)
      : eq(workspaceReservations.failureCode, row.failureCode)
  );

/**
 * Books a confirming pass day whose provider hold is confirmed, with its
 * booked event. A day another writer moved on records nothing, and a restored
 * day booked again conflicts with its first event.
 */
export const bookPassDay = Effect.fn("bookPassDay")(function* (
  day: Pick<WorkspaceReservationRow, "id"> & {
    readonly dotyposReservationId: DotyposReservationId;
  },
  now: Temporal.Instant
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  yield* transaction(
    Effect.gen(function* () {
      const [booked] = yield* db
        .update(workspaceReservations)
        .set({
          reservationState: "confirmed",
          fulfillmentState: "fulfilled",
          reservationConfirmedAt: now,
          fulfilledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workspaceReservations.id, day.id),
            eq(workspaceReservations.reservationState, "confirming"),
            eq(
              workspaceReservations.dotyposReservationId,
              day.dotyposReservationId
            )
          )
        )
        .returning({
          dotyposCustomerId: workspaceReservations.dotyposCustomerId,
        });
      if (booked) {
        yield* recordCustomerEvent({
          kind: "reservation-booked",
          occurredAt: now,
          dotyposCustomerId: booked.dotyposCustomerId,
          workspaceReservationId: day.id,
        });
      }
    })
  );
});

/**
 * Ends a released pass day: cancelled when it had a provider hold, else
 * expired. Only a booked day's cancellation is a customer event, recorded
 * with it; a day another writer moved on records nothing.
 */
export const endReleasedPassDay = Effect.fn("endReleasedPassDay")(function* (
  attempt: PassDayAttempt,
  releasedId: DotyposReservationId | undefined,
  now: Temporal.Instant
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  yield* transaction(
    Effect.gen(function* () {
      const [released] = yield* db
        .update(workspaceReservations)
        .set({
          reservationState: releasedId ? "cancelled" : "hold_expired",
          ...(releasedId && {
            dotyposReservationId: releasedId,
            reservationCancelledAt: now,
          }),
          reservationHoldExpiredAt: now,
          updatedAt: now,
        })
        .where(matchesPassDayAttempt(attempt))
        .returning({
          dotyposCustomerId: workspaceReservations.dotyposCustomerId,
          reservationConfirmedAt: workspaceReservations.reservationConfirmedAt,
        });
      if (releasedId && released?.reservationConfirmedAt) {
        yield* recordCustomerEvent({
          kind: "reservation-cancelled",
          occurredAt: now,
          dotyposCustomerId: released.dotyposCustomerId,
          workspaceReservationId: attempt.id,
        });
      }
    })
  );
});
