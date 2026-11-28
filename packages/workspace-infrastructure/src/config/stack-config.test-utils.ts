import * as Effect from "effect/Effect";
import {
  decodeWorkspaceStackConfig,
  type WorkspaceStackConfig,
} from "./stack-config";

const projectId = "deskohub-ws-sandbox";

/** A service account identifier in the synthetic project, not a mailbox. */
export const sandboxServiceAccount = (name: string, project = projectId) =>
  `${name}@${project}.iam.gserviceaccount.com`;

/** A synthetic sandbox configuration: identifiers only, no real project. */
export const sandboxConfigInput = {
  stage: "sandbox",
  projectId,
  projectNumber: "123456789012",
  stateBucket: "deskohub-ws-sandbox-workspace-state",
  mobileUpdatesBucket: "deskohub-ws-sandbox-mobile-updates",
  serviceAccounts: {
    deployer: sandboxServiceAccount("workspace-deployer"),
    apiRuntime: sandboxServiceAccount("workspace-api"),
    frontendInvoker: sandboxServiceAccount("workspace-frontend-preview"),
    tasksWorkerRuntime: sandboxServiceAccount("workspace-tasks-worker"),
    schedulerWorkerRuntime: sandboxServiceAccount("workspace-scheduler-worker"),
    tasksInvoker: sandboxServiceAccount("workspace-tasks-invoker"),
    schedulerInvoker: sandboxServiceAccount("workspace-scheduler-invoker"),
    mobileUpdatesPublisher: sandboxServiceAccount("workspace-mobile-publisher"),
  },
  secrets: [
    {
      consumers: ["api", "tasks-worker"],
      environmentVariable: "DATABASE_URL",
      secretId: "workspace-database-url",
      version: "3",
    },
  ],
  capacity: {
    apiMaxInstances: 2,
    workerMaxInstances: 1,
    queueMaxConcurrentDispatches: 2,
    queueMaxDispatchesPerSecond: 1,
  },
  schedulesEnabled: false,
  alertNotificationChannels: [],
  budget: {
    currency: "EUR",
    maximumSpend: 200,
    teardownAt: "2026-12-31T00:00:00Z",
  },
} as const;

export const sandboxConfig: WorkspaceStackConfig = Effect.runSync(
  decodeWorkspaceStackConfig(sandboxConfigInput)
);

const { budget: _budget, ...sharedInput } = sandboxConfigInput;

/** The same synthetic identifiers as a production stage. */
export const productionConfig: WorkspaceStackConfig = Effect.runSync(
  decodeWorkspaceStackConfig({ ...sharedInput, stage: "production" })
);

/** The same synthetic identifiers as a preview stage. */
export const previewConfig: WorkspaceStackConfig = Effect.runSync(
  decodeWorkspaceStackConfig({ ...sharedInput, stage: "preview" })
);

/**
 * The sandbox input moved to another project: its state bucket and every
 * service account follow the project.
 */
export const sandboxConfigInputIn = (project: string) => ({
  ...sandboxConfigInput,
  projectId: project,
  stateBucket: `${project}-workspace-state`,
  serviceAccounts: Object.fromEntries(
    Object.entries(sandboxConfigInput.serviceAccounts).map(
      ([role, account]) => [
        role,
        sandboxServiceAccount(account.slice(0, account.indexOf("@")), project),
      ]
    )
  ),
});

/** The hosted proof's stack, in the approved sandbox project. */
export const hostedProofConfig: WorkspaceStackConfig = Effect.runSync(
  decodeWorkspaceStackConfig(sandboxConfigInputIn("deskohub-workspace-sandbox"))
);
