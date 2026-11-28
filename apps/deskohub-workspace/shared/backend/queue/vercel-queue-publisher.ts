import { Data, Effect, Layer } from "effect";
import {
  QueueMessageSendError,
  QueuePublisher,
  type QueuePublishOutcome,
} from "./queue-publisher";

class DuplicateQueueMessageError extends Data.TaggedError(
  "DuplicateQueueMessageError"
) {}

// Feature modules also expose Layers that a worker can build with another
// publisher. Load the SDK only when the runtime selects this Layer.
export const VercelQueuePublisher = Layer.effect(
  QueuePublisher,
  Effect.promise(() => import("@vercel/queue")).pipe(
    Effect.map(({ DuplicateMessageError, send }) => ({
      publish: ({ topic, message, options }) =>
        Effect.tryPromise({
          try: () => send(topic, message, options),
          catch: (cause) =>
            cause instanceof DuplicateMessageError
              ? new DuplicateQueueMessageError()
              : new QueueMessageSendError({ topic, cause }),
        }).pipe(
          Effect.as<QueuePublishOutcome>("published"),
          Effect.catchTag("DuplicateQueueMessageError", () =>
            Effect.succeed<QueuePublishOutcome>("duplicate")
          )
        ),
    }))
  )
);
