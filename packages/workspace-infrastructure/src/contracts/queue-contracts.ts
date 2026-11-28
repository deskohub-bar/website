import * as Duration from "effect/Duration";

/**
 * Cloud Tasks platform bounds that every queue contract must respect
 * (#1456, Delivery and cutover contract).
 */
export const cloudTasksLimits = {
  scheduleHorizon: Duration.days(30),
  taskRetention: Duration.days(31),
  httpAttemptDeadline: Duration.minutes(30),
  taskNameDeduplication: Duration.hours(24),
} as const;

/** Shared retry policy (#1456): 60 s transient retry, backoff capped at 15 min. */
export const workspaceQueueRetry = {
  minBackoff: Duration.seconds(60),
  maxBackoff: Duration.minutes(15),
  maxDoublings: 4,
  /** A due-time deferral never schedules more than one hour ahead per step. */
  dueTimeDeferralStep: Duration.hours(1),
} as const;

/**
 * How long a task may keep retrying. `provider-default` keeps the queue's
 * Cloud Tasks default (31-day retention) until the effective provider
 * retention is read back and a business expiry is approved.
 */
export type QueueTransportLifetime =
  | { readonly kind: "bounded"; readonly maxRetryDuration: Duration.Duration }
  | { readonly kind: "provider-default" };

export interface QueueContract {
  /** The Vercel queue topic this queue replaces. */
  readonly topic: string;
  /** Cloud Tasks queue ID. */
  readonly queueId: string;
  /** App Router handler on the private tasks worker. */
  readonly handlerPath: string;
  readonly transportLifetime: QueueTransportLifetime;
  /** Longest delay a producer may schedule for the first attempt. */
  readonly maxScheduleDelay: Duration.Duration;
  /** The handler's processing budget; also the task dispatch deadline. */
  readonly dispatchDeadline: Duration.Duration;
  /** What the task carries; recovery relies on these keys, not payloads. */
  readonly deliveryKey: string;
  /**
   * A cap on total lifetime from enqueue that the queue cannot express:
   * Cloud Tasks counts `maxRetryDuration` from the first attempt.
   */
  readonly absoluteExpiry?: Duration.Duration;
  /**
   * What must hold before any producer publishes this topic to Cloud
   * Tasks. The queue may exist earlier; it stays without producers.
   */
  readonly activationGate?: string;
}

const bounded = (maxRetryDuration: Duration.Duration) =>
  ({ kind: "bounded", maxRetryDuration }) as const;

/** The six directed-work queues (#1456, Current queue table). */
export const workspaceQueueContracts: ReadonlyArray<QueueContract> = [
  {
    topic: "workspace-email-campaign-send",
    queueId: "workspace-email-campaign-send",
    handlerPath: "/api/queues/workspace/email-campaign-send",
    // 48 h transport lifetime; the 23 h replay window inside the provider's
    // 24 h idempotency window is enforced by the handler.
    transportLifetime: bounded(Duration.hours(48)),
    maxScheduleDelay: Duration.zero,
    dispatchDeadline: Duration.seconds(300),
    deliveryKey: "sendId + delivery attempt",
  },
  {
    topic: "workspace-email-automation-unit",
    queueId: "workspace-email-automation-unit",
    handlerPath: "/api/queues/workspace/email-automation-unit",
    transportLifetime: { kind: "provider-default" },
    activationGate:
      "Read the effective Vercel retention for this topic and approve a business expiry before any producer publishes to the Cloud Tasks queue.",
    maxScheduleDelay: Duration.zero,
    dispatchDeadline: Duration.seconds(300),
    deliveryKey: "work unit ID + enqueue generation",
  },
  {
    topic: "workspace-fio-account-poll",
    queueId: "workspace-fio-account-poll",
    handlerPath: "/api/queues/workspace/fio-account-poll",
    transportLifetime: bounded(Duration.hours(24)),
    // The 20-minute poll gate schedules the next wake.
    maxScheduleDelay: Duration.minutes(20),
    dispatchDeadline: Duration.seconds(60),
    deliveryKey: "wake event + deliveryId",
  },
  {
    topic: "workspace-late-payment-recovery",
    queueId: "workspace-late-payment-recovery",
    handlerPath: "/api/queues/workspace/late-payment-recovery",
    transportLifetime: bounded(Duration.days(7)),
    maxScheduleDelay: Duration.zero,
    dispatchDeadline: Duration.seconds(300),
    deliveryKey: "payment attempt ID",
  },
  {
    topic: "workspace-paid-fulfillment",
    queueId: "workspace-paid-fulfillment",
    handlerPath: "/api/queues/workspace/paid-fulfillment",
    transportLifetime: bounded(Duration.hours(24)),
    maxScheduleDelay: Duration.zero,
    dispatchDeadline: Duration.seconds(300),
    deliveryKey: "order ID (or order + replaced invoice)",
  },
  {
    topic: "workspace-reservation-hold-cleanup",
    queueId: "workspace-reservation-hold-cleanup",
    handlerPath: "/api/queues/workspace/reservation-hold-cleanup",
    // Retries for one hour after the hold's expiry, as the existing
    // retention clamp does (delay + 1 h, at most seven days).
    transportLifetime: bounded(Duration.hours(1)),
    maxScheduleDelay: Duration.days(7),
    dispatchDeadline: Duration.seconds(300),
    deliveryKey: "order ID + exact hold expiry",
    // The Vercel publisher clamps retention to min(delay + 1 h, 7 days)
    // from enqueue. Cloud Tasks cannot, and today's handler does not check it.
    absoluteExpiry: Duration.days(7),
    activationGate:
      "The hold-cleanup payload carries its clamped deadline from enqueue and the handler acknowledges without cleanup after it (apps/deskohub-workspace/features/checkout/backend/holds/reservation-hold-cleanup-queue.service.ts).",
  },
];
