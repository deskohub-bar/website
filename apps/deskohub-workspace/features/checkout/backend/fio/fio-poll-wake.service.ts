import { randomUUID } from "node:crypto";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import type { WorkspaceTransaction } from "@/db/database.service";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import {
  QueueMessageSendError,
  QueuePublisher,
} from "@/shared/backend/queue/queue-publisher";
import { defineQueueTopic } from "@/shared/backend/queue/queue-topic";
import { FioAccountPollRepository } from "./fio-account-poll.repository";

export const fioPollMaxWindowDays = 31;

const pollJobSchema = Schema.Struct({
  accountKey: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  deliveryId: Schema.String.check(Schema.isUUID(4)),
  windowDays: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: fioPollMaxWindowDays })
    )
  ),
  advanceAfter: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
  ),
});

export type FioPollJob = typeof pollJobSchema.Type;

// Redelivery backs off up to 15 minutes. After an extended lack of progress,
// new demand can replace a lost job without clearing the checkpoint or gate.
export const fioPollDeliveryExpiry = (now: Temporal.Instant) =>
  new Date(now.add({ minutes: 20 }).epochMilliseconds);

export const fioPollTopic = defineQueueTopic({
  topic: "workspace-fio-account-poll",
  label: "Fio account polling",
  message: Schema.toStandardSchemaV1(pollJobSchema),
  publish: ({
    job,
    delay,
  }: {
    job: FioPollJob;
    delay?: Duration.Duration;
  }) => ({
    message: job,
    key: job.deliveryId,
    delay,
  }),
  retention: Duration.hours(24),
});

interface IFioPollWake {
  readonly wake: (
    accountKey: string
  ) => Effect.Effect<
    void,
    DatabaseQueryError | QueueMessageSendError,
    WorkspaceTransaction
  >;
}

export class FioPollWake extends Context.Service<FioPollWake, IFioPollWake>()(
  "FioPollWake"
) {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const polls = yield* FioAccountPollRepository;
      const publisher = yield* QueuePublisher;

      return {
        wake: Effect.fn("FioPollWake.wake")(function* (accountKey) {
          yield* polls.initialize(accountKey);
          const poll = yield* polls.lock(accountKey);
          if (!poll)
            return yield* Effect.die(
              "Fio poll wake did not establish an account row"
            );
          const now = yield* polls.currentTime(accountKey);
          if (
            poll.deliveryId &&
            poll.deliveryExpiresAt &&
            poll.deliveryExpiresAt.getTime() > now.epochMilliseconds
          )
            return;

          // Publish under the same lock the consumer takes before checking demand.
          // A rolled-back delivery cannot match any later wake's freshly minted ID.
          const deliveryId = randomUUID();
          yield* polls.update(accountKey, {
            deliveryId,
            deliveryExpiresAt: fioPollDeliveryExpiry(now),
          });
          yield* publishFioPollJob({ accountKey, deliveryId }).pipe(
            Effect.provideService(QueuePublisher, publisher)
          );
        }),
      };
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(FioAccountPollRepository.Default, QueuePublisher.Default)
    )
  );
}

export const publishFioPollJob = (job: FioPollJob, delay?: Duration.Duration) =>
  fioPollTopic.publish(delay === undefined ? { job } : { job, delay }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () =>
        Effect.fail(new QueueMessageSendError({ topic: fioPollTopic.topic })),
    })
  );
