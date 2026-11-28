import { env } from "@/env";
import { defineCloudTasksQueueRoute } from "./cloud-tasks-queue-consumer";
import type { QueueConsumer } from "./queue-consumer";
import { defineVercelQueueRoute } from "./vercel-queue-consumer";
import type { WorkspaceQueueTopic } from "./workspace-queue-topics";

type QueueRouteHandler = (request: Request) => Promise<Response>;

/**
 * A queue handler route for whichever transport delivers on this host: Vercel
 * Queues on Vercel, the default, and Cloud Tasks on a container host. Both
 * run the same `consume` for `topic`. Each transport's handler is built on
 * its host's first request, so a container never constructs a Vercel queue
 * client.
 */
export const defineQueueRoute = (
  operation: string,
  topic: WorkspaceQueueTopic,
  consume: QueueConsumer<never>
) => {
  let vercel: QueueRouteHandler | undefined;
  let cloudTasks: QueueRouteHandler | undefined;
  return (request: Request): Promise<Response> => {
    if (env.WORKSPACE_RUNTIME_HOST === "container") {
      cloudTasks ??= defineCloudTasksQueueRoute(operation, topic, consume);
      return cloudTasks(request);
    }
    vercel ??= defineVercelQueueRoute(operation, consume);
    return vercel(request);
  };
};
