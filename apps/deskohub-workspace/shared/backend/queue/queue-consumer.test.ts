import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, spyOn, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Data, Duration, Effect, Logger, Schema } from "effect";
import { SqlError } from "effect/sql";
import { reservationHoldCleanupTopic } from "@/features/checkout/backend/holds/reservation-hold-cleanup-topic";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { WorkspaceLoggerLive } from "@/shared/backend/logging/censorship";
import { makeMemoryQueue } from "./memory-queue.test-utils";
import {
  decideQueueRedelivery,
  defineQueueConsumer,
  previewQueueDeliveryLimit,
  type QueueDeliveryMode,
  QueueRedelivery,
} from "./queue-consumer";

class PermanentTestFailure extends Data.TaggedError("PermanentTestFailure") {}
class TransientTestFailure extends Data.TaggedError("TransientTestFailure") {}
class ScheduledTestFailure extends Data.TaggedError("ScheduledTestFailure")<{
  readonly at: Temporal.Instant;
}> {}
class UnclassifiedTestFailure extends Data.TaggedError(
  "UnclassifiedTestFailure"
)<{ readonly cause?: unknown }> {}

type TestFailure =
  | PermanentTestFailure
  | TransientTestFailure
  | ScheduledTestFailure
  | UnclassifiedTestFailure;

const now = Temporal.Instant.from("2026-10-20T12:00:00Z");

const redelivery = (failure: TestFailure): QueueRedelivery => {
  if (failure instanceof PermanentTestFailure) return QueueRedelivery.Never();
  if (failure instanceof TransientTestFailure) {
    return QueueRedelivery.WithBackoff();
  }
  if (failure instanceof ScheduledTestFailure) {
    return QueueRedelivery.At({ instant: failure.at });
  }
  return QueueRedelivery.Default();
};

const unavailableDatabase = new UnclassifiedTestFailure({
  cause: new EffectDrizzleQueryError({
    query: "select 1",
    params: [],
    cause: Cause.fail(
      new SqlError.SqlError({
        reason: new SqlError.AuthenticationError({
          cause: Object.assign(new Error("password authentication failed"), {
            code: "28P01",
          }),
          operation: "acquireConnection",
        }),
      })
    ),
  }),
});

const decide = (input: {
  readonly failure: TestFailure;
  readonly deliveryCount?: number;
  readonly mode?: QueueDeliveryMode;
}) =>
  decideQueueRedelivery({
    cause: Cause.fail(input.failure),
    redelivery,
    deliveryCount: input.deliveryCount ?? 1,
    mode: input.mode ?? "durable",
  });

const metadata = (deliveryCount: number) => ({
  messageId: "message-id",
  deliveryCount,
  topic: "test-topic",
});

describe("decideQueueRedelivery", () => {
  test("acknowledges a permanent failure", () => {
    expect(decide({ failure: new PermanentTestFailure() })).toEqual({
      reason: "permanent_failure",
      action: { _tag: "Acknowledge" },
    });
  });

  test("backs a transient failure off exponentially up to its cap", () => {
    const delays = [1, 2, 3, 4, 5, 6, 30].map(
      (deliveryCount) =>
        decide({ failure: new TransientTestFailure(), deliveryCount }).action
    );

    expect(delays).toEqual(
      [60, 120, 240, 480, 900, 900, 900].map((seconds) => ({
        _tag: "RetryAfter",
        delay: Duration.seconds(seconds),
      }))
    );
  });

  test("preserves the scheduled instant for the delivery adapter", () => {
    const at = now.add({ hours: 3, milliseconds: 1 });
    expect(decide({ failure: new ScheduledTestFailure({ at }) })).toEqual({
      reason: "scheduled",
      action: { _tag: "RetryAt", instant: at },
    });
  });

  test("leaves an unclassified failure to the trigger's retry delay", () => {
    expect(decide({ failure: new UnclassifiedTestFailure({}) })).toEqual({
      reason: "unclassified",
      action: { _tag: "RetryDefault" },
    });
  });

  test("classifies only a lone typed failure", () => {
    expect(
      decideQueueRedelivery({
        cause: Cause.combine(
          Cause.fail(new PermanentTestFailure()),
          Cause.die(new Error("defect"))
        ),
        redelivery,
        deliveryCount: 1,
        mode: "durable",
      }).action
    ).toEqual({ _tag: "RetryDefault" });
  });

  test("acknowledges a Preview message whose database is gone", () => {
    expect(decide({ failure: unavailableDatabase, mode: "preview" })).toEqual({
      reason: "preview_database_unavailable",
      action: { _tag: "Acknowledge" },
    });
  });

  test("backs off an unavailable database for durable messages", () => {
    expect(decide({ failure: unavailableDatabase, deliveryCount: 3 })).toEqual({
      reason: "database_unavailable",
      action: { _tag: "RetryAfter", delay: Duration.seconds(240) },
    });
  });

  test("never lets a consumer acknowledge an unavailable database outside Preview", () => {
    expect(
      decideQueueRedelivery({
        cause: Cause.fail(unavailableDatabase),
        redelivery: () => QueueRedelivery.Never(),
        deliveryCount: 1,
        mode: "durable",
      }).action
    ).toEqual({ _tag: "RetryAfter", delay: Duration.seconds(60) });
  });

  test("abandons a failing Preview message at the delivery limit only", () => {
    const failure = new UnclassifiedTestFailure({});

    expect(
      decide({
        failure,
        mode: "preview",
        deliveryCount: previewQueueDeliveryLimit - 1,
      }).action
    ).toEqual({ _tag: "RetryDefault" });
    expect(
      decide({
        failure,
        mode: "preview",
        deliveryCount: previewQueueDeliveryLimit,
      })
    ).toEqual({
      reason: "preview_delivery_limit",
      action: { _tag: "Acknowledge" },
    });
    expect(
      decide({
        failure,
        mode: "durable",
        deliveryCount: 500,
      }).action
    ).toEqual({ _tag: "RetryDefault" });
  });
});

