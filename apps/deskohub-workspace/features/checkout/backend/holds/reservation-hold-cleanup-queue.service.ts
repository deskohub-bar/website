import { Context, Data, Effect, Layer } from "effect";
import { QueueRedelivery } from "@/shared/backend/queue/queue-consumer";
import {
  QueuePublisher,
  type QueuePublishOutcome,
} from "@/shared/backend/queue/queue-publisher";
import { ProviderPaymentDeferral } from "../payment/provider-payment-finalization.service";
import {
  type ReservationHoldCleanupOutcome,
  ReservationHoldCleanupService,
} from "./reservation-hold-cleanup.service";
import {
  type ReservationHoldCleanupSchedule,
  type ReservationHoldCleanupSchedulePayload,
  reservationHoldCleanupTopic,
} from "./reservation-hold-cleanup-topic";
import { HoldCancellationInProgress } from "./unpaid-hold-release.service";

class ReservationHoldCleanupScheduleError extends Data.TaggedError(
  "ReservationHoldCleanupScheduleError"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  static fromError(message: string) {
    return (cause: unknown) =>
      new ReservationHoldCleanupScheduleError({ message, cause });
  }
}

/** Redelivers the message once the provider's abandonment window ends. */
class ReservationHoldCleanupDeferredError extends Data.TaggedError(
  "ReservationHoldCleanupDeferredError"
)<{
  readonly redeliverAt: Temporal.Instant;
}> {}

interface IReservationHoldCleanupScheduleService {
  readonly enqueueCleanup: (
    input: ReservationHoldCleanupSchedule
  ) => Effect.Effect<void, ReservationHoldCleanupScheduleError>;
}

const enqueueOutcomeMessages = {
  duplicate: "Reservation hold cleanup was already enqueued",
  published: "Reservation hold cleanup enqueued",
} satisfies Record<QueuePublishOutcome, string>;

export class ReservationHoldCleanupScheduleService extends Context.Service<
  ReservationHoldCleanupScheduleService,
  IReservationHoldCleanupScheduleService
>()("ReservationHoldCleanupScheduleService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const publisher = yield* QueuePublisher;
      return {
        enqueueCleanup: Effect.fn(
          "reservationHoldCleanupSchedule.enqueueCleanup"
        )(function* (input) {
          const schedule = { ...input, now: Temporal.Now.instant() };
          const publication = reservationHoldCleanupTopic.publication(schedule);
          // Keeps the log fields these lines had before the topic definition.
          const message = {
            topic: publication.topic,
            payload: publication.message,
            options: publication.options,
          };
          yield* Effect.logInfo("Reservation hold cleanup enqueue started", {
            message,
          });

          const outcome = yield* reservationHoldCleanupTopic
            .publish(schedule)
            .pipe(
              Effect.provideService(QueuePublisher, publisher),
              Effect.mapError((error) =>
                ReservationHoldCleanupScheduleError.fromError(
                  "Reservation hold cleanup could not be enqueued."
                )(error.cause)
              )
            );

          yield* Effect.logInfo(enqueueOutcomeMessages[outcome], { message });
        }),
      };
    })
  );
}

/** A delivery exactly at the deadline is still on time. */
const isPastCleanupDeadline = (
  payload: ReservationHoldCleanupSchedulePayload,
  now: Temporal.Instant
) =>
  payload.cleanupDeadlineIso !== undefined &&
  Temporal.Instant.compare(
    now,
    Temporal.Instant.from(payload.cleanupDeadlineIso)
  ) > 0;

const acknowledgePastCleanupDeadline = (
  payload: ReservationHoldCleanupSchedulePayload,
  now: Temporal.Instant
) =>
  Effect.logWarning(
    "Reservation hold cleanup queue message acknowledged: past its cleanup deadline",
    { payload, checkedAt: now }
  ).pipe(Effect.as("past_deadline" as const));

/** Cleans up a delivery already accepted against its cleanup deadline. */
const cleanUpScheduledHold = Effect.fn(
  "reservationHoldCleanupSchedule.processMessage"
)(function* (
  payload: ReservationHoldCleanupSchedulePayload,
  now = Temporal.Now.instant()
) {
  const reservationHoldExpiresAt = Temporal.Instant.from(
    payload.reservationHoldExpiresAtIso
  );

  const cleanup = yield* ReservationHoldCleanupService;
  const outcome = yield* cleanup
    .cancelOrderHold({
      orderId: payload.orderId,
      holdExpiresAt: reservationHoldExpiresAt,
      checkedAt: now,
    })
    .pipe(
      Effect.mapError(
        ReservationHoldCleanupScheduleError.fromError(
          "Queued reservation hold cleanup failed."
        )
      )
    );

  if (outcome === "not_due") {
    yield* Effect.logInfo(
      "Reservation hold cleanup queue message ignored: reservation not due",
      { payload }
    );
    return "ignored" as const;
  }

  if (outcome instanceof ProviderPaymentDeferral) {
    yield* Effect.logInfo(
      "Reservation hold cleanup queue message deferred until provider cutoff",
      { payload, abandonmentCutoff: outcome.abandonmentCutoff }
    );
    return yield* new ReservationHoldCleanupDeferredError({
      redeliverAt: outcome.abandonmentCutoff,
    });
  }

  if (outcome instanceof HoldCancellationInProgress) {
    yield* Effect.logInfo(
      "Reservation hold cleanup queue message deferred until another run's claim is stale",
      { payload, staleAt: outcome.staleAt }
    );
    return yield* new ReservationHoldCleanupDeferredError({
      redeliverAt: outcome.staleAt,
    });
  }

  return outcome satisfies ReservationHoldCleanupOutcome;
});

export const processReservationHoldCleanupScheduleMessage = (
  payload: ReservationHoldCleanupSchedulePayload,
  now = Temporal.Now.instant()
) =>
  isPastCleanupDeadline(payload, now)
    ? acknowledgePastCleanupDeadline(payload, now)
    : cleanUpScheduledHold(payload, now);

/** Classifies a failed delivery; the route's Layer failures stay unclassified. */
export const reservationHoldCleanupRedelivery = (cause: unknown) =>
  cause instanceof ReservationHoldCleanupDeferredError
    ? QueueRedelivery.At({ instant: cause.redeliverAt })
    : QueueRedelivery.Default();

/**
 * The queue delivery: the receive instant alone decides the cleanup deadline,
 * before `dependencies` are built, so a late delivery never retries even when
 * they can't be. An accepted delivery's cleanup reads its own clock once they
 * are built.
 */
export const reservationHoldCleanupConsumer = <ROut, E, RIn>(
  dependencies: Layer.Layer<ROut | ReservationHoldCleanupService, E, RIn>
) =>
  reservationHoldCleanupTopic.consume((message) => {
    const receivedAt = Temporal.Now.instant();
    return isPastCleanupDeadline(message, receivedAt)
      ? acknowledgePastCleanupDeadline(message, receivedAt)
      : cleanUpScheduledHold(message).pipe(Effect.provide(dependencies));
  }, reservationHoldCleanupRedelivery);
