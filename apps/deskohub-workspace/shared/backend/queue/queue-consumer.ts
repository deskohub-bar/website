import { decodeStandardSchema } from "@deskohub/standard-schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Cause, Data, Duration, Effect, Match } from "effect";
import { isDatabaseUnavailable } from "@/db/database-unavailable";
import { censorLogValue } from "@/shared/backend/logging/censorship";
import type { DeploymentStage } from "@/shared/deployment/deployment-stage";

/** How a consumer wants the queue to treat one of its failures. */
export type QueueRedelivery = Data.TaggedEnum<{
  /** The message can never succeed: acknowledge it. */
  Never: Record<never, never>;
  /** A transient failure: redeliver with exponential backoff. */
  WithBackoff: Record<never, never>;
  /** The work becomes due at a known instant: redeliver then. */
  At: { readonly instant: Temporal.Instant };
  /** Unclassified: the configured retry delay applies. */
  Default: Record<never, never>;
}>;

export const QueueRedelivery = Data.taggedEnum<QueueRedelivery>();

export type QueueDeliveryMode = "preview" | "durable";

/**
 * The delivery mode for a deployment stage, whatever transport delivers:
 * preview deployments run on synthetic, disposable data.
 */
export const queueDeliveryModeForStage = (
  stage: DeploymentStage
): QueueDeliveryMode => (stage === "preview" ? "preview" : "durable");

export interface QueueDelivery {
  readonly payload: unknown;
  readonly topic: string;
  readonly messageId: string;
  readonly deliveryCount: number;
}

/** Preview messages are synthetic and pinned to their deployment. */
export const previewQueueDeliveryLimit = 5;

const backoffBaseSeconds = 60;
const backoffMaxSeconds = 15 * 60;

export type QueueDeliveryFailureReason =
  | "preview_database_unavailable"
  | "preview_delivery_limit"
  | "database_unavailable"
  | "permanent_failure"
  | "transient_failure"
  | "scheduled"
  | "unclassified";

export type QueueDeliveryAction = Data.TaggedEnum<{
  Acknowledge: Record<never, never>;
  RetryAfter: { readonly delay: Duration.Duration };
  RetryAt: { readonly instant: Temporal.Instant };
  RetryDefault: Record<never, never>;
}>;

const QueueDeliveryAction = Data.taggedEnum<QueueDeliveryAction>();

interface QueueRedeliveryDecision {
  readonly reason: QueueDeliveryFailureReason;
  readonly action: QueueDeliveryAction;
}

export type QueueDeliveryOutcome = Data.TaggedEnum<{
  Handled: Record<never, never>;
  Invalid: Record<never, never>;
  Failed: QueueRedeliveryDecision;
}>;

const QueueDeliveryOutcome = Data.taggedEnum<QueueDeliveryOutcome>();

export type QueueConsumer<R> = (
  delivery: QueueDelivery,
  mode: QueueDeliveryMode
) => Effect.Effect<QueueDeliveryOutcome, never, R>;

const backoff = (deliveryCount: number) =>
  Duration.seconds(
    Math.min(
      backoffBaseSeconds * 2 ** (Math.max(deliveryCount, 1) - 1),
      backoffMaxSeconds
    )
  );

// Defects, interruptions, and concurrent failures keep the default redelivery.
const classifyFailure = <E>(
  cause: Cause.Cause<E>,
  redelivery: (error: E) => QueueRedelivery
): QueueRedelivery => {
  const [reason, ...others] = cause.reasons;
  return reason && others.length === 0 && Cause.isFailReason(reason)
    ? redelivery(reason.error)
    : QueueRedelivery.Default();
};