describe("queue delivery", () => {
  const consumer = (handle: () => Effect.Effect<unknown, TestFailure>) =>
    defineQueueConsumer({
      label: "Test",
      schema: Schema.toStandardSchemaV1(Schema.Struct({})),
      handle,
      redelivery,
    });

  test("publishes and delivers a hold-cleanup command in process", async () => {
    const queue = makeMemoryQueue();
    const orderId = workspaceReservationIdSchema.make("order-id");
    const expiresAt = now.add({ minutes: 10 });
    const deliveries: unknown[] = [];
    const consume = reservationHoldCleanupTopic.consume((message) =>
      Effect.sync(() => deliveries.push(message))
    );

    const publish = reservationHoldCleanupTopic.publish({
      orderId,
      reservationHoldExpiresAt: expiresAt,
      now,
    });
    const outcomes = await Effect.all([publish, publish]).pipe(
      Effect.provide(queue.layer),
      Effect.runPromise
    );
    expect(outcomes).toEqual(["published", "duplicate"]);

    const publication = queue.take();
    if (!publication) throw new Error("No queued hold cleanup command");
    const delivery = { ...metadata(1), topic: publication.topic };
    expect(
      await consume(
        { ...delivery, payload: publication.message },
        "durable"
      ).pipe(Effect.runPromise)
    ).toEqual({ _tag: "Handled" });
    expect(
      await consume({ ...delivery, payload: { orderId } }, "durable").pipe(
        Effect.runPromise
      )
    ).toEqual({ _tag: "Invalid" });
    expect(deliveries).toEqual([
      {
        schemaVersion: 1,
        orderId,
        reservationHoldExpiresAtIso: expiresAt.toString(),
        cleanupDeadlineIso: "2026-10-20T13:10:00Z",
      },
    ]);
  });

  test("returns the redelivery decision without the cause", async () => {
    const outcome = await consumer(() => Effect.fail(unavailableDatabase))(
      { ...metadata(2), payload: {} },
      "durable"
    ).pipe(Effect.runPromise);

    expect(outcome).toEqual({
      _tag: "Failed",
      reason: "database_unavailable",
      action: { _tag: "RetryAfter", delay: Duration.seconds(120) },
    });
  });

  test("censors the original cause before using the worker's logger", async () => {
    const email = testEmailAddress("private-queue-cause");
    const failure = Object.assign(new TransientTestFailure(), { email });
    const log = spyOn(console, "log").mockImplementation(() => {});

    try {
      const outcome = await consumer(() => Effect.fail(failure))(
        { ...metadata(2), payload: {} },
        "durable"
      ).pipe(
        Effect.provide(Logger.layer([Logger.consoleJson])),
        Effect.runPromise
      );

      expect(outcome).toEqual({
        _tag: "Failed",
        reason: "transient_failure",
        action: { _tag: "RetryAfter", delay: Duration.seconds(120) },
      });
      const entries = log.mock.calls.flat().join("\n");
      expect(entries).toContain("transient_failure");
      expect(entries).not.toContain(email);
    } finally {
      log.mockRestore();
    }
  });

  test("keeps censored defect details in Workspace logs", async () => {
    const privateMessage = "private-defect-message";
    const log = spyOn(console, "error").mockImplementation(() => {});

    try {
      await consumer(() => Effect.die(new TypeError(privateMessage)))(
        { ...metadata(1), payload: {} },
        "durable"
      ).pipe(Effect.provide(WorkspaceLoggerLive), Effect.runPromise);

      const entries = log.mock.calls.flat().join("\n");
      expect(entries).toContain("TypeError");
      expect(entries).not.toContain(privateMessage);
    } finally {
      log.mockRestore();
    }
  });

  test("loads feature handlers without the Vercel SDK", async () => {
    mock.module("@vercel/queue", () => {
      throw new Error("Attempted to load the Vercel queue SDK");
    });

    const [hold, automation] = await Promise.all([
      import(
        "@/features/checkout/backend/holds/reservation-hold-cleanup-queue.service"
      ),
      import(
        "@/features/email-campaigns/automation/backend/automation-unit-queue-consumer"
      ),
    ]);
    expect(hold.processReservationHoldCleanupScheduleMessage).toBeFunction();
    expect(automation.processAutomationUnitMessage).toBeFunction();
  });

  test("keeps an interruption unclassified", async () => {
    const exit = await consumer(() => Effect.interrupt)(
      { ...metadata(1), payload: {} },
      "durable"
    ).pipe(Effect.exit, Effect.runPromise);

    expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(
      true
    );
  });
});
