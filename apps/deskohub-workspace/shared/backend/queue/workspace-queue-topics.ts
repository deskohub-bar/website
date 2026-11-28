/**
 * The Workspace queue topics and the worker route that consumes each one.
 * A Cloud Tasks queue carries its topic's name as its queue ID.
 */
export const workspaceQueueTopics = {
  "workspace-email-campaign-send": "/api/queues/workspace/email-campaign-send",
  "workspace-email-automation-unit":
    "/api/queues/workspace/email-automation-unit",
  "workspace-fio-account-poll": "/api/queues/workspace/fio-account-poll",
  "workspace-late-payment-recovery":
    "/api/queues/workspace/late-payment-recovery",
  "workspace-paid-fulfillment": "/api/queues/workspace/paid-fulfillment",
  "workspace-reservation-hold-cleanup":
    "/api/queues/workspace/reservation-hold-cleanup",
} as const satisfies Record<string, `/api/queues/workspace/${string}`>;

export type WorkspaceQueueTopic = keyof typeof workspaceQueueTopics;

export const isWorkspaceQueueTopic = (
  topic: string
): topic is WorkspaceQueueTopic => Object.hasOwn(workspaceQueueTopics, topic);
