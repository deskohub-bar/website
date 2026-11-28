import type { JobProps } from "@alchemy.run/gcp/CloudScheduler";
import * as Duration from "effect/Duration";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  type ScheduleContract,
  workspaceScheduleTimeZone,
} from "../contracts/schedule-contracts";
import { toGcpDuration } from "./queue-declarations";
import { workloadAudience, workloadUrl } from "./workload-names";

/**
 * A Cloud Scheduler job calling the private scheduler worker with an OIDC
 * token for the scheduler invoker. Only stages authorized to run schedules
 * declare jobs at all (#1456, `declareWorkspaceFoundation`).
 */
export const scheduleJobProps = (
  config: WorkspaceStackConfig,
  contract: ScheduleContract
): JobProps => ({
  jobId: contract.jobId,
  location: config.region,
  schedule: contract.schedule,
  timeZone: workspaceScheduleTimeZone,
  attemptDeadline: toGcpDuration(contract.attemptDeadline),
  // The next tick is the retry; a missed tick is caught by the sweep.
  retryConfig: { retryCount: 0 },
  httpTarget: {
    uri: `${workloadUrl(config, "scheduler-worker")}${contract.handlerPath}`,
    httpMethod: "GET",
    oidcToken: {
      serviceAccountEmail: config.serviceAccounts.schedulerInvoker,
      audience: workloadAudience(config, "scheduler-worker"),
    },
  },
  paused: false,
});

/**
 * The hosted proof's own scheduler job (sandbox only, once the run has a
 * disposable suffix). The probe briefly resumes it for a manual run and
 * restores it to paused. The runner keeps the probe outside the annual
 * UTC tick, and the job calls a proof-only path.
 */
export const sandboxProofScheduleJobs = (
  config: WorkspaceStackConfig
): ReadonlyArray<{ readonly id: string; readonly props: JobProps }> =>
  config.stage === "sandbox" && config.disposableQueueSuffix !== undefined
    ? [
        {
          id: "ScheduleWorkspaceProofTick",
          props: {
            ...scheduleJobProps(config, {
              jobId: `workspace-proof-tick-${config.disposableQueueSuffix}`,
              handlerPath: "/api/cron/workspace/proof-tick",
              schedule: "0 0 1 1 *",
              attemptDeadline: Duration.seconds(60),
            }),
            paused: true,
          },
        },
      ]
    : [];
