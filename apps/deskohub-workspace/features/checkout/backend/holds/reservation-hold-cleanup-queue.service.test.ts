import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposReservationIdSchema,
  type DotyposService as DotyposServiceTag,
} from "@deskohub/dotypos";
import { decodeStandardSchema } from "@deskohub/standard-schema";
import { Effect, Layer, Logger } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import type {
  IWorkspaceReservationRepository,
  WorkspaceReservation,
} from "@/features/reservation/backend/workspace-reservation.repository";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { instantStringSchema } from "@/shared/utils/temporal";
import type { IReservationHoldCleanupService } from "./reservation-hold-cleanup.service";
import {
  type ReservationHoldCleanupSchedulePayload,
  reservationHoldCleanupTopic,
} from "./reservation-hold-cleanup-topic";

const now = Temporal.Instant.from("2026-06-01T10:00:00.000Z");
const expiresAt = Temporal.Instant.from("2026-06-01T10:10:00.000Z");
const dueNow = Temporal.Instant.from("2026-06-01T10:10:00.000Z");

const orderId = workspaceReservationIdSchema.make("order-id");
const createdAt = Temporal.Instant.from("2026-06-01T09:55:00.000Z");
const dotyposReservationId = DotyposReservationIdSchema.make(
  "dotypos-reservation-id"
);

const makeReservation = (
  overrides: Partial<WorkspaceReservation> = {}
): WorkspaceReservation =>
  workspaceReservationFixture({
    id: orderId,
    dotyposCustomerId: DotyposCustomerIdSchema.make("customer-id"),
    dotyposReservationId,
    reservationState: "held",
    paymentState: "not_started",
    fulfillmentState: "not_started",
    reservationDetails: { kind: "cowork", entryTier: "basic", coffee: false },
    productTier: "basic",
    locale: "en-US",
    reservationHoldExpiresAt: expiresAt,
    reservationCreatedAt: createdAt,
    reservationConfirmedAt: null,
    paidAt: null,
    fulfilledAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });

const decodePublishedCleanup = (
  message: ReturnType<typeof reservationHoldCleanupTopic.publication>["message"]
) =>
  requireValue(
    decodeStandardSchema(reservationHoldCleanupTopic.message, message),
    "valid published cleanup message"
  );

const runProcessMessage = async (
  message: Parameters<
    typeof import("./reservation-hold-cleanup-queue.service").processReservationHoldCleanupScheduleMessage
  >[0],
  input: {
    readonly findById?: IWorkspaceReservationRepository["findById"];
    readonly cancelOrderHold?: IReservationHoldCleanupService["cancelOrderHold"];
    readonly now?: Temporal.Instant;
  } = {}
) => {
  const { ReservationHoldCleanupService } = await import(
    "./reservation-hold-cleanup.service"
  );
  const { processReservationHoldCleanupScheduleMessage } = await import(
    "./reservation-hold-cleanup-queue.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const findById =
    input.findById ?? mock(() => Effect.succeed(makeReservation()));
  const cancelOrderHold =
    input.cancelOrderHold ?? mock(() => Effect.succeed("cancelled" as const));
  const logs: Array<{ level: string; message: unknown }> = [];
  const captureLogs = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      const [text] = Array.isArray(message) ? message : [message];
      logs.push({ level: logLevel, message: text });
    }),
  ]);

  const result = await processReservationHoldCleanupScheduleMessage(
    message,
    input.now ?? now
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceReservationRepository, {
          findById,
        }),
        Layer.mock(ReservationHoldCleanupService, {
          cancelOrderHold,
          sweepExpiredHolds: mock(() =>
            Effect.succeed({ cancelled: 0, skipped: 0, failed: 0 })
          ),
        } satisfies IReservationHoldCleanupService),
        captureLogs
      )
    ),
    Effect.runPromise
  );

  return { result, findById, cancelOrderHold, logs };
};

/**
 * Delivers `payload` to the real cleanup service over `reservation`. The
 * claim reports whether the cleanup got as far as claiming the hold.
 */
