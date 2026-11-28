import * as Duration from "effect/Duration";

/** Every schedule runs in UTC, as the Vercel crons it replaces do. */
export const workspaceScheduleTimeZone = "Etc/UTC";

export interface ScheduleContract {
  /** Cloud Scheduler job ID. */
  readonly jobId: string;
  /** App Router handler on the private scheduler worker. */
  readonly handlerPath: string;
  /** Unix cron expression, evaluated in UTC. */
  readonly schedule: string;
  /** The route budget; Cloud Scheduler's attempt deadline. */
  readonly attemptDeadline: Duration.Duration;
}

/** The ten recurring jobs (#1456, Current cron table). */
export const workspaceScheduleContracts: ReadonlyArray<ScheduleContract> = [
  {
    jobId: "workspace-reservation-holds",
    handlerPath: "/api/cron/workspace/reservation-holds",
    schedule: "0 0 * * *",
    attemptDeadline: Duration.seconds(300),
  },
  {
    jobId: "workspace-auth-cleanup",
    handlerPath: "/api/cron/workspace/auth-cleanup",
    schedule: "17 3 * * *",
    attemptDeadline: Duration.seconds(300),
  },
  {
    jobId: "workspace-reservation-invitees",
    handlerPath: "/api/cron/workspace/reservation-invitees",
    schedule: "47 * * * *",
    attemptDeadline: Duration.seconds(60),
  },
  {
    jobId: "workspace-reservation-invitee-notices",
    handlerPath: "/api/cron/workspace/reservation-invitee-notices",
    schedule: "* * * * *",
    attemptDeadline: Duration.seconds(60),
  },
  {
    jobId: "workspace-payment-refunds",
    handlerPath: "/api/cron/workspace/payment-refunds",
    schedule: "30 * * * *",
    attemptDeadline: Duration.seconds(300),
  },
  {
    jobId: "workspace-paid-fulfillment",
    handlerPath: "/api/cron/workspace/paid-fulfillment",
    schedule: "57 5 * * *",
    attemptDeadline: Duration.seconds(300),
  },
  {
    jobId: "workspace-pass-purchases",
    handlerPath: "/api/cron/workspace/pass-purchases",
    schedule: "*/10 * * * *",
    attemptDeadline: Duration.seconds(300),
  },
  {
    jobId: "workspace-email-automations",
    handlerPath: "/api/cron/workspace/email-automations",
    schedule: "*/15 * * * *",
    attemptDeadline: Duration.seconds(300),
  },
  {
    jobId: "workspace-posthog-email-deliveries",
    handlerPath: "/api/cron/workspace/posthog-email-deliveries",
    schedule: "*/15 * * * *",
    attemptDeadline: Duration.seconds(300),
  },
  {
    jobId: "workspace-contract-withdrawals",
    handlerPath: "/api/cron/workspace/contract-withdrawals",
    schedule: "*/10 * * * *",
    attemptDeadline: Duration.seconds(300),
  },
];
