import { describe, expect, test } from "bun:test";
import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import * as CloudScheduler from "@alchemy.run/gcp/CloudScheduler";
import * as CloudTasks from "@alchemy.run/gcp/CloudTasks";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Monitoring from "@alchemy.run/gcp/Monitoring";
import * as Run from "@alchemy.run/gcp/Run";
import * as Storage from "@alchemy.run/gcp/Storage";
import { isOutput } from "alchemy/Output";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import packageJson from "../package.json";
import {
  decodeWorkspaceStackConfig,
  ImageDigest,
  type WorkspaceStackConfig,
} from "./config/stack-config";
import {
  previewConfig,
  productionConfig,
  sandboxConfig,
  sandboxConfigInput,
} from "./config/stack-config.test-utils";
import { workspaceQueueContracts } from "./contracts/queue-contracts";
import { workspaceScheduleContracts } from "./contracts/schedule-contracts";
import { ReleaseServiceReadback } from "./release/release-platform";
import { workersServing } from "./release/release-readback.test-utils";
import { promote, settleApply, stage } from "./release/release-reconciler";
import {
  emptyReleaseRecord,
  GitSha,
  type ReleaseRecord,
} from "./release/release-record";
import {
  makeInMemoryReleaseRecordStore,
  ReleaseRecordStore,
} from "./release/release-record-store";
import { requireStackWriter } from "./release/release-writer";
import {
  heldBy,
  runAsHolder,
  testWriterToken,
} from "./release/release-writer.test-utils";
import {
  alertPolicyDeclarations,
  artifactRepositoryProps,
  mobileUpdatesBucketProps,
  mobileUpdatesPublisherGrant,
  secretAccessorGrants,
  serviceInvokerGrants,
} from "./resources/platform-declarations";
import { queueProps } from "./resources/queue-declarations";
import { scheduleJobProps } from "./resources/schedule-declarations";
import {
  apiServiceProps,
  apiTemplateSpecFingerprint,
  templateSpecAnnotation,
  workerServiceProps,
} from "./resources/service-declarations";
import { workloadUrl } from "./resources/workload-names";
import { evaluate } from "./stack-evaluation.test-utils";
import { workspaceSurfaceClassification } from "./surface-classification";
import {
  declareRecordedWorkspaceServices,
  declareWorkspaceFoundation,
  declareWorkspaceServices,
} from "./workspace-stack";

const countBy = (values: ReadonlyArray<string>) => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const installedVersion = async (name: string) =>
  (
    await Bun.file(
      new URL(`../node_modules/${name}/package.json`, import.meta.url)
    ).json()
  ).version;

const now = DateTime.makeUnsafe("2026-11-22T10:00:00Z");
const digest = ImageDigest.make(`sha256:${"1".repeat(64)}`);

/** A record whose first release is serving. */
const servingRecord = () => {
  const staged = Effect.runSync(
    stage(emptyReleaseRecord, {
      expectedGeneration: 0,
      sha: GitSha.make("a".repeat(40)),
      imageDigest: digest,
      origin: "cloud-run",
      liveTemplate: null,
      now,
    })
  );
  const pending = Effect.runSync(
    promote(staged.record, {
      expectedGeneration: 1,
      releaseId: staged.releaseId,
      now,
      candidateReadback: null,
    })
  );
  return Effect.runSync(
    settleApply(pending, {
      expectedGeneration: 2,
      readback: {
        servingRevision: "workspace-api-r1-aaaaaaa",
        servingImageDigest: digest,
        trafficGeneration: 1,
      },
      workers: workersServing(digest),
      now,
    })
  );
};

/** A readback for declarations that must not consult the live services. */
const unconsultedReadback = ReleaseServiceReadback.of({
  service: () => Effect.die(new Error("the declaration read a live service")),
  revision: () => Effect.die(new Error("the declaration read a live revision")),
});

