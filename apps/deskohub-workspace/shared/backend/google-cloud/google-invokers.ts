import "server-only";

import type { GoogleInvoker } from "@deskohub/google-oidc";
import { env } from "@/env";

const googleInvoker = (
  email: string | undefined,
  audience: string | undefined
): GoogleInvoker | undefined =>
  email && audience ? { email, audience } : undefined;

/** The invoker Cloud Tasks queues deliver as, when both settings are set. */
export const cloudTasksInvoker = () =>
  googleInvoker(
    env.WORKSPACE_TASKS_INVOKER_EMAIL,
    env.WORKSPACE_TASKS_AUDIENCE
  );

/** The invoker Cloud Scheduler jobs call as, when both settings are set. */
export const cloudSchedulerInvoker = () =>
  googleInvoker(
    env.WORKSPACE_SCHEDULER_INVOKER_EMAIL,
    env.WORKSPACE_SCHEDULER_AUDIENCE
  );
