import type { QueueProps } from "@alchemy.run/gcp/CloudTasks";
import * as Duration from "effect/Duration";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  type QueueContract,
  workspaceQueueRetry,
} from "../contracts/queue-contracts";
import { workloadAudience, workloadHost } from "./workload-names";

/** Cloud Tasks and Cloud Scheduler take durations as `<seconds>s`. */
export const toGcpDuration = (duration: Duration.Duration) =>
  `${Math.round(Duration.toSeconds(duration))}s`;

/**
 * The Cloud Tasks queue ID of one contract: the contract's own ID, or in a
 * sandbox run with a disposable suffix, that ID plus the suffix.
 */
export const queueIdOf = (
  config: WorkspaceStackConfig,
  contract: QueueContract
) =>
  config.stage === "sandbox" && config.disposableQueueSuffix !== undefined
    ? `${contract.queueId}-${config.disposableQueueSuffix}`
    : contract.queueId;

/** The retry settings every queue shares, whatever its lifetime. */
const queueRetryConfig = {
  maxAttempts: -1,
  minBackoff: toGcpDuration(workspaceQueueRetry.minBackoff),
  maxBackoff: toGcpDuration(workspaceQueueRetry.maxBackoff),
  maxDoublings: workspaceQueueRetry.maxDoublings,
};

/**
 * Queue properties for one contract. `maxAttempts: -1` leaves the attempt
 * count unbounded so the contract's lifetime alone ends retries; the
 * provider-default lifetime omits `maxRetryDuration` entirely.
 *
 * The queue-level target always overrides each task's URL and OIDC
 * identity, so a publisher cannot send a task to another handler or
 * present another invoker.
 */
export const queueProps = (
  config: WorkspaceStackConfig,
  contract: QueueContract
): QueueProps => ({
  queueId: queueIdOf(config, contract),
  location: config.region,
  retryConfig:
    contract.transportLifetime.kind === "bounded"
      ? {
          ...queueRetryConfig,
          maxRetryDuration: toGcpDuration(
            contract.transportLifetime.maxRetryDuration
          ),
        }
      : queueRetryConfig,
  rateLimits: {
    maxConcurrentDispatches: config.capacity.queueMaxConcurrentDispatches,
    maxDispatchesPerSecond: config.capacity.queueMaxDispatchesPerSecond,
  },
  // Log attempts without payloads: task bodies hold customer identifiers.
  stackdriverLoggingConfig: { samplingRatio: 1 },
  httpTarget: {
    httpMethod: "POST",
    uriOverride: {
      scheme: "HTTPS",
      host: workloadHost(config, "tasks-worker"),
      port: "443",
      pathOverride: { path: contract.handlerPath },
      // An empty query clears whatever query a publisher sent.
      queryOverride: { queryParams: "" },
      uriOverrideEnforceMode: "ALWAYS",
    },
    oidcToken: {
      serviceAccountEmail: config.serviceAccounts.tasksInvoker,
      audience: workloadAudience(config, "tasks-worker"),
    },
  },
  state: "RUNNING",
});
