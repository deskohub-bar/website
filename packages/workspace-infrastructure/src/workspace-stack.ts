import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import * as CloudScheduler from "@alchemy.run/gcp/CloudScheduler";
import * as CloudTasks from "@alchemy.run/gcp/CloudTasks";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Monitoring from "@alchemy.run/gcp/Monitoring";
import type { ServiceProps } from "@alchemy.run/gcp/Run";
import * as Run from "@alchemy.run/gcp/Run";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type {
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "./config/stack-config";
import { workspaceQueueContracts } from "./contracts/queue-contracts";
import { workspaceScheduleContracts } from "./contracts/schedule-contracts";
import {
  requireRecordCoversLiveService,
  requireRecordNamesApiRevisions,
} from "./release/live-release-services";
import { stackRunRecord } from "./release/release-delivery";
import { StaleReleaseGeneration } from "./release/release-reconciler";
import type { ReleaseRecord } from "./release/release-record";
import {
  PreviewServicesUnprotected,
  requireStackMode,
  requireStackWriter,
} from "./release/release-writer";
import {
  alertPolicyDeclarations,
  artifactRepositoryProps,
  mobileUpdatesApiReadGrant,
  mobileUpdatesBucketProps,
  mobileUpdatesPublisherGrant,
  mobileUpdatesPublisherReadGrant,
  secretAccessorGrants,
  serviceInvokerGrants,
} from "./resources/platform-declarations";
import { queueProps } from "./resources/queue-declarations";
import {
  sandboxProofScheduleJobs,
  scheduleJobProps,
} from "./resources/schedule-declarations";
import {
  apiServiceProps,
  workerServiceProps,
} from "./resources/service-declarations";

const pascal = (id: string) =>
  id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/**
 * Resources that hold no release state: images, mobile assets, queues,
 * alerts and, only where the stage authorizes them, schedules. An
 * unauthorized stage declares no Scheduler job at all, so no interrupted
 * create can leave one running.
 */
export const declareWorkspaceFoundation = Effect.fn(
  "WorkspaceStack.declareWorkspaceFoundation"
)(function* (config: WorkspaceStackConfig) {
  const repository = yield* ArtifactRegistry.Repository(
    "WorkspaceImages",
    artifactRepositoryProps(config)
  );
  const mobileUpdates = yield* Storage.Bucket(
    "MobileUpdates",
    mobileUpdatesBucketProps(config)
  );
  yield* Effect.forEach(
    [
      mobileUpdatesPublisherGrant(config),
      mobileUpdatesPublisherReadGrant(config),
      mobileUpdatesApiReadGrant(config),
    ],
    (grant) =>
      IAM.Member(grant.id, { ...grant.props, name: mobileUpdates.bucketName })
  );
  const queues = yield* Effect.forEach(workspaceQueueContracts, (contract) =>
    CloudTasks.Queue(
      `Queue${pascal(contract.queueId)}`,
      queueProps(config, contract)
    )
  );
  const jobs = config.schedulesEnabled
    ? yield* Effect.forEach(workspaceScheduleContracts, (contract) =>
        CloudScheduler.Job(
          `Schedule${pascal(contract.jobId)}`,
          scheduleJobProps(config, contract)
        )
      )
    : [];
  const proofJobs = yield* Effect.forEach(
    sandboxProofScheduleJobs(config),
    ({ id, props }) => CloudScheduler.Job(id, props)
  );
  yield* Effect.forEach(alertPolicyDeclarations(config), ({ id, props }) =>
    Monitoring.AlertPolicy(id, props)
  );
  return {
    repository: repository.name,
    mobileUpdatesBucket: mobileUpdates.bucketName,
    queues: queues.map((queue) => queue.name),
    jobs: [...jobs, ...proofJobs].map((job) => job.name),
  };
});

/**
 * Point each secret reference of a service at its accessor grant's output,
 * so Alchemy applies the grant before the revision that reads the secret.
 */
const withSecretGrants = (
  props: ServiceProps,
  workload: WorkspaceWorkload,
  grants: ReadonlyMap<string, IAM.Member>
) => ({
  ...props,
  template: {
    ...props.template,
    containers: (props.template?.containers ?? []).map((container) => ({
      ...container,
      env: ("env" in container ? (container.env ?? []) : []).map((env) => {
        const secret = env.valueSource?.secretKeyRef?.secret;
        const grant =
          secret === undefined
            ? undefined
            : grants.get(`${secret}|${workload}`);
        return grant === undefined ||
          env.valueSource?.secretKeyRef === undefined
          ? env
          : {
              ...env,
              valueSource: {
                secretKeyRef: {
                  ...env.valueSource.secretKeyRef,
                  secret: grant.name,
                },
              },
            };
      }),
    })),
  },
});

/**
 * The release-owned services. They derive from the authoritative release
 * record, so only a caller holding that record under its generation fence
 * may declare them; nothing is declared before a release serves. The API
 * service carries the record's traffic generation for drift readback.
 */
export const declareWorkspaceServices = Effect.fn(
  "WorkspaceStack.declareWorkspaceServices"
)(function* (
  config: WorkspaceStackConfig,
  record: ReleaseRecord,
  now: DateTime.Utc
) {
  if (config.stage === "preview") {
    return yield* new PreviewServicesUnprotected();
  }
  const api = apiServiceProps(config, record, now);
  const serving = record.pendingApply?.target ?? record.active;
  if (api === undefined || serving === null) {
    return undefined;
  }
  const grantDeclarations = secretAccessorGrants(config);
  const grants = new Map<string, IAM.Member>();
  for (const grant of grantDeclarations) {
    const member = yield* IAM.Member(grant.id, grant.props);
    grants.set(`${grant.props.name}|${grant.workload}`, member);
  }

  const apiService = yield* Run.Service(
    "WorkspaceApi",
    withSecretGrants(api, "api", grants)
  );
  const tasksWorker = yield* Run.Service(
    "WorkspaceTasksWorker",
    withSecretGrants(
      workerServiceProps(config, "tasks-worker", serving.imageDigest),
      "tasks-worker",
      grants
    )
  );
  const schedulerWorker = yield* Run.Service(
    "WorkspaceSchedulerWorker",
    withSecretGrants(
      workerServiceProps(config, "scheduler-worker", serving.imageDigest),
      "scheduler-worker",
      grants
    )
  );

  // Invoker grants name the declared services, so they follow them.
  const services = {
    api: apiService,
    "tasks-worker": tasksWorker,
    "scheduler-worker": schedulerWorker,
  } satisfies Record<WorkspaceWorkload, typeof apiService>;
  for (const grant of serviceInvokerGrants(config)) {
    yield* IAM.Member(grant.id, {
      ...grant.props,
      name: services[grant.workload].name,
    });
  }

  return {
    apiService: apiService.name,
    apiServiceId: apiService.serviceId,
    apiLatestReadyRevision: apiService.latestReadyRevision,
    tasksWorkerUri: tasksWorker.uri,
    schedulerWorkerUri: schedulerWorker.uri,
  };
});

/** How the stack was started: the writer token and the generation fence. */
export interface StackRun {
  readonly writer: Option.Option<Redacted.Redacted<string>>;
  /** Set only by a fenced release apply; null for a plain run. */
  readonly generation: number | null;
}

/**
 * The release-owned services as the authoritative release record declares
 * them now. Every deploy of a stage that serves a release must declare them,
 * or Alchemy would delete them. The run must hold the record's writer lock,
 * and the lock decides its mode: a fenced apply passes the generation it
 * persisted and refuses a record any other run has since moved on, while a
 * plain run declares the current record, and a plan the template decision
 * the following deploy would persist. A record without a serving release
 * is refused while a release-owned service is live (`ReleaseRecordLost`).
 * Preview declares none until #1455 and needs no lock.
 */
export const declareRecordedWorkspaceServices = Effect.fn(
  "WorkspaceStack.declareRecordedWorkspaceServices"
)(function* (config: WorkspaceStackConfig, run: StackRun) {
  const held = yield* requireStackWriter(config, run.writer);
  if (held === null) {
    return run.generation === null
      ? undefined
      : yield* new PreviewServicesUnprotected();
  }
  yield* requireStackMode(held, run.generation);
  const { record } = held;
  if (run.generation !== null && record.generation !== run.generation) {
    return yield* new StaleReleaseGeneration({
      expectedGeneration: run.generation,
      currentGeneration: record.generation,
    });
  }
  // A teardown removes every service, even one a pre-rename record names.
  if (held.lock.operation === "destroy") {
    return undefined;
  }
  // Declaring nothing from a lost record would delete the live services.
  yield* requireRecordCoversLiveService(record);
  // A record from before the API rename names revisions it cannot route to.
  yield* requireRecordNamesApiRevisions(record);
  // A plan previews the template decision its deploy would persist.
  const declared = yield* stackRunRecord(config, record, held.lock.operation);
  return yield* declareWorkspaceServices(config, declared, yield* DateTime.now);
});