export const decideQueueRedelivery = <E>(input: {
  readonly cause: Cause.Cause<E>;
  readonly redelivery: (error: E) => QueueRedelivery;
  readonly deliveryCount: number;
  readonly mode: QueueDeliveryMode;
}): QueueRedeliveryDecision => {
  const databaseUnavailable = isDatabaseUnavailable(input.cause);
  if (input.mode === "preview") {
    if (databaseUnavailable) {
      return {
        reason: "preview_database_unavailable",
        action: QueueDeliveryAction.Acknowledge(),
      };
    }
    if (input.deliveryCount >= previewQueueDeliveryLimit) {
      return {
        reason: "preview_delivery_limit",
        action: QueueDeliveryAction.Acknowledge(),
      };
    }
  } else if (databaseUnavailable) {
    return {
      reason: "database_unavailable",
      action: QueueDeliveryAction.RetryAfter({
        delay: backoff(input.deliveryCount),
      }),
    };
  }

  return Match.value(classifyFailure(input.cause, input.redelivery)).pipe(
    Match.tagsExhaustive({
      Never: (): QueueRedeliveryDecision => ({
        reason: "permanent_failure",
        action: QueueDeliveryAction.Acknowledge(),
      }),
      WithBackoff: (): QueueRedeliveryDecision => ({
        reason: "transient_failure",
        action: QueueDeliveryAction.RetryAfter({
          delay: backoff(input.deliveryCount),
        }),
      }),
      At: ({ instant }): QueueRedeliveryDecision => ({
        reason: "scheduled",
        action: QueueDeliveryAction.RetryAt({ instant }),
      }),
      Default: (): QueueRedeliveryDecision => ({
        reason: "unclassified",
        action: QueueDeliveryAction.RetryDefault(),
      }),
    })
  );
};

const redeliveryLogs = {
  preview_database_unavailable: {
    level: "Warn",
    message: "Queue message acknowledged: the Preview database is unavailable",
  },
  preview_delivery_limit: {
    level: "Warn",
    message: "Queue message abandoned at the Preview delivery limit",
  },
  database_unavailable: {
    level: "Error",
    message: "Queue message redelivery backed off: database unavailable",
  },
  permanent_failure: {
    level: "Warn",
    message: "Queue message acknowledged after a permanent failure",
  },
  transient_failure: {
    level: "Warn",
    message: "Queue message redelivery backed off after a transient failure",
  },
  scheduled: {
    level: "Info",
    message: "Queue message redelivery scheduled",
  },
  unclassified: {
    level: "Error",
    message: "Queue message failed; the queue redelivers it",
  },
} as const satisfies Record<
  QueueDeliveryFailureReason,
  { readonly level: "Info" | "Warn" | "Error"; readonly message: string }
>;

export const queueDeliveryFailureMessage = (
  reason: QueueDeliveryFailureReason
) => redeliveryLogs[reason].message;

export const defineQueueConsumer =
  <Message, E, R>(input: {
    readonly schema: StandardSchemaV1<unknown, Message>;
    readonly label: string;
    readonly handle: (message: Message) => Effect.Effect<unknown, E, R>;
    readonly redelivery: (error: E) => QueueRedelivery;
  }): QueueConsumer<R> =>
  ({ payload, topic, messageId, deliveryCount }, mode) =>
    // Decode and construct the handler inside the Effect so defects here
    // receive the same treatment as defects while running the handler.
    Effect.suspend((): Effect.Effect<QueueDeliveryOutcome, E, R> => {
      const message = decodeStandardSchema(input.schema, payload);
      return message === undefined
        ? Effect.logWarning(
            `${input.label} queue message ignored: invalid payload`
          ).pipe(Effect.as(QueueDeliveryOutcome.Invalid()))
        : input.handle(message).pipe(Effect.as(QueueDeliveryOutcome.Handled()));
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(
            Cause.fromReasons<never>(
              cause.reasons.filter(Cause.isInterruptReason)
            )
          );
        }

        const decision = decideQueueRedelivery({
          cause,
          redelivery: input.redelivery,
          deliveryCount,
          mode,
        });
        const log = redeliveryLogs[decision.reason];
        const censoredCause = censorLogValue(cause);
        return Effect.logWithLevel(log.level)(log.message, {
          ...decision,
          // Log data rather than a new Effect cause. A censoring logger
          // otherwise censors its already-sanitized defect a second time.
          cause: Cause.isCause(censoredCause)
            ? censoredCause.toJSON()
            : censoredCause,
        }).pipe(Effect.as(QueueDeliveryOutcome.Failed(decision)));
      }),
      Effect.annotateLogs({
        queueTopic: topic,
        queueMessageId: messageId,
        deliveryCount,
      })
    );
