import { Context, Data, type Effect } from "effect";

export class QueueMessageSendError extends Data.TaggedError(
  "QueueMessageSendError"
)<{
  readonly topic: string;
  readonly cause?: unknown;
}> {}

/** One message to publish to a queue topic. */
export type QueuePublication<Message = unknown> = {
  readonly topic: string;
  readonly message: Message;
  readonly options: {
    /** Holds the first delivery back by this long. */
    readonly delaySeconds?: number | undefined;
    /** Defaults to the queue's retention. */
    readonly retentionSeconds?: number | undefined;
    /** Stable across retries, so a repeated publish is a no-op. */
    readonly idempotencyKey: string;
  };
};

/** `duplicate`: the idempotency key was already published. */
export type QueuePublishOutcome = "published" | "duplicate";

interface IQueuePublisher {
  readonly publish: (
    publication: QueuePublication
  ) => Effect.Effect<QueuePublishOutcome, QueueMessageSendError>;
}

/** Publishes messages to Workspace queue topics. */
export class QueuePublisher extends Context.Service<
  QueuePublisher,
  IQueuePublisher
>()("@deskohub-workspace/QueuePublisher") {}
