import {
  handleCallback,
  type MessageMetadata,
  type RetryDirective,
} from "@vercel/queue";
import { Data, Duration, Effect, Match } from "effect";
import { env } from "@/env";
import { defineWorkspaceTask } from "@/shared/backend/workspace-effect";
import { clamp } from "@/shared/utils";
import { currentInstant } from "@/shared/utils/temporal";
import {
  type QueueConsumer,
  type QueueDeliveryAction,
  type QueueDeliveryFailureReason,
  queueDeliveryFailureMessage,
  queueDeliveryModeForStage,
} from "./queue-consumer";

// Vercel Queues accepts visibility changes of up to one hour.
const maxRedeliveryDelaySeconds = 60 * 60;

const vercelRetryDirective = (
  action: QueueDeliveryAction
): Effect.Effect<RetryDirective | undefined> =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      Acknowledge: () => Effect.succeed({ acknowledge: true } as const),
      RetryAfter: ({ delay }) =>
        Effect.succeed({ afterSeconds: Duration.toSeconds(delay) }),
      RetryAt: ({ instant }) =>
        currentInstant.pipe(
          Effect.map((now) => ({
            afterSeconds: clamp(
              Math.ceil(
                (instant.epochMilliseconds - now.epochMilliseconds) / 1000
              ),
              1,
              maxRedeliveryDelaySeconds
            ),
          }))
        ),
      RetryDefault: () => Effect.undefined,
    })
  );

/**
 * The SDK prints rethrown handler errors outside log censorship. The consumer
 * logs the original cause, and only this error reaches the SDK.
 */
class QueueDeliveryFailure extends Data.TaggedError("QueueDeliveryFailure")<{
  readonly message: string;
  readonly reason: QueueDeliveryFailureReason;
  readonly directive: RetryDirective | undefined;
}> {}

const queueRetryDirective = (cause: unknown) =>
  cause instanceof QueueDeliveryFailure ? cause.directive : undefined;

export const defineVercelQueueRoute = (
  operation: string,
  consume: QueueConsumer<never>
) =>
  handleCallback(
    defineWorkspaceTask(operation, (payload, metadata: MessageMetadata) =>
      consume(
        {
          payload,
          topic: metadata.topicName,
          messageId: metadata.messageId,
          deliveryCount: metadata.deliveryCount,
        },
        queueDeliveryModeForStage(env.VERCEL_ENV)
      ).pipe(
        Effect.flatMap(
          Match.valueTags({
            Handled: () => Effect.void,
            Invalid: () => Effect.void,
            Failed: ({ reason, action }) =>
              vercelRetryDirective(action).pipe(
                Effect.flatMap((directive) =>
                  Effect.fail(
                    new QueueDeliveryFailure({
                      message: queueDeliveryFailureMessage(reason),
                      reason,
                      directive,
                    })
                  )
                )
              ),
          })
        )
      )
    ),
    { retry: queueRetryDirective }
  );