describe("Alchemy beta.87 surface", () => {
  test("pins exact versions and installs exactly them", async () => {
    expect(packageJson.dependencies).toEqual({
      "@alchemy.run/gcp": "2.0.0-beta.87",
      "@deskohub/workspace-cloud-run": "workspace:*",
      "@deskohub/workspace-rpc": "workspace:*",
      "@effect/platform-bun": "4.1.4",
      "@effect/platform-node": "4.1.4",
      alchemy: "2.0.0-beta.87",
      effect: "4.1.4",
    });
    expect(await installedVersion("@alchemy.run/gcp")).toBe("2.0.0-beta.87");
    expect(await installedVersion("alchemy")).toBe("2.0.0-beta.87");
    expect(await installedVersion("effect")).toBe("4.1.4");
  });

  test("names only resource types the stack's providers define", () => {
    const constructors = new Map<string, { readonly Type: string }>(
      Object.entries({
        "GCP.ArtifactRegistry.Repository": ArtifactRegistry.Repository,
        "GCP.CloudScheduler.Job": CloudScheduler.Job,
        "GCP.CloudTasks.Queue": CloudTasks.Queue,
        "GCP.IAM.Member": IAM.Member,
        "GCP.Monitoring.AlertPolicy": Monitoring.AlertPolicy,
        "GCP.Storage.Bucket": Storage.Bucket,
      })
    );
    const alchemyOwned = workspaceSurfaceClassification.flatMap((item) =>
      item.owner.kind === "alchemy" ? [item.owner.resourceType] : []
    );
    for (const resourceType of alchemyOwned) {
      if (resourceType === "GCP.Run.Service") {
        expect(Run.Service).toBeFunction();
        continue;
      }
      expect(constructors.get(resourceType)?.Type).toBe(resourceType);
    }
    // No load balancer, CDN, Cloud Armor or log exclusion fronts the
    // IAM-private services, and nothing is owned by Terraform.
    expect(
      alchemyOwned.filter((type) => /^GCP\.(Compute|Logging)\./.test(type))
    ).toEqual([]);
    expect(
      new Set(workspaceSurfaceClassification.map((item) => item.owner.kind))
    ).toEqual(
      new Set(["alchemy", "owner-bootstrap", "release-flow", "deferred"])
    );
  });

  test("registers every foundation resource under a distinct logical ID", async () => {
    const enabled = await evaluate(
      declareWorkspaceFoundation({ ...sandboxConfig, schedulesEnabled: true })
    );
    expect(enabled.exit._tag).toBe("Success");
    const types = Object.values(enabled.resources).map((entry) => entry.Type);
    expect(countBy(types)).toEqual({
      "GCP.ArtifactRegistry.Repository": 1,
      "GCP.Storage.Bucket": 1,
      "GCP.IAM.Member": 3,
      "GCP.CloudTasks.Queue": 6,
      "GCP.CloudScheduler.Job": 10,
      "GCP.Monitoring.AlertPolicy": 3,
    });
    // The publisher and API reader grants name the declared bucket's output.
    for (const id of [
      "MobileUpdatesPublisher",
      "MobileUpdatesPublisherRead",
      "MobileUpdatesApiRead",
    ]) {
      expect(isOutput(enabled.resources[id]?.Props.name)).toBe(true);
    }
    expect(enabled.resources.MobileUpdatesPublisherRead?.Props.role).toBe(
      "roles/storage.legacyObjectReader"
    );
    expect(enabled.resources.MobileUpdatesApiRead?.Props).toMatchObject({
      role: "roles/storage.objectViewer",
      member: `serviceAccount:${sandboxConfig.serviceAccounts.apiRuntime}`,
    });
  });

  test("declares no Scheduler job where schedules are not authorized", async () => {
    const disabled = await evaluate(declareWorkspaceFoundation(sandboxConfig));
    expect(disabled.exit._tag).toBe("Success");
    expect(
      Object.values(disabled.resources).filter(
        (entry) => entry.Type === "GCP.CloudScheduler.Job"
      )
    ).toEqual([]);
  });

  test("declares the paused proof tick job only for a run-suffixed sandbox", async () => {
    const proofRun = await evaluate(
      declareWorkspaceFoundation(
        Effect.runSync(
          decodeWorkspaceStackConfig({
            ...sandboxConfigInput,
            disposableQueueSuffix: "r42-1",
          })
        )
      )
    );
    expect(proofRun.exit._tag).toBe("Success");
    const jobs = Object.values(proofRun.resources).filter(
      (entry) => entry.Type === "GCP.CloudScheduler.Job"
    );
    const schedulerUrl = workloadUrl(sandboxConfig, "scheduler-worker");
    expect(jobs.map((job) => job.Props)).toEqual([
      expect.objectContaining({
        jobId: "workspace-proof-tick-r42-1",
        paused: true,
        httpTarget: expect.objectContaining({
          uri: `${schedulerUrl}/api/cron/workspace/proof-tick`,
          oidcToken: {
            serviceAccountEmail: sandboxConfig.serviceAccounts.schedulerInvoker,
            audience: schedulerUrl,
          },
        }),
      }),
    ]);
    const production = await evaluate(
      declareWorkspaceFoundation(productionConfig)
    );
    expect(
      Object.values(production.resources).some(
        (entry) => entry.Props.jobId?.startsWith("workspace-proof-") === true
      )
    ).toBe(false);
  });

  test("fails closed for preview services until IAP exists", async () => {
    const preview = await evaluate(
      declareWorkspaceServices(previewConfig, servingRecord(), now)
    );
    expect(preview.exit._tag).toBe("Failure");
    expect(preview.resources).toEqual({});
  });

  test("orders service grants by output references", async () => {
    const initial = await evaluate(
      declareWorkspaceServices(sandboxConfig, emptyReleaseRecord, now)
    );
    expect(initial.exit._tag).toBe("Success");
    expect(initial.resources).toEqual({});

    const served = await evaluate(
      Effect.gen(function* () {
        yield* declareWorkspaceFoundation(sandboxConfig);
        return yield* declareWorkspaceServices(
          sandboxConfig,
          servingRecord(),
          now
        );
      })
    );
    expect(served.exit._tag).toBe("Success");
    const { resources } = served;
    expect(
      countBy(Object.values(resources).map((entry) => entry.Type))
    ).toMatchObject({
      "GCP.Run.Service": 3,
      // Three foundation grants, four invokers and two secret accessors.
      "GCP.IAM.Member": 9,
    });
    for (const id of [
      "TasksWorkerInvoker",
      "SchedulerWorkerInvoker",
      "FrontendApiInvoker",
      "DeployerApiInvoker",
    ]) {
      expect(isOutput(resources[id]?.Props.name)).toBe(true);
    }
    const secretOf = (id: string) =>
      resources[id]?.Props.template.containers[0].env.find(
        (env: { name: string }) => env.name === "DATABASE_URL"
      )?.valueSource.secretKeyRef;
    for (const id of ["WorkspaceApi", "WorkspaceTasksWorker"]) {
      expect(isOutput(secretOf(id)?.secret)).toBe(true);
      expect(secretOf(id)?.version).toBe("3");
    }
    expect(secretOf("WorkspaceSchedulerWorker")).toBeUndefined();
  });

  test("lets only the frontend, and in the sandbox the deployer, invoke the API", async () => {
    const invokersOf = async (config: WorkspaceStackConfig) => {
      const served = await evaluate(
        declareWorkspaceServices(config, servingRecord(), now)
      );
      expect(served.exit._tag).toBe("Success");
      return Object.entries(served.resources)
        .filter(([, entry]) => entry.Props.role === "roles/run.invoker")
        .map(([id, entry]) => ({
          id,
          service: Bun.inspect(entry.Props.name),
          member: entry.Props.member,
        }));
    };
    expect(await invokersOf(sandboxConfig)).toEqual([
      {
        id: "TasksWorkerInvoker",
        service: "WorkspaceTasksWorker.name",
        member: `serviceAccount:${sandboxConfig.serviceAccounts.tasksInvoker}`,
      },
      {
        id: "SchedulerWorkerInvoker",
        service: "WorkspaceSchedulerWorker.name",
        member: `serviceAccount:${sandboxConfig.serviceAccounts.schedulerInvoker}`,
      },
      {
        id: "FrontendApiInvoker",
        service: "WorkspaceApi.name",
        member: `serviceAccount:${sandboxConfig.serviceAccounts.frontendInvoker}`,
      },
      {
        id: "DeployerApiInvoker",
        service: "WorkspaceApi.name",
        member: `serviceAccount:${sandboxConfig.serviceAccounts.deployer}`,
      },
    ]);
    const production = await invokersOf(productionConfig);
    expect(production.map((grant) => grant.id)).toEqual([
      "TasksWorkerInvoker",
      "SchedulerWorkerInvoker",
      "FrontendApiInvoker",
    ]);
    // No service is public.
    expect(
      [...(await invokersOf(sandboxConfig)), ...production].filter((grant) =>
        /allUsers|allAuthenticatedUsers/.test(grant.member)
      )
    ).toEqual([]);
  });

  test("declares services only from the record at the fenced generation", async () => {
    const record = servingRecord();
    const fromStore = (expectedGeneration: number | null) =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryReleaseRecordStore(
          heldBy(record, expectedGeneration === null ? "deploy" : "deliver")
        );
        return yield* declareRecordedWorkspaceServices(
          sandboxConfig,
          runAsHolder(expectedGeneration)
        ).pipe(
          Effect.provideService(ReleaseRecordStore, store),
          Effect.provideService(ReleaseServiceReadback, unconsultedReadback)
        );
      });

    const stale = await evaluate(fromStore(record.generation - 1));
    expect(stale.exit._tag).toBe("Failure");
    expect(String(stale.exit)).toContain("StaleReleaseGeneration");
    expect(stale.resources).toEqual({});

    for (const fenced of [record.generation, null]) {
      const applied = await evaluate(fromStore(fenced));
      expect(applied.exit._tag).toBe("Success");
      expect(
        Object.values(applied.resources).filter(
          (entry) => entry.Type === "GCP.Run.Service"
        )
      ).toHaveLength(3);
    }
  });

  test("a teardown declares no services, even from a pre-rename record", async () => {
    const serving = servingRecord();
    const active = serving.active;
    if (active === null) {
      throw new Error("expected a serving record");
    }
    const preRename: ReleaseRecord = {
      ...serving,
      active: { ...active, revision: "workspace-web-r1-aaaaaaa" },
    };
    const run = (operation: "deploy" | "destroy") =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(preRename, operation)
          );
          return yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(null)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, unconsultedReadback)
          );
        })
      );
    const deploy = await run("deploy");
    expect(String(deploy.exit)).toContain("ReleaseRecordNamesOtherService");
    expect(deploy.resources).toEqual({});
    const destroy = await run("destroy");
    expect(destroy.exit._tag).toBe("Success");
    expect(destroy.resources).toEqual({});
  });

  test("a plain deploy refuses a pending traffic change but keeps a candidate", async () => {
    const plain = (record: ReleaseRecord) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(record, "deploy")
          );
          return yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(null)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, unconsultedReadback)
          );
        })
      );
    const serving = servingRecord();
    const { record: candidate, releaseId } = Effect.runSync(
      stage(serving, {
        expectedGeneration: serving.generation,
        sha: GitSha.make("b".repeat(40)),
        imageDigest: digest,
        origin: "cloud-run",
        liveTemplate: null,
        now,
      })
    );
    const pending = Effect.runSync(
      promote(candidate, {
        expectedGeneration: candidate.generation,
        releaseId,
        now,
        candidateReadback: candidate.candidate,
      })
    );

    const staged = await plain(candidate);
    expect(staged.exit._tag).toBe("Success");
    const refused = await plain(pending);
    expect(String(refused.exit)).toContain("ReleaseApplyPending");
    expect(refused.resources).toEqual({});
  });

  test("a plan declares the API template its following deploy decides", async () => {
    const record = servingRecord();
    // Cloud Run runs the release's template from an older spec.
    const olderSpec = ReleaseServiceReadback.of({
      service: (workload) =>
        Effect.succeed(
          workload === "api"
            ? {
                workload,
                uri: workloadUrl(sandboxConfig, "api"),
                urls: [workloadUrl(sandboxConfig, "api")],
                ingress: "INGRESS_TRAFFIC_ALL",
                invokerIamDisabled: false,
                terminalConditionState: "CONDITION_SUCCEEDED",
                reconciling: false,
                traffic: [
                  { revision: "workspace-api-r1-aaaaaaa", percent: 100 },
                ],
                revisionDigests: { "workspace-api-r1-aaaaaaa": digest },
                annotations: {},
                templateRevision: "workspace-api-r1-aaaaaaa",
                templateImageDigest: digest,
                templateSpecFingerprint: "spec-older",
                templateReady: true,
              }
            : null
        ),
      revision: () => Effect.succeed(null),
    });
    const declareAs = (operation: "plan" | "deploy") =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(record, operation)
          );
          const services = yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(null)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, olderSpec)
          );
          return { services, stored: (yield* store.read).record };
        })
      );

    const planned = await declareAs("plan");
    expect(planned.exit._tag).toBe("Success");
    const template = planned.resources.WorkspaceApi?.Props.template;
    expect(template?.revision).toBe(
      `workspace-api-r1-aaaaaaa-t${record.generation + 1}`
    );
    expect(template?.annotations?.[templateSpecAnnotation]).toBe(
      apiTemplateSpecFingerprint(sandboxConfig, digest)
    );
    // The plan persisted nothing; a deploy persists the decision first.
    if (planned.exit._tag === "Success") {
      expect(planned.exit.value.stored).toEqual(heldBy(record, "plan"));
    }
    const deployed = await declareAs("deploy");
    expect(deployed.resources.WorkspaceApi?.Props.template?.revision).toBe(
      "workspace-api-r1-aaaaaaa"
    );
  });

  test("refuses an empty record while the API service is live", async () => {
    const liveApi = (live: boolean) =>
      ReleaseServiceReadback.of({
        service: (workload) =>
          Effect.succeed(
            live && workload === "api"
              ? {
                  workload,
                  uri: workloadUrl(sandboxConfig, "api"),
                  urls: [workloadUrl(sandboxConfig, "api")],
                  ingress: "INGRESS_TRAFFIC_ALL",
                  invokerIamDisabled: false,
                  terminalConditionState: "CONDITION_SUCCEEDED",
                  reconciling: false,
                  traffic: [
                    { revision: "workspace-api-r3-aaaaaaa", percent: 100 },
                  ],
                  revisionDigests: {},
                  annotations: {},
                }
              : null
          ),
        revision: () => Effect.succeed(null),
      });
    const declare = (live: boolean) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(emptyReleaseRecord, "deploy")
          );
          return yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(null)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, liveApi(live))
          );
        })
      );

    const lost = await declare(true);
    expect(lost.exit._tag).toBe("Failure");
    expect(String(lost.exit)).toContain("ReleaseRecordLost");
    expect(lost.resources).toEqual({});

    const fresh = await declare(false);
    expect(fresh.exit._tag).toBe("Success");
    expect(fresh.resources).toEqual({});
  });

  test("declares no preview services and refuses a fenced preview apply", async () => {
    const preview = (expectedGeneration: number | null) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(servingRecord());
          return yield* declareRecordedWorkspaceServices(previewConfig, {
            writer: Option.none(),
            generation: expectedGeneration,
          }).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, unconsultedReadback)
          );
        })
      );
    const plain = await preview(null);
    expect(plain.exit._tag).toBe("Success");
    expect(plain.resources).toEqual({});
    const fenced = await preview(2);
    expect(fenced.exit._tag).toBe("Failure");
    expect(fenced.resources).toEqual({});
  });

  test("the stack refuses a run without the held lock's token", async () => {
    const record = heldBy(servingRecord(), "deploy");
    const check = (
      config: typeof sandboxConfig,
      writer: Option.Option<Redacted.Redacted<string>>
    ) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(record);
          return yield* requireStackWriter(config, writer).pipe(
            Effect.provideService(ReleaseRecordStore, store)
          );
        })
      );
    expect(String(await check(sandboxConfig, Option.none()))).toContain(
      "ReleaseWriterRequired"
    );
    expect(
      String(await check(sandboxConfig, Option.some(Redacted.make("other"))))
    ).toContain("ReleaseWriterLost");
    expect(
      (await check(sandboxConfig, Option.some(testWriterToken)))._tag
    ).toBe("Success");
    // Preview needs no lock and never reads the record.
    const preview = await Effect.runPromiseExit(
      requireStackWriter(previewConfig, Option.none()).pipe(
        Effect.provideService(
          ReleaseRecordStore,
          ReleaseRecordStore.of({
            read: Effect.die("preview read the record"),
            write: () => Effect.die("preview wrote the record"),
          })
        )
      )
    );
    expect(preview._tag).toBe("Success");
  });

  test("the lock's operation decides whether the stack run is fenced", async () => {
    const record = servingRecord();
    const declare = (
      operation: "deploy" | "deliver",
      generation: number | null
    ) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(record, operation)
          );
          return yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(generation)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, unconsultedReadback)
          );
        })
      );
    // An inherited generation never turns a plain deploy into a fenced one.
    const inherited = await declare("deploy", record.generation);
    expect(String(inherited.exit)).toContain("ReleaseWriterModeMismatch");
    expect(inherited.resources).toEqual({});
    const unfenced = await declare("deliver", null);
    expect(String(unfenced.exit)).toContain("ReleaseWriterModeMismatch");
    expect(unfenced.resources).toEqual({});
  });

  test("plans private workers by digest with distinct audiences", () => {
    const tasks = workerServiceProps(sandboxConfig, "tasks-worker", digest);
    const scheduler = workerServiceProps(
      sandboxConfig,
      "scheduler-worker",
      digest
    );
    expect(tasks).toMatchObject({
      serviceId: "workspace-tasks-worker",
      ingress: "INGRESS_TRAFFIC_ALL",
      invokerIamDisabled: false,
      customAudiences: [
        "https://workspace-tasks-worker-123456789012.europe-west1.run.app",
      ],
      template: {
        serviceAccount: sandboxConfig.serviceAccounts.tasksWorkerRuntime,
        timeout: "300s",
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      },
    });
    expect(tasks.template?.containers?.[0]).toMatchObject({
      image: `europe-west1-docker.pkg.dev/deskohub-ws-sandbox/workspace/workspace@${digest}`,
      env: [
        { name: "WORKSPACE_SERVICE_ROLE", value: "tasks-worker" },
        { name: "WORKSPACE_DEPLOYMENT_STAGE", value: "sandbox" },
        {
          name: "WORKSPACE_TASKS_AUDIENCE",
          value: tasks.customAudiences?.[0],
        },
        {
          name: "WORKSPACE_TASKS_INVOKER_EMAIL",
          value: sandboxConfig.serviceAccounts.tasksInvoker,
        },
        {
          name: "DATABASE_URL",
          valueSource: {
            secretKeyRef: {
              secret:
                "projects/deskohub-ws-sandbox/secrets/workspace-database-url",
              version: "3",
            },
          },
        },
      ],
    });
    expect(scheduler.customAudiences).not.toEqual(tasks.customAudiences);
    // The secret is not granted to the scheduler worker.
    expect(scheduler.template?.containers?.[0]).toMatchObject({
      env: [
        { name: "WORKSPACE_SERVICE_ROLE", value: "scheduler-worker" },
        { name: "WORKSPACE_DEPLOYMENT_STAGE", value: "sandbox" },
        {
          name: "WORKSPACE_SCHEDULER_AUDIENCE",
          value: scheduler.customAudiences?.[0],
        },
        {
          name: "WORKSPACE_SCHEDULER_INVOKER_EMAIL",
          value: sandboxConfig.serviceAccounts.schedulerInvoker,
        },
      ],
    });
  });

  test("workers accept the invokers their queues and schedules sign as", () => {
    const record = servingRecord();
    const [queueContract] = workspaceQueueContracts;
    const [scheduleContract] = workspaceScheduleContracts;
    if (queueContract === undefined || scheduleContract === undefined) {
      throw new Error("expected a queue and a schedule contract");
    }
    const queueTarget = queueProps(sandboxConfig, queueContract);
    const jobTarget = scheduleJobProps(sandboxConfig, scheduleContract);
    const environment = (workload: "tasks-worker" | "scheduler-worker") => {
      const [app] =
        workerServiceProps(sandboxConfig, workload, digest).template
          ?.containers ?? [];
      const env = app !== undefined && "env" in app ? (app.env ?? []) : [];
      return Object.fromEntries(env.map(({ name, value }) => [name, value]));
    };
    expect(environment("tasks-worker")).toMatchObject({
      WORKSPACE_TASKS_AUDIENCE: queueTarget.httpTarget?.oidcToken?.audience,
      WORKSPACE_TASKS_INVOKER_EMAIL:
        queueTarget.httpTarget?.oidcToken?.serviceAccountEmail,
    });
    expect(environment("scheduler-worker")).toMatchObject({
      WORKSPACE_SCHEDULER_AUDIENCE: jobTarget.httpTarget?.oidcToken?.audience,
      WORKSPACE_SCHEDULER_INVOKER_EMAIL:
        jobTarget.httpTarget?.oidcToken?.serviceAccountEmail,
    });
    // The API service takes no Cloud Tasks or Scheduler invoker identity.
    const api = apiServiceProps(sandboxConfig, record, now);
    expect(
      JSON.stringify(api?.template?.containers?.[0]).includes("INVOKER")
    ).toBe(false);
  });

  test("runs the app alone on port 8080 with a /healthz startup probe", () => {
    const record = servingRecord();
    for (const props of [
      apiServiceProps(sandboxConfig, record, now),
      workerServiceProps(sandboxConfig, "tasks-worker", digest),
      workerServiceProps(sandboxConfig, "scheduler-worker", digest),
    ]) {
      const containers = props?.template?.containers ?? [];
      expect(containers).toHaveLength(1);
      expect(containers[0]).toMatchObject({
        image: `europe-west1-docker.pkg.dev/deskohub-ws-sandbox/workspace/workspace@${digest}`,
        ports: [{ containerPort: 8080 }],
        startupProbe: { httpGet: { path: "/healthz", port: 8080 } },
      });
      // Telemetry leaves the app directly; no collector sidecar or
      // loopback exporter is wired.
      expect(JSON.stringify(containers)).not.toContain("OTLP");
      expect(JSON.stringify(containers)).not.toContain("TRACE_PROJECT");
    }
  });

  test("plans the API service from the release record only", () => {
    expect(
      apiServiceProps(sandboxConfig, emptyReleaseRecord, now)
    ).toBeUndefined();
    const staged = Effect.runSync(
      stage(emptyReleaseRecord, {
        expectedGeneration: 0,
        sha: GitSha.make("a".repeat(40)),
        imageDigest: digest,
        origin: "cloud-run",
        liveTemplate: null,
        now,
      })
    );
    const pending = Effect.runSync(
      promote(staged.record, {
        expectedGeneration: 1,
        releaseId: staged.releaseId,
        now,
        candidateReadback: null,
      })
    );
    const api = apiServiceProps(sandboxConfig, pending, now);
    // The default run.app URL stays on; IAM, not ingress, keeps it private.
    expect(api).toMatchObject({
      defaultUriDisabled: false,
      serviceId: "workspace-api",
      ingress: "INGRESS_TRAFFIC_ALL",
      invokerIamDisabled: false,
      template: { revision: "workspace-api-r1-aaaaaaa" },
      traffic: [{ revision: "workspace-api-r1-aaaaaaa", percent: 100 }],
    });
  });

  test("plans platform resources with least-privilege grants", () => {
    expect(artifactRepositoryProps(sandboxConfig)).toMatchObject({
      format: "DOCKER",
      dockerConfig: { immutableTags: true },
    });
    expect(mobileUpdatesBucketProps(sandboxConfig)).toMatchObject({
      location: "EUROPE-WEST1",
      versioning: true,
      uniformBucketLevelAccess: true,
      forceDestroy: true,
    });
    expect(mobileUpdatesBucketProps(productionConfig).forceDestroy).toBe(false);
    expect(
      [
        ...serviceInvokerGrants(sandboxConfig),
        ...secretAccessorGrants(sandboxConfig),
        mobileUpdatesPublisherGrant(sandboxConfig),
      ].map(({ props }) => [
        props.name.split("/").at(-1),
        props.role,
        props.member,
      ])
    ).toEqual([
      [
        "workspace-tasks-worker",
        "roles/run.invoker",
        `serviceAccount:${sandboxConfig.serviceAccounts.tasksInvoker}`,
      ],
      [
        "workspace-scheduler-worker",
        "roles/run.invoker",
        `serviceAccount:${sandboxConfig.serviceAccounts.schedulerInvoker}`,
      ],
      [
        "workspace-api",
        "roles/run.invoker",
        `serviceAccount:${sandboxConfig.serviceAccounts.frontendInvoker}`,
      ],
      [
        "workspace-api",
        "roles/run.invoker",
        `serviceAccount:${sandboxConfig.serviceAccounts.deployer}`,
      ],
      [
        "workspace-database-url",
        "roles/secretmanager.secretAccessor",
        `serviceAccount:${sandboxConfig.serviceAccounts.apiRuntime}`,
      ],
      [
        "workspace-database-url",
        "roles/secretmanager.secretAccessor",
        `serviceAccount:${sandboxConfig.serviceAccounts.tasksWorkerRuntime}`,
      ],
      [
        "deskohub-ws-sandbox-mobile-updates",
        "roles/storage.objectCreator",
        `serviceAccount:${sandboxConfig.serviceAccounts.mobileUpdatesPublisher}`,
      ],
    ]);
    expect(alertPolicyDeclarations(sandboxConfig).map(({ id }) => id)).toEqual([
      "QueueBacklogAlert",
      "ServerErrorRateAlert",
      "SchedulerFailureAlert",
    ]);
  });
});