const deliverToCleanup = async (
  payload: Parameters<
    typeof import("./reservation-hold-cleanup-queue.service").processReservationHoldCleanupScheduleMessage
  >[0],
  reservation: WorkspaceReservation,
  deliveredAt: Temporal.Instant
) => {
  const { ReservationHoldCleanupService } = await import(
    "./reservation-hold-cleanup.service"
  );
  const { UnpaidHoldRelease } = await import("./unpaid-hold-release.service");
  const { ProviderPaymentFinalizationService } = await import(
    "../payment/provider-payment-finalization.service"
  );
  const { PaymentLifecycleRepository } = await import(
    "../repositories/payment-lifecycle.repository"
  );
  const { processReservationHoldCleanupScheduleMessage } = await import(
    "./reservation-hold-cleanup-queue.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { silentCheckoutAnalytics } = await import(
    "../analytics/checkout-analytics.service.mock"
  );
  const { CheckoutAnalytics } = await import(
    "../analytics/checkout-analytics.service"
  );
  const { DotyposService } = await import("@deskohub/dotypos");
  const claimCancellation = mock<
    IWorkspaceReservationRepository["claimCancellation"]
  >(() => Effect.succeed({ ...reservation, reservationState: "cancelling" }));
  const lock = makeRecordingAdvisoryLock();
  const result = await processReservationHoldCleanupScheduleMessage(
    payload,
    deliveredAt
  ).pipe(
    Effect.provide(
      ReservationHoldCleanupService.Default.pipe(
        Layer.provide(UnpaidHoldRelease.Default),
        Layer.provide(lock.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(WorkspaceReservationRepository, {
              findById: mock(() => Effect.succeed(reservation)),
              claimCancellation,
              markCancelled: mock(() => Effect.void),
            }),
            Layer.mock(ProviderPaymentFinalizationService, {}),
            Layer.mock(PaymentLifecycleRepository, {}),
            Layer.mock(CheckoutAnalytics, silentCheckoutAnalytics),
            Layer.mock(DotyposService, {
              getReservationStatus: mock(() => Effect.succeed("NEW" as const)),
              cancelReservation: mock(() => Effect.void),
            })
          )
        )
      )
    ),
    Effect.runPromise
  );
  return { result, claimCancellation, lockKeys: lock.entered };
};

const duePayload: ReservationHoldCleanupSchedulePayload = {
  schemaVersion: 1,
  orderId,
  reservationHoldExpiresAtIso: instantStringSchema.make(expiresAt.toString()),
};
// Enqueued at `now`: the hold's ten minutes plus the hour of retries.
const cleanupDeadline = Temporal.Instant.from("2026-06-01T11:10:00.000Z");
const scheduledPayload = {
  ...duePayload,
  cleanupDeadlineIso: instantStringSchema.make(cleanupDeadline.toString()),
};

