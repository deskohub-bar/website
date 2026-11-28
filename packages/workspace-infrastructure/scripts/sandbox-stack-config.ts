import * as Effect from "effect/Effect";
import { withLogsOnStderr } from "../src/command-line";
import {
  decodeWorkspaceStackConfig,
  serializeWorkspaceStackConfig,
} from "../src/config/stack-config";

/** The approved identifiers of the disposable sandbox the proof runs in. */
export interface SandboxProofIdentity {
  readonly projectId: string;
  readonly projectNumber: string;
  readonly region: string;
  readonly stateBucket: string;
  /** The proof run's disposable queue ID suffix, once foundation ran. */
  readonly disposableQueueSuffix?: string;
}

/** The approved gross cap and teardown of the sandbox proof (#1452). */
export const sandboxProofBudget = {
  currency: "CZK",
  maximumSpend: 500,
  teardownAt: "2026-11-30T23:59:59Z",
} as const;

const serviceAccount = (projectId: string, name: string) =>
  [name, `${projectId}.iam.gserviceaccount.com`].join("@");

/**
 * The sandbox stack config input: the accounts the bootstrap script
 * creates, no secrets, single-instance capacity and paused schedules. The
 * services are IAM-private; nothing fronts them.
 */
export const sandboxProofStackConfigInput = (
  identity: SandboxProofIdentity
) => {
  const input = {
    stage: "sandbox",
    projectId: identity.projectId,
    projectNumber: identity.projectNumber,
    region: identity.region,
    stateBucket: identity.stateBucket,
    mobileUpdatesBucket: `${identity.projectId}-mobile-updates`,
    serviceAccounts: {
      deployer: serviceAccount(identity.projectId, "workspace-deployer"),
      apiRuntime: serviceAccount(identity.projectId, "workspace-api"),
      frontendInvoker: serviceAccount(
        identity.projectId,
        "workspace-frontend-preview"
      ),
      tasksWorkerRuntime: serviceAccount(
        identity.projectId,
        "workspace-tasks-worker"
      ),
      schedulerWorkerRuntime: serviceAccount(
        identity.projectId,
        "workspace-scheduler-worker"
      ),
      tasksInvoker: serviceAccount(
        identity.projectId,
        "workspace-tasks-invoker"
      ),
      schedulerInvoker: serviceAccount(
        identity.projectId,
        "workspace-scheduler-invoker"
      ),
      mobileUpdatesPublisher: serviceAccount(
        identity.projectId,
        "workspace-mobile-publisher"
      ),
    },
    secrets: [],
    capacity: {
      apiMaxInstances: 1,
      workerMaxInstances: 1,
      queueMaxConcurrentDispatches: 1,
      queueMaxDispatchesPerSecond: 1,
    },
    schedulesEnabled: false,
    alertNotificationChannels: [],
    budget: sandboxProofBudget,
  };
  return identity.disposableQueueSuffix === undefined
    ? input
    : { ...input, disposableQueueSuffix: identity.disposableQueueSuffix };
};

/** Build and decode the config with the package schema; returns its JSON. */
export const sandboxProofStackConfig = (identity: SandboxProofIdentity) =>
  decodeWorkspaceStackConfig(sandboxProofStackConfigInput(identity)).pipe(
    Effect.map(serializeWorkspaceStackConfig)
  );

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

if (import.meta.main) {
  const identity: SandboxProofIdentity = {
    projectId: required("SANDBOX_PROJECT_ID"),
    projectNumber: required("SANDBOX_PROJECT_NUMBER"),
    region: required("SANDBOX_REGION"),
    stateBucket: required("SANDBOX_STATE_BUCKET"),
    disposableQueueSuffix: process.env.SANDBOX_QUEUE_SUFFIX || undefined,
  };
  process.stdout.write(
    `${await Effect.runPromise(withLogsOnStderr(sandboxProofStackConfig(identity)))}\n`
  );
}