describe("ReservationHoldCleanupScheduleService", () => {
  test("builds bounded delayed queue messages with idempotency", async () => {
    const {
      reservationHoldCleanupScheduleMaxDelaySeconds,
      reservationHoldCleanupTopic,
    } = await import("./reservation-hold-cleanup-topic");

    const message = reservationHoldCleanupTopic.publication({
      orderId,
      reservationHoldExpiresAt: expiresAt,
      now,
    });
    expect(message).toEqual({
      topic: "workspace-reservation-hold-cleanup",
      message: scheduledPayload,
      options: {
        delaySeconds: 600,
        retentionSeconds: 4200,
        idempotencyKey:
          "reservation-hold-cleanup:order-id:2026-06-01T10:10:00Z",
      },
    });
    expect(JSON.stringify(message.message)).toBe(
      '{"schemaVersion":1,"orderId":"order-id","reservationHoldExpiresAtIso":"2026-06-01T10:10:00Z","cleanupDeadlineIso":"2026-06-01T11:10:00Z"}'
    );

    const clamped = reservationHoldCleanupTopic.publication({
      orderId,
      reservationHoldExpiresAt: Temporal.Instant.from(
        "2026-06-09T10:00:01.000Z"
      ),
      now,
    });
    expect(clamped.options.delaySeconds).toBe(
      reservationHoldCleanupScheduleMaxDelaySeconds
    );
    expect(clamped.options.retentionSeconds).toBe(
      reservationHoldCleanupScheduleMaxDelaySeconds
    );
    // At the cap the deadline is the end of retention, leaving no retries.
    expect(clamped.message.cleanupDeadlineIso).toBe(
      now
        .add({ seconds: reservationHoldCleanupScheduleMaxDelaySeconds })
        .toString()
    );

    const overdue = reservationHoldCleanupTopic.publication({
      orderId,
      reservationHoldExpiresAt: now.subtract({ minutes: 5 }),
      now,
    });
    expect(overdue.options).toMatchObject({
      delaySeconds: 0,
      retentionSeconds: 3600,
    });
    expect(overdue.message.cleanupDeadlineIso).toBe(
      now.add({ hours: 1 }).toString()
    );
  });

  test("treats duplicate queue messages as already enqueued", async () => {
    const { ReservationHoldCleanupScheduleService } = await import(
      "./reservation-hold-cleanup-queue.service"
    );
    const { makeMemoryQueue } = await import(
      "@/shared/backend/queue/memory-queue.test-utils"
    );
    const queue = makeMemoryQueue();
    const logs: Array<{ message: unknown; fields: unknown }> = [];
    const captureLogs = Logger.layer([
      Logger.make(({ message }) => {
        const [text, fields] = Array.isArray(message) ? message : [message];
        logs.push({ message: text, fields });
      }),
    ]);
    const enqueue = () =>
      Effect.flatMap(ReservationHoldCleanupScheduleService, (service) =>
        service.enqueueCleanup({
          orderId,
          reservationHoldExpiresAt: expiresAt,
        })
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ReservationHoldCleanupScheduleService.Default.pipe(
              Layer.provide(queue.layer)
            ),
            captureLogs
          )
        ),
        Effect.runPromise
      );

    // The second enqueue resolves instead of failing with a schedule error.
    await enqueue();
    await enqueue();
    expect(queue.published()).toHaveLength(1);
    expect(logs.map(({ message }) => message)).toEqual([
      "Reservation hold cleanup enqueue started",
      "Reservation hold cleanup enqueued",
      "Reservation hold cleanup enqueue started",
      "Reservation hold cleanup was already enqueued",
    ]);
    // The logged message keeps its pre-topic shape.
    expect(logs[0]?.fields).toEqual({
      message: {
        topic: "workspace-reservation-hold-cleanup",
        payload: queue.published()[0]?.message,
        options: queue.published()[0]?.options,
      },
    });
  });

  test("decodes only well-formed messages", async () => {
    for (const message of [
      { ...duePayload, schemaVersion: 2 },
      { ...duePayload, orderId: "" },
      { ...duePayload, reservationHoldExpiresAtIso: "tomorrow" },
      { schemaVersion: 1, orderId: "order-id" },
      { ...duePayload, cleanupDeadlineIso: "tomorrow" },
    ]) {
      expect(
        decodeStandardSchema(reservationHoldCleanupTopic.message, message)
      ).toBeUndefined();
    }
    expect(
      decodeStandardSchema(reservationHoldCleanupTopic.message, duePayload)
    ).toEqual(duePayload);
    expect(
      decodeStandardSchema(
        reservationHoldCleanupTopic.message,
        scheduledPayload
      )
    ).toEqual(scheduledPayload);
    // Rollback safety: the deadline rides under version 1 because unknown keys
    // decode instead of failing, as a later field does for this decoder.
    expect(
      decodeStandardSchema(reservationHoldCleanupTopic.message, {
        ...scheduledPayload,
        laterField: "ignored",
      })
    ).toEqual(scheduledPayload);
  });

  test("cleans up a scheduled hold on or before its cleanup deadline", async () => {
    for (const deliveredAt of [dueNow, cleanupDeadline]) {
      const delivery = await runProcessMessage(scheduledPayload, {
        now: deliveredAt,
      });

      expect(delivery.result).toBe("cancelled");
      expect(delivery.cancelOrderHold).toHaveBeenCalledWith({
        orderId,
        holdExpiresAt: expiresAt,
        checkedAt: deliveredAt,
      });
    }
  });

  test("acknowledges without cleanup after the cleanup deadline", async () => {
    const delivery = await runProcessMessage(scheduledPayload, {
      now: cleanupDeadline.add({ microseconds: 1 }),
    });

    expect(delivery.result).toBe("past_deadline");
    expect(delivery.cancelOrderHold).not.toHaveBeenCalled();
    expect(delivery.findById).not.toHaveBeenCalled();
    expect(delivery.logs).toEqual([
      {
        level: "Warn",
        message:
          "Reservation hold cleanup queue message acknowledged: past its cleanup deadline",
      },
    ]);
  });

  test("acknowledges a late delivery before building its cleanup dependencies", async () => {
    const { reservationHoldCleanupConsumer } = await import(
      "./reservation-hold-cleanup-queue.service"
    );
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    const builds = mock(() => undefined);
    const consume = reservationHoldCleanupConsumer(
      Layer.effect(
        ReservationHoldCleanupService,
        Effect.sync(builds).pipe(
          Effect.andThen(Effect.fail(new Error("database unavailable")))
        )
      )
    );
    const deliver = (payload: typeof scheduledPayload) =>
      consume(
        {
          messageId: "message-id",
          deliveryCount: 1,
          topic: "workspace-reservation-hold-cleanup",
          payload,
        },
        "durable"
      ).pipe(Effect.runPromise);

    // The deadline is long past on the real clock.
    expect(await deliver(scheduledPayload)).toEqual({ _tag: "Handled" });
    expect(builds).not.toHaveBeenCalled();

    const onTime = await deliver({
      ...scheduledPayload,
      cleanupDeadlineIso: instantStringSchema.make(
        Temporal.Now.instant().add({ hours: 1 }).toString()
      ),
    });
    expect(onTime._tag).not.toBe("Handled");
    expect(builds).toHaveBeenCalledTimes(1);
  });

  test("checks a delivered hold once its cleanup dependencies are built", async () => {
    const { reservationHoldCleanupConsumer } = await import(
      "./reservation-hold-cleanup-queue.service"
    );
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    let builtAt: Temporal.Instant | undefined;
    let checkedAt: Temporal.Instant | undefined;
    const cancelOrderHold = mock<
      IReservationHoldCleanupService["cancelOrderHold"]
    >((input) => {
      checkedAt = input.checkedAt;
      return Effect.succeed("cancelled" as const);
    });
    const consume = reservationHoldCleanupConsumer(
      Layer.effect(
        ReservationHoldCleanupService,
        Effect.sleep("20 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              builtAt = Temporal.Now.instant();
              return {
                cancelOrderHold,
                sweepExpiredHolds: mock(() =>
                  Effect.succeed({ cancelled: 0, skipped: 0, failed: 0 })
                ),
              } satisfies IReservationHoldCleanupService;
            })
          )
        )
      )
    );

    const outcome = await consume(
      {
        messageId: "message-id",
        deliveryCount: 1,
        topic: "workspace-reservation-hold-cleanup",
        payload: duePayload,
      },
      "durable"
    ).pipe(Effect.runPromise);

    expect(outcome).toEqual({ _tag: "Handled" });
    // A provider cutoff crossed while dependencies build counts as passed.
    expect(
      checkedAt && builtAt && Temporal.Instant.compare(checkedAt, builtAt)
    ).toBeGreaterThanOrEqual(0);
  });

  test("cleans up a delivery received by its deadline even when dependencies build past it", async () => {
    const { reservationHoldCleanupConsumer } = await import(
      "./reservation-hold-cleanup-queue.service"
    );
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    const cancelOrderHold = mock(() => Effect.succeed("cancelled" as const));
    const consume = reservationHoldCleanupConsumer(
      Layer.effect(
        ReservationHoldCleanupService,
        Effect.sleep("150 millis").pipe(
          Effect.as({
            cancelOrderHold,
            sweepExpiredHolds: mock(() =>
              Effect.succeed({ cancelled: 0, skipped: 0, failed: 0 })
            ),
          } satisfies IReservationHoldCleanupService)
        )
      )
    );
    const deadline = Temporal.Now.instant().add({ milliseconds: 50 });

    const outcome = await consume(
      {
        messageId: "message-id",
        deliveryCount: 1,
        topic: "workspace-reservation-hold-cleanup",
        payload: {
          ...duePayload,
          cleanupDeadlineIso: instantStringSchema.make(deadline.toString()),
        },
      },
      "durable"
    ).pipe(Effect.runPromise);

    expect(outcome).toEqual({ _tag: "Handled" });
    expect(cancelOrderHold).toHaveBeenCalledTimes(1);
  });

  test("keeps the enqueue clock's full precision in the cleanup deadline", async () => {
    const enqueuedAt = Temporal.Instant.from("2026-06-01T10:00:00.123456789Z");
    const { message, options } = reservationHoldCleanupTopic.publication({
      orderId,
      reservationHoldExpiresAt: expiresAt,
      now: enqueuedAt,
    });
    const retentionEnd = enqueuedAt.add({ seconds: options.retentionSeconds });

    const onTime = await runProcessMessage(decodePublishedCleanup(message), {
      now: retentionEnd,
    });
    expect(onTime.result).toBe("cancelled");

    const late = await runProcessMessage(decodePublishedCleanup(message), {
      now: retentionEnd.add({ nanoseconds: 1 }),
    });
    expect(late.result).toBe("past_deadline");
  });

  test("gives a hold scheduled at the delay cap no late retries", async () => {
    const capExpiresAt = now.add({ hours: 7 * 24 });
    const { message } = reservationHoldCleanupTopic.publication({
      orderId,
      reservationHoldExpiresAt: capExpiresAt,
      now,
    });
    expect(message.cleanupDeadlineIso).toBe(
      message.reservationHoldExpiresAtIso
    );

    const onTime = await runProcessMessage(decodePublishedCleanup(message), {
      now: capExpiresAt,
    });
    expect(onTime.result).toBe("cancelled");

    const retry = await runProcessMessage(decodePublishedCleanup(message), {
      now: capExpiresAt.add({ seconds: 1 }),
    });
    expect(retry.result).toBe("past_deadline");
    expect(retry.cancelOrderHold).not.toHaveBeenCalled();
  });

  test("runs cleanup for a message without a deadline whenever it arrives", async () => {
    const delivery = await runProcessMessage(duePayload, {
      now: dueNow.add({ hours: 30 * 24 }),
    });

    expect(delivery.result).toBe("cancelled");
    expect(delivery.cancelOrderHold).toHaveBeenCalledTimes(1);
  });

  test("acknowledges a cleanup its order is no longer due for", async () => {
    const result = await runProcessMessage(duePayload, {
      cancelOrderHold: mock(() => Effect.succeed("not_due" as const)),
      now: dueNow,
    });

    expect(result.result).toBe("ignored");
  });

  test("checks under the order's lock that the hold is still the scheduled one", async () => {
    for (const reservation of [
      makeReservation({
        reservationHoldExpiresAt: Temporal.Instant.from(
          "2026-06-01T10:11:00.000Z"
        ),
      }),
      makeReservation({ paymentState: "paid" }),
      makeReservation({ reservationState: "cancelled" }),
      makeReservation({ reservationState: "confirmed" }),
    ]) {
      const delivery = await deliverToCleanup(duePayload, reservation, dueNow);

      expect(delivery.result).toBe("ignored");
      expect(delivery.claimCancellation).not.toHaveBeenCalled();
      expect(delivery.lockKeys).toEqual([["reservation-order", "order-id"]]);
    }
    const early = await deliverToCleanup(
      duePayload,
      makeReservation(),
      dueNow.subtract({ seconds: 1 })
    );
    expect(early.result).toBe("ignored");

    for (const reservationState of [
      "held",
      "cancelling",
      "cancellation_failed",
    ] as const) {
      const delivery = await deliverToCleanup(
        duePayload,
        makeReservation({ reservationState }),
        dueNow
      );
      expect(delivery.result).toBe("cancelled");
      expect(delivery.claimCancellation).toHaveBeenCalledWith({
        id: orderId,
        expectedHold: {
          dotyposReservationId,
          reservationHoldExpiresAt: expiresAt,
        },
        cause: "hold_expired",
      });
    }
  });

  test("cancels due reservation holds", async () => {
    const cancelOrderHold = mock(() => Effect.succeed("cancelled" as const));
    const result = await runProcessMessage(duePayload, {
      cancelOrderHold,
      now: dueNow,
    });

    expect(result.result).toBe("cancelled");
    expect(cancelOrderHold).toHaveBeenCalledWith({
      orderId,
      holdExpiresAt: expiresAt,
      checkedAt: dueNow,
    });
  });

  test("cancels a due hold whose deadline came from the nanosecond clock", async () => {
    const { toStoredInstant } = await import("@/db/instant");
    // Temporal.Now has nanoseconds; the reservation row keeps microseconds.
    const clockExpiresAt = Temporal.Instant.from(
      "2026-06-01T10:10:00.123456789Z"
    );
    const storedReservation = makeReservation({
      reservationHoldExpiresAt: toStoredInstant(clockExpiresAt),
    });
    const { message } = reservationHoldCleanupTopic.publication({
      orderId,
      reservationHoldExpiresAt: clockExpiresAt,
      now,
    });
    expect(message.reservationHoldExpiresAtIso).toBe(
      "2026-06-01T10:10:00.123456Z"
    );

    for (const payload of [
      decodePublishedCleanup(message),
      // Messages enqueued before the payload was stored-precision.
      {
        ...duePayload,
        reservationHoldExpiresAtIso: instantStringSchema.make(
          clockExpiresAt.toString()
        ),
      },
    ]) {
      const delivery = await deliverToCleanup(
        payload,
        storedReservation,
        dueNow.add({ seconds: 1 })
      );

      expect(delivery.result).toBe("cancelled");
      expect(delivery.claimCancellation).toHaveBeenCalledTimes(1);
    }
  });

  test("redelivers cleanup at the provider cutoff while an empty order is inside it", async () => {
    const { ProviderPaymentDeferral } = await import(
      "../payment/provider-payment-finalization.service"
    );
    const { reservationHoldCleanupRedelivery } = await import(
      "./reservation-hold-cleanup-queue.service"
    );
    const { QueueRedelivery } = await import(
      "@/shared/backend/queue/queue-consumer"
    );
    const abandonmentCutoff = dueNow.add({ minutes: 25 });
    const cancelOrderHold = mock(() =>
      Effect.succeed(new ProviderPaymentDeferral({ abandonmentCutoff }))
    );
    const retryNow = dueNow.add({ minutes: 20 });

    const failure = await runProcessMessage(duePayload, {
      cancelOrderHold,
      now: retryNow,
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(failure).toMatchObject({
      _tag: "ReservationHoldCleanupDeferredError",
      redeliverAt: abandonmentCutoff,
    });
    expect(reservationHoldCleanupRedelivery(failure)).toEqual(
      QueueRedelivery.At({ instant: abandonmentCutoff })
    );
    expect(cancelOrderHold).toHaveBeenCalledWith({
      orderId,
      holdExpiresAt: expiresAt,
      checkedAt: retryNow,
    });
  });

  test("redelivers cleanup once another run's fresh cancellation claim is stale", async () => {
    const { HoldCancellationInProgress } = await import(
      "./unpaid-hold-release.service"
    );
    const { reservationHoldCleanupRedelivery } = await import(
      "./reservation-hold-cleanup-queue.service"
    );
    const { QueueRedelivery } = await import(
      "@/shared/backend/queue/queue-consumer"
    );
    const staleAt = dueNow.add({ minutes: 10 });

    const failure = await runProcessMessage(duePayload, {
      cancelOrderHold: mock(() =>
        Effect.succeed(new HoldCancellationInProgress({ staleAt }))
      ),
      now: dueNow,
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(reservationHoldCleanupRedelivery(failure)).toEqual(
      QueueRedelivery.At({ instant: staleAt })
    );
  });

  test("acknowledges a hold Dotypos kept and redelivers one whose status can't be read", async () => {
    const { ReservationHoldCleanupService } = await import(
      "./reservation-hold-cleanup.service"
    );
    const { UnpaidHoldRelease } = await import("./unpaid-hold-release.service");
    const { ProviderPaymentFinalizationService } = await import(
      "../payment/provider-payment-finalization.service"
    );
    const { PaymentLifecycleRepository } = await import(
      "../repositories/payment-lifecycle.repository"
    );
    const {
      processReservationHoldCleanupScheduleMessage,
      reservationHoldCleanupRedelivery,
    } = await import("./reservation-hold-cleanup-queue.service");
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { silentCheckoutAnalytics } = await import(
      "../analytics/checkout-analytics.service.mock"
    );
    const { CheckoutAnalytics } = await import(
      "../analytics/checkout-analytics.service"
    );
    const { DotyposService, DotyposUnavailable } = await import(
      "@deskohub/dotypos"
    );
    const { QueueRedelivery } = await import(
      "@/shared/backend/queue/queue-consumer"
    );

    const deliver = (
      getReservationStatus: typeof DotyposServiceTag.Service.getReservationStatus
    ) => {
      const cancelReservation = mock(() => Effect.void);
      const markCancellationFailed = mock(() => Effect.void);
      const delivery = processReservationHoldCleanupScheduleMessage(
        duePayload,
        dueNow
      ).pipe(
        Effect.provide(
          ReservationHoldCleanupService.Default.pipe(
            Layer.provide(UnpaidHoldRelease.Default),
            Layer.provide(makeRecordingAdvisoryLock().layer),
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.mock(WorkspaceReservationRepository, {
                  findById: mock(() => Effect.succeed(makeReservation())),
                  claimCancellation: mock(() =>
                    Effect.succeed(
                      makeReservation({ reservationState: "cancelling" })
                    )
                  ),
                  markCancellationFailed,
                }),
                Layer.mock(ProviderPaymentFinalizationService, {}),
                Layer.mock(PaymentLifecycleRepository, {}),
                Layer.mock(CheckoutAnalytics, silentCheckoutAnalytics),
                Layer.mock(DotyposService, {
                  getReservationStatus: mock(getReservationStatus),
                  cancelReservation,
                })
              )
            )
          )
        ),
        Effect.result,
        Effect.runPromise
      );
      return { delivery, cancelReservation, markCancellationFailed };
    };

    const kept = deliver(() => Effect.succeed("CONFIRMED"));
    expect(await kept.delivery).toMatchObject({
      _tag: "Success",
      success: "skipped",
    });
    expect(kept.cancelReservation).not.toHaveBeenCalled();
    expect(kept.markCancellationFailed).toHaveBeenCalledWith({
      id: "order-id",
      claimedAt: makeReservation().updatedAt,
      failureCode: "dotypos_cancel_failed",
    });

    const statusUnavailable = new DotyposUnavailable({
      operation: "getReservationStatus",
      reason: "server",
    });
    const unreadable = deliver(() => Effect.fail(statusUnavailable));
    const result = await unreadable.delivery;
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ReservationHoldCleanupScheduleError",
        cause: {
          _tag: "ReservationHoldCleanupError",
          cause: statusUnavailable,
        },
      },
    });
    expect(
      reservationHoldCleanupRedelivery(
        result._tag === "Failure" ? result.failure : undefined
      )
    ).toEqual(QueueRedelivery.Default());
    expect(unreadable.cancelReservation).not.toHaveBeenCalled();
    expect(unreadable.markCancellationFailed).toHaveBeenCalledWith({
      id: "order-id",
      claimedAt: makeReservation().updatedAt,
      failureCode: "dotypos_cancel_failed",
    });
  });
});
