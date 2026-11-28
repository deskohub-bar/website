import { describe, expect, test } from "bun:test";
import { havePropsChanged } from "alchemy";
import { isOutput } from "alchemy/Output";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  ImageDigest,
  type WorkspaceStackConfig,
  type WorkspaceWorkload,
} from "../config/stack-config";
import {
  hostedProofConfig,
  previewConfig,
  sandboxConfig,
} from "../config/stack-config.test-utils";
import type { ObservedService } from "../readback";
import {
  apiServiceProps,
  apiTemplateSpecFingerprint,
  templateSpecAnnotation,
} from "../resources/service-declarations";
import { workloadUrl } from "../resources/workload-names";
import { evaluate } from "../stack-evaluation.test-utils";
import {
  declareWorkspaceFoundation,
  declareWorkspaceServices,
} from "../workspace-stack";
import { requireRecordCoversLiveService } from "./live-release-services";
import {
  deliverRelease,
  type ReleaseReadbackPolicy,
  readFencedReleaseRecord,
  recoverRelease,
  restoreRelease,
  runStack,
  stackRunRecord,
} from "./release-delivery";
import {
  ReleaseServiceApply,
  ReleaseServiceApplyFailed,
  ReleaseServiceReadback,
  type StackApplyRequest,
} from "./release-platform";
import { stage } from "./release-reconciler";
import {
  emptyReleaseRecord,
  GitSha,
  ReleaseId,
  type ReleaseRecord,
} from "./release-record";
import {
  makeInMemoryReleaseRecordStore,
  ReleaseRecordStore,
  runReleaseStep,
} from "./release-record-store";
import {
  unlockReleaseWriter,
  withReleaseWriter,
  writerDigestOf,
  writerFingerprint,
} from "./release-writer";

const shaA = GitSha.make("a".repeat(40));
const shaB = GitSha.make("b".repeat(40));
const shaC = GitSha.make("c".repeat(40));
const digestA = ImageDigest.make(`sha256:${"1".repeat(64)}`);
const digestB = ImageDigest.make(`sha256:${"2".repeat(64)}`);
const digestC = ImageDigest.make(`sha256:${"3".repeat(64)}`);

const policy: ReleaseReadbackPolicy = {
  attempts: 3,
  spacing: Duration.zero,
};

interface FakeCloudRunOptions {
  /** Fail the apply of these generations before the process starts. */
  readonly notStartedApplyOf?: ReadonlySet<number>;
  /** Fail the apply of these generations as if the run died mid-apply. */
  readonly interruptApplyOf?: ReadonlySet<number>;
  /** Readback keeps showing the old traffic for this many reads per apply. */
  readonly trafficLagReads?: number;
  /** The digest Cloud Run reports for the next materialized revision. */
  readonly resolvedDigest?: ImageDigest;
  /** Runs before each candidate revision read, e.g. a competing writer. */
  readonly beforeRevisionRead?: Effect.Effect<
    void,
    unknown,
    ReleaseRecordStore
  >;
  /** The ingress Cloud Run reports for the tasks worker. */
  readonly tasksWorkerIngress?: string;
  /**
   * Runs inside each apply right after it read its record, while the
   * writer still holds the lock: a test can pause the apply here.
   */
  readonly afterRecordRead?: (
    request: StackApplyRequest
  ) => Effect.Effect<void, never, ReleaseRecordStore>;
}

/** Platform misbehaviour a test can switch on between runs. */
interface CloudRunFaults {
  /** The digest Cloud Run reports for the next materialized revision. */
  resolvedDigest?: ImageDigest;
  /** Workers keep running the image they had before the apply. */
  staleWorkers?: boolean;
  /** Each apply sends 10% of traffic to the newest tagged revision. */
  splitTraffic?: boolean;
  /** Workers stay missing for this many reads after the next apply. */
  missingWorkerReads?: number;
  /** Workers report a rollout without a URL for this many reads. */
  unsettledWorkerReads?: number;
  /** Services report a rollout in progress. */
  reconciling?: boolean;
  /** The live API template's revision is not ready. */
  failedTemplate?: boolean;
  /** The stack config the apply declares from, after a config change. */
  config?: WorkspaceStackConfig;
}

/**
 * A Cloud Run project that applies the API service exactly as the release
 * record declares it, read under the apply's generation fence.
 */
const makeFakeCloudRun = (options: FakeCloudRunOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* ReleaseRecordStore;
    const faults: CloudRunFaults = { resolvedDigest: options.resolvedDigest };
    const applies: Array<number | null> = [];
    const revisions = new Map<string, ImageDigest>();
    /** The spec fingerprint each revision was created with. */
    const revisionSpecs = new Map<string, string | undefined>();
    let api: ObservedService | null = null;
    let visible: ObservedService | null = null;
    let lagReads = 0;
    let workerDigest: ImageDigest | null = null;
    let missingWorkerReads = 0;
    let unsettledWorkerReads = 0;
    /** Every API template the applies declared: name and spec fingerprint. */
    const declaredTemplates: Array<{
      readonly revision: string | undefined;
      readonly specFingerprint: string | undefined;
    }> = [];
    /** The API template each plan previewed, in order. */
    const plannedTemplates: Array<string | undefined> = [];
    /** Every stack run's declared record and clock, in order. */
    const stackRuns: Array<{
      readonly action: StackApplyRequest["action"];
      readonly declaring: ReleaseRecord;
      readonly now: DateTime.Utc;
    }> = [];

    const apply = ReleaseServiceApply.of({
      apply: (request) =>
        Effect.gen(function* () {
          const { generation } = request;
          if (
            generation !== null &&
            options.notStartedApplyOf?.has(generation)
          ) {
            return yield* new ReleaseServiceApplyFailed({
              generation,
              outcome: "not-started",
              reason: "the apply command did not start",
            });
          }
          applies.push(generation);
          const failed = (reason: string) =>
            new ReleaseServiceApplyFailed({
              generation,
              outcome: "unknown",
              reason,
            });
          // The stack's own checks: the held lock's token, then the fence.
          const record = yield* (
            generation === null
              ? store.read.pipe(Effect.map(({ record }) => record))
              : readFencedReleaseRecord(generation)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.mapError((error) => failed(error._tag))
          );
          if (
            record.writer?.holderDigest !== writerDigestOf(request.writer) ||
            record.writer.state !== "held"
          ) {
            return yield* failed("ReleaseWriterLost");
          }
          yield* (options.afterRecordRead?.(request) ?? Effect.void).pipe(
            Effect.provideService(ReleaseRecordStore, store)
          );
          if (
            generation !== null &&
            options.interruptApplyOf?.has(generation)
          ) {
            return yield* failed("interrupted");
          }
          const config = faults.config ?? sandboxConfig;
          // The record the stack declares under the held lock's operation.
          const declaring = yield* stackRunRecord(
            config,
            record,
            record.writer.operation
          ).pipe(
            Effect.provideService(ReleaseServiceReadback, readback),
            Effect.mapError((error) => failed(error._tag))
          );
          stackRuns.push({
            action: request.action,
            declaring,
            now: yield* DateTime.now,
          });
          if (request.action === "plan") {
            plannedTemplates.push(
              apiServiceProps(config, declaring, yield* DateTime.now)?.template
                ?.revision
            );
            return;
          }
          const props = apiServiceProps(config, declaring, yield* DateTime.now);
          if (props === undefined) {
            return;
          }
          const revision = props.template?.revision;
          const image = props.template?.containers?.[0]?.image;
          const specFingerprint =
            props.template?.annotations?.[templateSpecAnnotation];
          // Cloud Run never re-creates an existing revision name: only the
          // live template's own name from its own spec re-declares cleanly.
          if (
            revision !== undefined &&
            revisionSpecs.has(revision) &&
            (api?.templateRevision !== revision ||
              revisionSpecs.get(revision) !== specFingerprint)
          ) {
            return yield* failed(`revision ${revision} already exists`);
          }
          if (revision !== undefined) {
            revisionSpecs.set(revision, specFingerprint);
          }
          if (revision !== undefined && Schema.is(Schema.String)(image)) {
            revisions.set(
              revision,
              faults.resolvedDigest ??
                ImageDigest.make(image.slice(image.indexOf("@") + 1))
            );
          }
          // Workers run the serving release's image, like the stack declares.
          if (!faults.staleWorkers) {
            workerDigest =
              (record.pendingApply?.target ?? record.active)?.imageDigest ??
              null;
          }
          const declared = (props.traffic ?? []).map((entry) => ({
            revision: entry.revision ?? "",
            percent: entry.percent ?? 0,
            tag: entry.tag,
          }));
          const splitPercent = (index: number, percent: number) => {
            if (index === 0) {
              return 90;
            }
            return index === declared.length - 1 ? 10 : percent;
          };
          const traffic = faults.splitTraffic
            ? declared.map((entry, index) => ({
                ...entry,
                percent: splitPercent(index, entry.percent),
              }))
            : declared;
          api = {
            workload: "api",
            uri: workloadUrl(sandboxConfig, "api"),
            urls: [workloadUrl(sandboxConfig, "api")],
            ingress: props.ingress,
            invokerIamDisabled: props.invokerIamDisabled === true,
            terminalConditionState: "CONDITION_SUCCEEDED",
            reconciling: false,
            traffic,
            revisionDigests: Object.fromEntries(revisions),
            annotations: { ...props.annotations },
            templateRevision: props.template?.revision,
            templateImageDigest: Schema.is(Schema.String)(image)
              ? ImageDigest.make(image.slice(image.indexOf("@") + 1))
              : undefined,
            templateSpecFingerprint:
              props.template?.annotations?.[templateSpecAnnotation],
            templateReady: true,
          };
          lagReads = options.trafficLagReads ?? 0;
          missingWorkerReads = faults.missingWorkerReads ?? 0;
          unsettledWorkerReads = faults.unsettledWorkerReads ?? 0;
          declaredTemplates.push({
            revision: props.template?.revision,
            specFingerprint:
              props.template?.annotations?.[templateSpecAnnotation],
          });
        }),
    });

    const worker = (
      workload: Exclude<WorkspaceWorkload, "api">,
      imageDigest: ImageDigest
    ): ObservedService => ({
      workload,
      uri: workloadUrl(sandboxConfig, workload),
      urls: [workloadUrl(sandboxConfig, workload)],
      ingress:
        workload === "tasks-worker"
          ? (options.tasksWorkerIngress ?? "INGRESS_TRAFFIC_ALL")
          : "INGRESS_TRAFFIC_ALL",
      invokerIamDisabled: false,
      terminalConditionState: "CONDITION_SUCCEEDED",
      reconciling: faults.reconciling === true,
      traffic: [{ revision: `${workload}-00001`, percent: 100 }],
      revisionDigests: { [`${workload}-00001`]: imageDigest },
      annotations: {},
    });

    const readback = ReleaseServiceReadback.of({
      service: (workload) =>
        Effect.sync(() => {
          if (workload !== "api") {
            if (missingWorkerReads > 0) {
              missingWorkerReads -= 1;
              return null;
            }
            if (workerDigest === null) {
              return null;
            }
            if (unsettledWorkerReads > 0) {
              unsettledWorkerReads -= 1;
              return {
                ...worker(workload, workerDigest),
                uri: undefined,
                urls: [],
                reconciling: true,
              };
            }
            return worker(workload, workerDigest);
          }
          if (lagReads > 0) {
            lagReads -= 1;
            return visible;
          }
          visible = api;
          return api === null
            ? null
            : {
                ...api,
                reconciling: faults.reconciling === true,
                templateReady: faults.failedTemplate !== true,
              };
        }),
      revision: (revision) =>
        (options.beforeRevisionRead ?? Effect.void).pipe(
          Effect.provideService(ReleaseRecordStore, store),
          Effect.orDie,
          Effect.as(
            revisions.has(revision)
              ? {
                  revision,
                  imageDigest: revisions.get(revision) ?? null,
                  ready: true,
                }
              : null
          )
        ),
    });

    /** Someone outside the release flow rolls out another API template. */
    const rollOutExternally = () => {
      const revision = "workspace-api-external-00001";
      revisions.set(revision, digestA);
      revisionSpecs.set(revision, "external");
      if (api !== null) {
        api = {
          ...api,
          templateRevision: revision,
          templateImageDigest: digestA,
          templateSpecFingerprint: "external",
        };
      }
    };

    return {
      apply,
      readback,
      applies,
      faults,
      declaredTemplates,
      plannedTemplates,
      stackRuns,
      rollOutExternally,
    };
  });

const setup = (options?: FakeCloudRunOptions) =>
  Effect.gen(function* () {
    const store = yield* makeInMemoryReleaseRecordStore(emptyReleaseRecord);
    const cloudRun = yield* makeFakeCloudRun(options).pipe(
      Effect.provideService(ReleaseRecordStore, store)
    );
    const provide = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        ReleaseRecordStore | ReleaseServiceApply | ReleaseServiceReadback
      >
    ) =>
      effect.pipe(
        Effect.provideService(ReleaseRecordStore, store),
        Effect.provideService(ReleaseServiceApply, cloudRun.apply),
        Effect.provideService(ReleaseServiceReadback, cloudRun.readback)
      );
    return {
      store,
      applies: cloudRun.applies,
      faults: cloudRun.faults,
      declaredTemplates: cloudRun.declaredTemplates,
      plannedTemplates: cloudRun.plannedTemplates,
      stackRuns: cloudRun.stackRuns,
      rollOutExternally: cloudRun.rollOutExternally,
      provide,
    };
  });

const errorOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }
  const reason = exit.cause.reasons[0];
  return reason?._tag === "Fail" ? reason.error : reason;
};

describe("fenced release delivery", () => {
  test("the first release creates the service and settles from readback", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup();
        const serving = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        return { serving, stored: yield* store.read, applies };
      })
    );
    expect(result.serving).toMatchObject({
      releaseId: "r1-aaaaaaa",
      imageDigest: digestA,
      revision: "workspace-api-r1-aaaaaaa",
    });
    // Stage, promote and settle each advanced the record once.
    expect(result.serving.generation).toBe(3);
    // No candidate apply before the service exists; one traffic apply.
    expect(result.applies).toEqual([2]);
    expect(result.stored.record.pendingApply).toBeNull();
    expect(result.stored.record.active?.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
  });

  test("a later release is verified as a zero-traffic revision before promotion", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup();
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        const serving = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          )
        );
        return { serving, record: (yield* store.read).record, applies };
      })
    );
    expect(result.serving).toMatchObject({
      releaseId: "r4-bbbbbbb",
      imageDigest: digestB,
    });
    // Candidate materialization at the staged generation, then traffic.
    expect(result.applies).toEqual([2, 4, 5]);
    expect(result.record.previous?.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
    expect(result.record.compatible.map((entry) => entry.releaseId)).toEqual([
      ReleaseId.make("r1-aaaaaaa"),
    ]);
  });

  test("restore returns traffic to the previous verified digest", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup();
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        const promoted = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          )
        );
        const settled = (yield* store.read).record;
        // Restoring the active release re-asserts its traffic only.
        const restored = yield* provide(
          restoreRelease(
            sandboxConfig,
            {
              releaseId: promoted.releaseId,
              expectedGeneration: promoted.generation,
            },
            policy
          )
        );
        const reasserted = (yield* store.read).record;
        const back = yield* provide(
          restoreRelease(
            sandboxConfig,
            {
              releaseId: settled.previous?.releaseId ?? promoted.releaseId,
              expectedGeneration: reasserted.generation,
            },
            policy
          )
        );
        return {
          settled,
          restored,
          reasserted,
          back,
          record: (yield* store.read).record,
        };
      })
    );
    expect(result.restored.releaseId).toBe(ReleaseId.make("r4-bbbbbbb"));
    expect(result.reasserted.active).toEqual(result.settled.active);
    expect(result.reasserted.previous).toEqual(result.settled.previous);
    expect(result.reasserted.compatible).toEqual(result.settled.compatible);
    expect(result.back).toMatchObject({
      releaseId: "r1-aaaaaaa",
      imageDigest: digestA,
      revision: "workspace-api-r1-aaaaaaa",
    });
    expect(result.record.previous?.releaseId).toBe(
      ReleaseId.make("r4-bbbbbbb")
    );
  });

  test("a restore fenced on a superseded generation changes nothing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup();
        const first = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          )
        );
        const before = yield* store.read;
        const appliesBefore = applies.length;
        const exit = yield* provide(
          restoreRelease(
            sandboxConfig,
            {
              releaseId: first.releaseId,
              expectedGeneration: first.generation,
            },
            policy
          ).pipe(Effect.exit)
        );
        return {
          exit,
          before,
          after: yield* store.read,
          newApplies: applies.length - appliesBefore,
        };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "StaleReleaseGeneration",
      expectedGeneration: 3,
      currentGeneration: 6,
    });
    // Only the writer lock came and went.
    expect(result.after.record).toEqual(result.before.record);
    expect(result.newApplies).toBe(0);
  });

  test("an interrupted traffic apply stays pending and recovery settles it once unlocked", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup({
          interruptApplyOf: new Set([2]),
        });
        const interrupted = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          ).pipe(Effect.exit)
        );
        const pending = (yield* store.read).record.pendingApply;
        return { interrupted, pending, store, applies, provide };
      })
    );
    expect(errorOf(result.interrupted)).toMatchObject({
      _tag: "ReleaseServiceApplyFailed",
      generation: 2,
      outcome: "unknown",
    });
    expect(result.pending?.target.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));

    // The interruption was transient: the next run re-applies generation 2
    // once an operator confirmed the old run ended and unlocked it.
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const { provide } = yield* setup();
        return yield* provide(
          Effect.gen(function* () {
            // Seed the new run's store with the interrupted run's record.
            const store = yield* ReleaseRecordStore;
            const seeded = yield* store.read;
            const interrupted = (yield* result.store.read).record;
            yield* store.write(interrupted, seeded.version);
            const blocked = yield* recoverRelease(sandboxConfig, policy).pipe(
              Effect.exit
            );
            yield* unlockReleaseWriter(
              sandboxConfig,
              interrupted.writer === null
                ? ""
                : writerFingerprint(interrupted.writer.holderDigest)
            );
            return {
              blocked,
              settled: yield* recoverRelease(sandboxConfig, policy),
            };
          })
        );
      })
    );
    expect(errorOf(recovered.blocked)).toMatchObject({
      _tag: "ReleaseWriterBusy",
      state: "in-doubt",
    });
    expect(recovered.settled).toMatchObject({
      releaseId: "r1-aaaaaaa",
      imageDigest: digestA,
    });
  });

  test("recovery is a no-op without a pending apply", async () => {
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const { provide } = yield* setup();
        return yield* provide(recoverRelease(sandboxConfig, policy));
      })
    );
    expect(recovered).toBeNull();
  });

  test("lagging readback settles once traffic shows the target", async () => {
    const serving = await Effect.runPromise(
      Effect.gen(function* () {
        const { provide } = yield* setup({ trafficLagReads: 2 });
        return yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
      })
    );
    expect(serving.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
  });

  test("readback that never converges keeps the intent pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup({
          trafficLagReads: policy.attempts,
        });
        const exit = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          ).pipe(Effect.exit)
        );
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseApplyNotObserved",
      intended: "r1-aaaaaaa",
    });
    expect(result.record.pendingApply?.target.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
    expect(result.record.active).toBeNull();
  });

  test("a candidate whose resolved digest differs is never promoted", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup();
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        const { provide: provideTampered } = yield* setup({
          resolvedDigest: digestC,
        });
        const exit = yield* provideTampered(
          Effect.gen(function* () {
            const seeded = yield* ReleaseRecordStore;
            yield* seeded.write(
              (yield* store.read).record,
              (yield* seeded.read).version
            );
            return yield* deliverRelease(
              sandboxConfig,
              { sha: shaB, imageDigest: digestB },
              policy
            );
          }).pipe(Effect.exit)
        );
        return { exit };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "CandidateNotVerified",
      releaseId: "r4-bbbbbbb",
    });
  });

  test("a competing run that stages first fences out the promotion", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        let armed = false;
        let competed = false;
        const { store, provide } = yield* setup({
          // The competing run stages while the second delivery verifies.
          beforeRevisionRead: Effect.suspend(() => {
            if (!armed || competed) {
              return Effect.void;
            }
            competed = true;
            return runReleaseStep((record) =>
              stage(record, {
                expectedGeneration: record.generation,
                sha: shaC,
                imageDigest: digestC,
                origin: "cloud-run",
                liveTemplate: null,
                now: DateTime.makeUnsafe("2026-11-22T10:00:00Z"),
              }).pipe(
                Effect.map((staged) => ({
                  record: staged.record,
                  result: null,
                }))
              )
            );
          }),
        });
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        armed = true;
        const exit = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          ).pipe(Effect.exit)
        );
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "StaleReleaseGeneration",
      expectedGeneration: 4,
      currentGeneration: 5,
    });
    expect(result.record.candidate?.releaseId).toBe(
      ReleaseId.make("r5-ccccccc")
    );
    expect(result.record.pendingApply).toBeNull();
    expect(result.record.active?.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
  });

  test("worker contract drift blocks settlement", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup({
          tasksWorkerIngress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
        });
        const exit = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          ).pipe(Effect.exit)
        );
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseServiceDrift",
      drift: [
        {
          workload: "tasks-worker",
          field: "ingress",
          observed: "INGRESS_TRAFFIC_INTERNAL_ONLY",
        },
      ],
    });
    expect(result.record.pendingApply).not.toBeNull();
  });

  test("a lost record never restarts history over a live service", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup();
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        // The record object is deleted: the store reads the empty record.
        const live = yield* store.read;
        yield* store.write(emptyReleaseRecord, live.version);
        const exit = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          ).pipe(Effect.exit)
        );
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseRecordLost",
      liveWorkloads: ["api", "tasks-worker", "scheduler-worker"],
    });
    expect(result.record).toEqual(emptyReleaseRecord);
  });

  test("a record from before the API rename is refused except by a teardown", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, stackRuns, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        // The record still names the old web service's revisions.
        const live = yield* store.read;
        const { active, materialized } = live.record;
        if (active === null || materialized === null) {
          return yield* Effect.die(
            new Error("the first release did not serve")
          );
        }
        const renamed = (revision: string) =>
          revision.replace(/^workspace-api-/, "workspace-web-");
        const preRename = {
          ...live.record,
          active: { ...active, revision: renamed(active.revision) },
          materialized: {
            ...materialized,
            revision: renamed(materialized.revision),
          },
        };
        yield* store.write(preRename, live.version);
        const runsBefore = stackRuns.length;
        const exit = yield* provide(deliver(shaB, digestB).pipe(Effect.exit));
        const deploy = yield* provide(
          withReleaseWriter(
            sandboxConfig,
            "deploy"
          )(Effect.void).pipe(Effect.exit)
        );
        const record = (yield* store.read).record;
        // Only the teardown may take the lock over it, so the stack drains.
        const teardown = yield* provide(
          withReleaseWriter(
            sandboxConfig,
            "destroy"
          )(Effect.succeed("torn down")).pipe(Effect.exit)
        );
        return {
          exit,
          deploy,
          teardown,
          preRename,
          record,
          newRuns: stackRuns.length - runsBefore,
          lockAfterTeardown: (yield* store.read).record.writer,
        };
      })
    );
    expect(errorOf(result.deploy)).toMatchObject({
      _tag: "ReleaseRecordNamesOtherService",
    });
    expect(result.teardown).toEqual(Exit.succeed("torn down"));
    expect(result.lockAfterTeardown).toBeNull();
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseRecordNamesOtherService",
      revisions: expect.arrayContaining([
        expect.stringMatching(/^workspace-web-/),
      ]),
    });
    // No candidate was staged and no stack run was attempted.
    expect(result.record).toEqual(result.preRename);
    expect(result.newRuns).toBe(0);
  });
});

const deliver = (sha: GitSha, imageDigest: ImageDigest) =>
  deliverRelease(sandboxConfig, { sha, imageDigest }, policy);

describe("release readback gates", () => {
  test("promotion waits for the active release to hold all traffic and the candidate none", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        faults.splitTraffic = true;
        const exit = yield* provide(deliver(shaB, digestB).pipe(Effect.exit));
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "CandidateNotVerified",
      releaseId: "r4-bbbbbbb",
    });
    expect(result.record.pendingApply).toBeNull();
    expect(result.record.active?.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
  });

  test("settlement waits for both workers to run the target image", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        faults.staleWorkers = true;
        const exit = yield* provide(deliver(shaB, digestB).pipe(Effect.exit));
        const pending = (yield* store.read).record;
        faults.staleWorkers = false;
        const recovered = yield* provide(recoverRelease(sandboxConfig, policy));
        return { exit, pending, recovered };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseApplyNotObserved",
      intended: "r4-bbbbbbb",
    });
    expect(result.pending.pendingApply?.target.releaseId).toBe(
      ReleaseId.make("r4-bbbbbbb")
    );
    expect(result.recovered?.releaseId).toBe(ReleaseId.make("r4-bbbbbbb"));
  });
});

describe("restore after a failed candidate", () => {
  /** Two settled releases, then a third whose candidate fails. */
  const failCandidate = (fault: "digest" | "apply") =>
    Effect.gen(function* () {
      const { store, faults, provide } = yield* setup({
        // Generation 7 stages the third release's candidate.
        interruptApplyOf: fault === "apply" ? new Set([7]) : undefined,
      });
      yield* provide(deliver(shaA, digestA));
      yield* provide(deliver(shaB, digestB));
      if (fault === "digest") {
        faults.resolvedDigest = digestA;
      }
      const failed = yield* provide(deliver(shaC, digestC).pipe(Effect.exit));
      faults.resolvedDigest = undefined;
      const lock = (yield* store.read).record.writer;
      if (lock !== null) {
        // The failed apply left its lock in doubt; the operator clears it.
        yield* provide(
          unlockReleaseWriter(
            sandboxConfig,
            writerFingerprint(lock.holderDigest)
          )
        );
      }
      const before = yield* store.read;
      const restored = yield* provide(
        restoreRelease(
          sandboxConfig,
          {
            releaseId: ReleaseId.make("r1-aaaaaaa"),
            expectedGeneration: before.record.generation,
          },
          policy
        )
      );
      const record = (yield* store.read).record;
      return {
        failed,
        restored,
        record,
        api: apiServiceProps(sandboxConfig, record, yield* DateTime.now),
      };
    });

  test("keeps a landed candidate template and drops its traffic tag", async () => {
    const result = await Effect.runPromise(failCandidate("digest"));
    expect(errorOf(result.failed)).toMatchObject({
      _tag: "CandidateNotVerified",
    });
    expect(result.restored.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
    expect(result.record.candidate).toBeNull();
    // Cloud Run already runs the candidate's template: it stays declared.
    expect(result.record.materialized?.revision).toBe(
      "workspace-api-r7-ccccccc"
    );
    expect(result.api?.template?.revision).toBe("workspace-api-r7-ccccccc");
    expect(result.api?.traffic?.map((entry) => entry.revision)).not.toContain(
      "workspace-api-r7-ccccccc"
    );
  });

  test("keeps the materialized template when the candidate never landed", async () => {
    const result = await Effect.runPromise(failCandidate("apply"));
    expect(errorOf(result.failed)).toMatchObject({
      _tag: "ReleaseServiceApplyFailed",
    });
    expect(result.record.candidate).toBeNull();
    expect(result.record.materialized?.revision).toBe(
      "workspace-api-r4-bbbbbbb"
    );
    expect(result.api?.template?.revision).toBe("workspace-api-r4-bbbbbbb");
    expect(result.api?.traffic?.map((entry) => entry.revision)).not.toContain(
      "workspace-api-r7-ccccccc"
    );
  });
});

describe("lost release record", () => {
  test("recovery reports a lost record instead of nothing pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        const live = yield* store.read;
        yield* store.write(emptyReleaseRecord, live.version);
        return yield* provide(
          recoverRelease(sandboxConfig, policy).pipe(Effect.exit)
        );
      })
    );
    expect(errorOf(result)).toMatchObject({ _tag: "ReleaseRecordLost" });
  });

  test("a live worker alone proves the record was lost", async () => {
    const exit = await Effect.runPromiseExit(
      requireRecordCoversLiveService(emptyReleaseRecord).pipe(
        Effect.provideService(
          ReleaseServiceReadback,
          ReleaseServiceReadback.of({
            service: (workload) =>
              Effect.succeed(
                workload === "scheduler-worker"
                  ? {
                      workload,
                      uri: undefined,
                      urls: [],
                      ingress: "INGRESS_TRAFFIC_ALL",
                      invokerIamDisabled: false,
                      terminalConditionState: "CONDITION_SUCCEEDED",
                      reconciling: false,
                      traffic: [],
                      revisionDigests: {},
                      annotations: {},
                    }
                  : null
              ),
            revision: () => Effect.succeed(null),
          })
        )
      )
    );
    expect(errorOf(exit)).toMatchObject({
      _tag: "ReleaseRecordLost",
      liveWorkloads: ["scheduler-worker"],
    });
  });
});

const fingerprintOf = (record: ReleaseRecord) =>
  record.writer === null ? "" : writerFingerprint(record.writer.holderDigest);

describe("release writer lock", () => {
  test("a writer paused after its fence read keeps every other writer out", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let pauseNext = false;
        const { store, applies, provide } = yield* setup({
          afterRecordRead: () =>
            pauseNext
              ? Effect.gen(function* () {
                  pauseNext = false;
                  yield* Deferred.succeed(reached, undefined);
                  yield* Deferred.await(resume);
                })
              : Effect.void,
        });
        yield* provide(deliver(shaA, digestA));
        pauseNext = true;
        // Run A applies the candidate and stops right after its fence read.
        const runA = yield* Effect.forkChild(provide(deliver(shaB, digestB)));
        yield* Deferred.await(reached);
        const paused = yield* store.read;
        const appliesWhilePaused = applies.length;
        const refused = yield* Effect.all([
          provide(deliver(shaC, digestC).pipe(Effect.exit)),
          provide(
            restoreRelease(
              sandboxConfig,
              {
                releaseId: ReleaseId.make("r1-aaaaaaa"),
                expectedGeneration: paused.record.generation,
              },
              policy
            ).pipe(Effect.exit)
          ),
          provide(recoverRelease(sandboxConfig, policy).pipe(Effect.exit)),
          provide(runStack(sandboxConfig, "deploy").pipe(Effect.exit)),
          provide(runStack(sandboxConfig, "plan").pipe(Effect.exit)),
        ]);
        const afterRefusals = yield* store.read;
        const newApplies = applies.length - appliesWhilePaused;
        yield* Deferred.succeed(resume, undefined);
        const servedA = yield* Fiber.join(runA);
        // Once A finished, the next writer proceeds.
        const servedB = yield* provide(deliver(shaC, digestC));
        return {
          refused,
          paused,
          afterRefusals,
          newApplies,
          servedA,
          servedB,
          final: (yield* store.read).record,
        };
      })
    );
    for (const exit of result.refused) {
      expect(errorOf(exit)).toMatchObject({
        _tag: "ReleaseWriterBusy",
        operation: "deliver",
        state: "held",
      });
    }
    expect(result.afterRefusals).toEqual(result.paused);
    expect(result.newApplies).toBe(0);
    expect(result.servedA.releaseId).toBe(ReleaseId.make("r4-bbbbbbb"));
    expect(result.servedB.releaseId).toBe(ReleaseId.make("r7-ccccccc"));
    expect(result.final.writer).toBeNull();
  });

  test("a failed apply leaves the lock in doubt until an operator unlocks it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup({
          interruptApplyOf: new Set([5]),
        });
        yield* provide(deliver(shaA, digestA));
        const failed = yield* provide(deliver(shaB, digestB).pipe(Effect.exit));
        const inDoubt = (yield* store.read).record;
        const blocked = yield* provide(
          deliver(shaC, digestC).pipe(Effect.exit)
        );
        const wrongHolder = yield* provide(
          unlockReleaseWriter(sandboxConfig, "000000000000").pipe(Effect.exit)
        );
        faults.reconciling = true;
        const rollingOut = yield* provide(
          unlockReleaseWriter(sandboxConfig, fingerprintOf(inDoubt)).pipe(
            Effect.exit
          )
        );
        const stillLocked = (yield* store.read).record;
        faults.reconciling = false;
        const cleared = yield* provide(
          unlockReleaseWriter(sandboxConfig, fingerprintOf(inDoubt))
        );
        // The pending promote of r4 is superseded by a restore of the
        // active release, which keeps the release history.
        const restored = yield* provide(
          restoreRelease(
            sandboxConfig,
            {
              releaseId: ReleaseId.make("r1-aaaaaaa"),
              expectedGeneration: (yield* store.read).record.generation,
            },
            policy
          )
        );
        return {
          failed,
          inDoubt,
          blocked,
          wrongHolder,
          rollingOut,
          stillLocked,
          cleared,
          restored,
          final: (yield* store.read).record,
        };
      })
    );
    expect(errorOf(result.failed)).toMatchObject({
      _tag: "ReleaseServiceApplyFailed",
      outcome: "unknown",
    });
    expect(result.inDoubt.writer).toMatchObject({
      operation: "deliver",
      state: "in-doubt",
    });
    expect(result.inDoubt.pendingApply?.target.releaseId).toBe(
      ReleaseId.make("r4-bbbbbbb")
    );
    expect(errorOf(result.blocked)).toMatchObject({
      _tag: "ReleaseWriterBusy",
      state: "in-doubt",
    });
    expect(errorOf(result.wrongHolder)).toMatchObject({
      _tag: "ReleaseWriterNotHeld",
    });
    expect(errorOf(result.rollingOut)).toMatchObject({
      _tag: "ReleaseServicesReconciling",
    });
    expect(result.stillLocked.writer).toEqual(result.inDoubt.writer);
    expect(result.cleared).toMatchObject({
      holder: fingerprintOf(result.inDoubt),
      state: "in-doubt",
    });
    expect(JSON.stringify(result.cleared)).not.toContain(
      result.inDoubt.writer?.holderDigest ?? "<none>"
    );
    expect(result.restored.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
    expect(result.final).toMatchObject({
      pendingApply: null,
      candidate: null,
      writer: null,
      active: result.inDoubt.active,
      previous: result.inDoubt.previous,
      compatible: result.inDoubt.compatible,
      // r4's candidate template landed before its promotion failed.
      materialized: { revision: "workspace-api-r4-bbbbbbb" },
    });
  });

  test("a writer whose lock was taken over stops before its next step", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const usurper = writerDigestOf(Redacted.make("another-writer"));
        const { store, provide } = yield* setup({
          afterRecordRead: () =>
            Effect.gen(function* () {
              // An operator unlocked the run and another writer took over.
              const store = yield* ReleaseRecordStore;
              const current = yield* store.read.pipe(Effect.orDie);
              yield* store
                .write(
                  {
                    ...current.record,
                    writer: {
                      holderDigest: usurper,
                      operation: "recover",
                      acquiredAt: "2026-11-22T10:00:00Z",
                      state: "held",
                    },
                  },
                  current.version
                )
                .pipe(Effect.orDie);
            }),
        });
        const exit = yield* provide(deliver(shaA, digestA).pipe(Effect.exit));
        return { exit, usurper, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseWriterLost",
      heldFingerprint: writerFingerprint(result.usurper),
    });
    // Nothing was settled, and the other writer's lock is left alone.
    expect(result.record.pendingApply?.target.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
    expect(result.record.writer?.holderDigest).toBe(result.usurper);
  });

  test("preview operations refuse before reading or writing the record", async () => {
    const untouched = ReleaseRecordStore.of({
      read: Effect.die("preview read the record"),
      write: () => Effect.die("preview wrote the record"),
    });
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const { provide } = yield* setup();
        return yield* provide(
          Effect.all([
            deliverRelease(
              previewConfig,
              { sha: shaA, imageDigest: digestA },
              policy
            ).pipe(Effect.exit),
            restoreRelease(
              previewConfig,
              {
                releaseId: ReleaseId.make("r1-aaaaaaa"),
                expectedGeneration: 0,
              },
              policy
            ).pipe(Effect.exit),
            recoverRelease(previewConfig, policy).pipe(Effect.exit),
            runStack(previewConfig, "deploy").pipe(Effect.exit),
            unlockReleaseWriter(previewConfig, "000000000000").pipe(
              Effect.exit
            ),
          ]).pipe(Effect.provideService(ReleaseRecordStore, untouched))
        );
      })
    );
    for (const exit of exits) {
      expect(errorOf(exit)).toMatchObject({
        _tag: "PreviewServicesUnprotected",
      });
    }
  });

  test("a plain stack run refuses a pending traffic change", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup({
          trafficLagReads: 10,
        });
        yield* provide(deliver(shaA, digestA).pipe(Effect.exit));
        const appliesBefore = applies.length;
        const exit = yield* provide(
          runStack(sandboxConfig, "deploy").pipe(Effect.exit)
        );
        return {
          exit,
          newApplies: applies.length - appliesBefore,
          record: (yield* store.read).record,
        };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({ _tag: "ReleaseApplyPending" });
    expect(result.newApplies).toBe(0);
    expect(result.record.writer).toBeNull();
  });

  test("a plain stack run applies unfenced and releases the lock", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        yield* provide(runStack(sandboxConfig, "deploy"));
        yield* provide(runStack(sandboxConfig, "plan"));
        return { applies, record: (yield* store.read).record };
      })
    );
    expect(result.applies.slice(-2)).toEqual([null, null]);
    expect(result.record.writer).toBeNull();
  });
});

describe("recovery from a failed apply", () => {
  test("a first release whose apply failed is replaced in one stage and promote step", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup({
          interruptApplyOf: new Set([2]),
        });
        yield* provide(deliver(shaA, digestA).pipe(Effect.exit));
        const failed = (yield* store.read).record;
        yield* provide(
          unlockReleaseWriter(sandboxConfig, fingerprintOf(failed))
        );
        const served = yield* provide(deliver(shaB, digestB));
        return { failed, served, applies, record: (yield* store.read).record };
      })
    );
    expect(result.failed.pendingApply?.operation).toBe("promote");
    expect(result.served).toMatchObject({
      releaseId: "r3-bbbbbbb",
      imageDigest: digestB,
    });
    // One apply for the replacement: no candidate stage before it.
    expect(result.applies).toEqual([2, 3]);
    expect(result.record).toMatchObject({
      active: { releaseId: "r3-bbbbbbb" },
      materialized: { releaseId: "r3-bbbbbbb" },
      previous: null,
      candidate: null,
      pendingApply: null,
    });
  });

  test("a replaced candidate whose template landed becomes the materialized template", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        faults.splitTraffic = true;
        yield* provide(deliver(shaB, digestB).pipe(Effect.exit));
        const afterB = (yield* store.read).record;
        yield* provide(deliver(shaC, digestC).pipe(Effect.exit));
        return { afterB, afterC: (yield* store.read).record };
      })
    );
    expect(result.afterB.candidate?.releaseId).toBe(
      ReleaseId.make("r4-bbbbbbb")
    );
    expect(result.afterB.materialized?.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
    expect(result.afterC.candidate?.releaseId).toBe(
      ReleaseId.make("r5-ccccccc")
    );
    expect(result.afterC.materialized?.releaseId).toBe(
      ReleaseId.make("r4-bbbbbbb")
    );
  });

  test("a worker missing after an apply is retried until it appears", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup();
        // One settle attempt reads both workers once.
        faults.missingWorkerReads = 2;
        const served = yield* provide(deliver(shaA, digestA));
        faults.missingWorkerReads = 100;
        const stuck = yield* provide(deliver(shaB, digestB).pipe(Effect.exit));
        return { served, stuck, record: (yield* store.read).record };
      })
    );
    expect(result.served.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
    expect(errorOf(result.stuck)).toMatchObject({
      _tag: "ReleaseApplyNotObserved",
      observed: {
        "tasks-worker": { servingRevision: null },
        "scheduler-worker": { servingRevision: null },
      },
    });
    // Readback that never converged keeps the intent pending, lock released.
    expect(result.record.pendingApply?.target.releaseId).toBe(
      ReleaseId.make("r4-bbbbbbb")
    );
    expect(result.record.writer).toBeNull();
  });
});

describe("declared API template", () => {
  const restoreFirst = (expectedGeneration: number) =>
    restoreRelease(
      sandboxConfig,
      { releaseId: ReleaseId.make("r1-aaaaaaa"), expectedGeneration },
      policy
    );

  test("restore over a failed template mints a fresh name and settles", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB));
        faults.failedTemplate = true;
        const before = (yield* store.read).record;
        const served = yield* provide(restoreFirst(before.generation));
        return { served, record: (yield* store.read).record };
      })
    );
    expect(result.served.revision).toBe("workspace-api-r1-aaaaaaa");
    expect(result.record.materialized).toMatchObject({
      releaseId: "r1-aaaaaaa",
      template: { revision: "workspace-api-r1-aaaaaaa-t7" },
    });
  });

  test("recovery re-applies the persisted template name", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, applies, provide } = yield* setup({
          // Generation 7 is the restore's traffic apply.
          interruptApplyOf: new Set([7]),
        });
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB));
        faults.failedTemplate = true;
        yield* provide(
          restoreFirst((yield* store.read).record.generation).pipe(Effect.exit)
        );
        const pending = (yield* store.read).record;
        yield* provide(
          unlockReleaseWriter(sandboxConfig, fingerprintOf(pending))
        );
        const recovered = yield* Effect.exit(
          provide(recoverRelease(sandboxConfig, policy))
        );
        return {
          pending,
          recovered,
          applies,
          record: (yield* store.read).record,
        };
      })
    );
    expect(result.pending.materialized?.template?.revision).toBe(
      "workspace-api-r1-aaaaaaa-t7"
    );
    // The fake interrupts every apply of generation 7, so recovery re-applies
    // the same declaration; its template keeps the persisted name.
    expect(result.applies.slice(-2)).toEqual([7, 7]);
    expect(result.record.materialized).toEqual(result.pending.materialized);
  });

  test("a plain deploy after a config change mints a template name once", async () => {
    const changed: WorkspaceStackConfig = {
      ...sandboxConfig,
      capacity: {
        ...sandboxConfig.capacity,
        apiMaxInstances: sandboxConfig.capacity.apiMaxInstances + 1,
      },
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup();
        yield* provide(deliver(shaA, digestA));
        faults.config = changed;
        yield* provide(runStack(changed, "deploy"));
        const first = (yield* store.read).record;
        yield* provide(runStack(changed, "deploy"));
        return { first, second: (yield* store.read).record };
      })
    );
    expect(result.first.materialized?.template?.revision).toBe(
      `workspace-api-r1-aaaaaaa-t${result.first.generation}`
    );
    expect(result.second.materialized).toEqual(result.first.materialized);
    expect(result.second.generation).toBe(result.first.generation);
  });

  test("recovery refuses to re-declare a landed template name from a changed spec", async () => {
    const changed: WorkspaceStackConfig = {
      ...sandboxConfig,
      capacity: {
        ...sandboxConfig.capacity,
        apiMaxInstances: sandboxConfig.capacity.apiMaxInstances + 1,
      },
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, applies, declaredTemplates, provide } =
          yield* setup();
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB));
        // The restore's API template lands, but its workers never show up.
        faults.failedTemplate = true;
        faults.missingWorkerReads = 100;
        yield* provide(
          restoreFirst((yield* store.read).record.generation).pipe(Effect.exit)
        );
        faults.failedTemplate = false;
        faults.missingWorkerReads = 0;
        const landed = (yield* store.read).record;
        // The config changes before anyone recovers.
        faults.config = changed;
        const appliesBefore = applies.length;
        const refused = yield* provide(
          recoverRelease(changed, policy).pipe(Effect.exit)
        );
        const newApplies = applies.length - appliesBefore;
        // A fresh restore decides a new template name, then settles.
        const served = yield* provide(
          restoreRelease(
            changed,
            {
              releaseId: ReleaseId.make("r1-aaaaaaa"),
              expectedGeneration: (yield* store.read).record.generation,
            },
            policy
          )
        );
        return {
          landed,
          refused,
          newApplies,
          served,
          declaredTemplates,
          record: (yield* store.read).record,
        };
      })
    );
    expect(result.landed.pendingApply?.operation).toBe("restore");
    expect(errorOf(result.refused)).toMatchObject({
      _tag: "ReleaseTemplateSpecChanged",
      revision: "workspace-api-r1-aaaaaaa-t7",
    });
    expect(result.newApplies).toBe(0);
    expect(result.served.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
    expect(result.record.materialized?.template?.revision).not.toBe(
      "workspace-api-r1-aaaaaaa-t7"
    );
    // Cloud Run never saw one revision name declared from two specs.
    const specsByName = new Map<string | undefined, Set<string | undefined>>();
    for (const { revision, specFingerprint } of result.declaredTemplates) {
      specsByName.set(
        revision,
        (specsByName.get(revision) ?? new Set()).add(specFingerprint)
      );
    }
    for (const specs of specsByName.values()) {
      expect(specs.size).toBe(1);
    }
  });

  test("recovery refuses a minted name decided for an older spec that never landed", async () => {
    const changed: WorkspaceStackConfig = {
      ...sandboxConfig,
      capacity: {
        ...sandboxConfig.capacity,
        apiMaxInstances: sandboxConfig.capacity.apiMaxInstances + 1,
      },
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, applies, declaredTemplates, provide } =
          yield* setup({ notStartedApplyOf: new Set([7]) });
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB));
        faults.failedTemplate = true;
        // The restore mints a name, but its apply never starts.
        const notStarted = yield* provide(
          restoreFirst((yield* store.read).record.generation).pipe(Effect.exit)
        );
        faults.failedTemplate = false;
        const pending = (yield* store.read).record;
        faults.config = changed;
        const appliesBefore = applies.length;
        const refused = yield* provide(
          recoverRelease(changed, policy).pipe(Effect.exit)
        );
        const newApplies = applies.length - appliesBefore;
        const stillPending = (yield* store.read).record;
        const served = yield* provide(
          restoreRelease(
            changed,
            {
              releaseId: ReleaseId.make("r1-aaaaaaa"),
              expectedGeneration: stillPending.generation,
            },
            policy
          )
        );
        return {
          notStarted,
          pending,
          refused,
          newApplies,
          stillPending,
          served,
          declaredTemplates,
          record: (yield* store.read).record,
        };
      })
    );
    expect(errorOf(result.notStarted)).toMatchObject({
      outcome: "not-started",
    });
    // The outcome was known, so the lock was released.
    expect(result.pending.writer).toBeNull();
    expect(result.pending.materialized?.template?.revision).toBe(
      "workspace-api-r1-aaaaaaa-t7"
    );
    expect(errorOf(result.refused)).toMatchObject({
      _tag: "ReleaseTemplateSpecChanged",
      revision: "workspace-api-r1-aaaaaaa-t7",
    });
    expect(result.newApplies).toBe(0);
    expect(result.stillPending.pendingApply).toEqual(
      result.pending.pendingApply
    );
    expect(result.served.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
    expect(
      result.declaredTemplates.map(({ revision }) => revision)
    ).not.toContain("workspace-api-r1-aaaaaaa-t7");
    expect(result.record.materialized?.template?.specFingerprint).toBe(
      apiTemplateSpecFingerprint(changed, digestA)
    );
  });

  test("a name the record and Cloud Run tie to different specs is never re-declared", async () => {
    const changed: WorkspaceStackConfig = {
      ...sandboxConfig,
      capacity: {
        ...sandboxConfig.capacity,
        apiMaxInstances: sandboxConfig.capacity.apiMaxInstances + 1,
      },
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, applies, declaredTemplates, provide } =
          yield* setup();
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB));
        // The restore decides its name for the sandbox spec, but the
        // template lands from another spec and the workers never show up.
        faults.failedTemplate = true;
        faults.missingWorkerReads = 100;
        faults.config = changed;
        yield* provide(
          restoreFirst((yield* store.read).record.generation).pipe(Effect.exit)
        );
        faults.failedTemplate = false;
        faults.missingWorkerReads = 0;
        const disagreeing = (yield* store.read).record;
        const appliesBefore = applies.length;
        // Recovery under the spec the record names: Cloud Run disagrees.
        faults.config = undefined;
        const recovered = yield* provide(
          recoverRelease(sandboxConfig, policy).pipe(Effect.exit)
        );
        const newApplies = applies.length - appliesBefore;
        // A restore under the live spec: the record disagrees, so it mints.
        faults.config = changed;
        const served = yield* provide(
          restoreRelease(
            changed,
            {
              releaseId: ReleaseId.make("r1-aaaaaaa"),
              expectedGeneration: (yield* store.read).record.generation,
            },
            policy
          )
        );
        return {
          disagreeing,
          recovered,
          newApplies,
          served,
          declaredTemplates,
          record: (yield* store.read).record,
        };
      })
    );
    const minted = "workspace-api-r1-aaaaaaa-t7";
    expect(result.disagreeing.materialized?.template?.revision).toBe(minted);
    expect(errorOf(result.recovered)).toMatchObject({
      _tag: "ReleaseTemplateSpecChanged",
      revision: minted,
    });
    expect(result.newApplies).toBe(0);
    expect(result.served.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
    expect(result.record.materialized?.template?.revision).not.toBe(minted);
    expect(
      result.declaredTemplates.filter(({ revision }) => revision === minted)
    ).toHaveLength(1);
  });
  /** The api max-instances change of the reviewer's capacity change. */
  const capacityChanged: WorkspaceStackConfig = {
    ...sandboxConfig,
    capacity: {
      ...sandboxConfig.capacity,
      apiMaxInstances: sandboxConfig.capacity.apiMaxInstances + 1,
    },
  };

  /** A third release whose candidate lands with the wrong digest. */
  const failCandidateVerification = (
    cloudRun: Effect.Success<ReturnType<typeof setup>>,
    config: WorkspaceStackConfig
  ) =>
    Effect.gen(function* () {
      const { store, faults, provide } = cloudRun;
      faults.resolvedDigest = digestA;
      const failed = yield* provide(
        deliverRelease(config, { sha: shaC, imageDigest: digestC }, policy)
      ).pipe(Effect.exit);
      faults.resolvedDigest = undefined;
      const pending = (yield* store.read).record;
      if (pending.writer !== null) {
        yield* provide(unlockReleaseWriter(config, fingerprintOf(pending)));
      }
      return failed;
    });

  test("restore after a failed candidate never re-declares a displaced minted template", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cloudRun = yield* setup();
        const { store, faults, declaredTemplates, provide } = cloudRun;
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB));
        faults.config = capacityChanged;
        yield* provide(runStack(capacityChanged, "deploy"));
        const minted = (yield* store.read).record.materialized?.template;
        const failed = yield* failCandidateVerification(
          cloudRun,
          capacityChanged
        );
        // The candidate displaced the minted template and is not ready.
        faults.failedTemplate = true;
        const restored = yield* provide(
          restoreRelease(
            capacityChanged,
            {
              releaseId: ReleaseId.make("r4-bbbbbbb"),
              expectedGeneration: (yield* store.read).record.generation,
            },
            policy
          )
        ).pipe(Effect.exit);
        return {
          minted,
          failed,
          restored,
          declaredTemplates,
          record: (yield* store.read).record,
        };
      })
    );
    expect(errorOf(result.failed)).toMatchObject({
      _tag: "CandidateNotVerified",
    });
    expect(result.minted?.revision).toMatch(/^workspace-api-r4-bbbbbbb-t\d+$/);
    expect(result.restored._tag).toBe("Success");
    expect(result.record.materialized?.template?.revision).toBe(
      `workspace-api-r4-bbbbbbb-t${result.record.generation - 1}`
    );
    expect(
      result.declaredTemplates.filter(
        (entry) => entry.revision === result.minted?.revision
      )
    ).toHaveLength(1);
  });

  test("a plain deploy never re-declares a staged candidate a later rollout displaced", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cloudRun = yield* setup();
        const { store, faults, declaredTemplates, provide } = cloudRun;
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB));
        const failed = yield* failCandidateVerification(
          cloudRun,
          sandboxConfig
        );
        const staged = (yield* store.read).record.candidate;
        cloudRun.rollOutExternally();
        faults.config = capacityChanged;
        const deployed = yield* provide(
          runStack(capacityChanged, "deploy")
        ).pipe(Effect.exit);
        return {
          failed,
          staged,
          deployed,
          declaredTemplates,
          record: (yield* store.read).record,
        };
      })
    );
    expect(errorOf(result.failed)).toMatchObject({
      _tag: "CandidateNotVerified",
    });
    expect(result.staged?.revision).toBe("workspace-api-r7-ccccccc");
    expect(result.deployed._tag).toBe("Success");
    expect(result.record.candidate).toBeNull();
    // Only the candidate's own verification apply declared its name.
    expect(
      result.declaredTemplates.filter(
        (entry) => entry.revision === "workspace-api-r7-ccccccc"
      )
    ).toHaveLength(1);
    expect(result.declaredTemplates.at(-1)?.revision).toBe(
      `workspace-api-r4-bbbbbbb-t${result.record.generation}`
    );
  });

  test("recovery refuses a pending template name a later rollout displaced", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cloudRun = yield* setup({
          // Generation 5 is the second release's promotion apply.
          interruptApplyOf: new Set([5]),
        });
        const { store, applies, provide } = cloudRun;
        yield* provide(deliver(shaA, digestA));
        yield* provide(deliver(shaB, digestB).pipe(Effect.exit));
        const pending = (yield* store.read).record;
        yield* provide(
          unlockReleaseWriter(sandboxConfig, fingerprintOf(pending))
        );
        cloudRun.rollOutExternally();
        const appliesBefore = applies.length;
        const recovered = yield* provide(
          recoverRelease(sandboxConfig, policy)
        ).pipe(Effect.exit);
        return { pending, recovered, applied: applies.length - appliesBefore };
      })
    );
    expect(result.pending.pendingApply?.target.revision).toBe(
      "workspace-api-r4-bbbbbbb"
    );
    expect(errorOf(result.recovered)).toMatchObject({
      _tag: "ReleaseTemplateSpecChanged",
      revision: "workspace-api-r4-bbbbbbb",
      liveSpecFingerprint: null,
    });
    expect(result.applied).toBe(0);
  });

  test("a plain run never declares a candidate whose verification apply never started", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, plannedTemplates, declaredTemplates, provide } =
          yield* setup({
            // Generation 4 stages the second release's candidate.
            notStartedApplyOf: new Set([4]),
          });
        yield* provide(deliver(shaA, digestA));
        const failed = yield* provide(deliver(shaB, digestB)).pipe(Effect.exit);
        const staged = (yield* store.read).record;
        yield* provide(runStack(sandboxConfig, "plan"));
        const deployed = yield* provide(runStack(sandboxConfig, "deploy")).pipe(
          Effect.exit
        );
        return {
          failed,
          staged,
          deployed,
          plannedTemplates,
          declaredTemplates,
          record: (yield* store.read).record,
        };
      })
    );
    expect(errorOf(result.failed)).toMatchObject({
      _tag: "ReleaseServiceApplyFailed",
      outcome: "not-started",
    });
    expect(result.staged.candidate?.revision).toBe("workspace-api-r4-bbbbbbb");
    expect(result.staged.writer).toBeNull();
    expect(result.deployed._tag).toBe("Success");
    expect(result.record.candidate).toBeNull();
    expect(result.plannedTemplates).toEqual(["workspace-api-r1-aaaaaaa"]);
    expect(
      result.declaredTemplates.map((entry) => entry.revision)
    ).not.toContain("workspace-api-r4-bbbbbbb");
    expect(result.declaredTemplates.at(-1)?.revision).toBe(
      "workspace-api-r1-aaaaaaa"
    );
  });

  test("plan previews the template the following deploy declares", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, plannedTemplates, declaredTemplates, provide } =
          yield* setup();
        yield* provide(deliver(shaA, digestA));
        faults.config = capacityChanged;
        const beforePlan = (yield* store.read).record;
        yield* provide(runStack(capacityChanged, "plan"));
        const afterPlan = (yield* store.read).record;
        yield* provide(runStack(capacityChanged, "deploy"));
        return {
          beforePlan,
          afterPlan,
          plannedTemplates,
          deployed: declaredTemplates.at(-1)?.revision,
        };
      })
    );
    expect(result.deployed).toMatch(/^workspace-api-r1-aaaaaaa-t\d+$/);
    expect(result.plannedTemplates).toEqual([result.deployed]);
    // The plan persisted nothing.
    expect({ ...result.afterPlan, writer: null }).toEqual({
      ...result.beforePlan,
      writer: null,
    });
  });
});

describe("worker readback during a rollout", () => {
  test("a worker still rolling out without a URL is retried, not drift", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, faults, provide } = yield* setup();
        // One settle attempt reads both workers once.
        faults.unsettledWorkerReads = 2;
        const served = yield* provide(deliver(shaA, digestA));
        return { served, record: (yield* store.read).record };
      })
    );
    expect(result.served.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
    expect(result.record.pendingApply).toBeNull();
  });
});

interface StackRun {
  readonly action: StackApplyRequest["action"];
  readonly declaring: ReleaseRecord;
  readonly now: DateTime.Utc;
}

/**
 * Every resource's props as the stack entry declares them from a run's
 * record, with output references (resolved only at apply) as placeholders.
 */
const declaredStackProps = async ({ declaring, now }: StackRun) => {
  const { exit, resources } = await evaluate(
    Effect.gen(function* () {
      yield* declareWorkspaceFoundation(hostedProofConfig);
      yield* declareWorkspaceServices(hostedProofConfig, declaring, now);
    })
  );
  expect(exit._tag).toBe("Success");
  return Object.fromEntries(
    Object.entries(resources).map(([id, resource]) => [
      id,
      JSON.parse(
        JSON.stringify(resource.Props, (_key, value) =>
          isOutput(value) ? "<output>" : value
        )
      ),
    ])
  );
};

describe("release plan after a release command", () => {
  test("plans no change after deliveries, an interrupted deliver, restore and a plain deploy", async () => {
    const checkpoints = await Effect.runPromise(
      Effect.gen(function* () {
        // The third delivery's staging apply (generation 7) is interrupted.
        const { store, stackRuns, faults, provide } = yield* setup({
          interruptApplyOf: new Set([7]),
        });
        // The stack declares the hosted proof's config.
        faults.config = hostedProofConfig;
        const checkpoints: Array<{
          readonly step: string;
          readonly deploy: StackRun;
          readonly plan: StackRun;
        }> = [];
        /** The last deploy run against the plan that follows it. */
        const planAfter = (step: string) =>
          Effect.gen(function* () {
            const deploy = stackRuns.findLast((run) => run.action === "deploy");
            yield* provide(runStack(hostedProofConfig, "plan"));
            const plan = stackRuns.at(-1);
            if (deploy === undefined || plan?.action !== "plan") {
              return yield* Effect.die(new Error(`no stack runs for ${step}`));
            }
            checkpoints.push({ step, deploy, plan });
          });
        const deliver = (sha: GitSha, imageDigest: ImageDigest) =>
          provide(
            deliverRelease(hostedProofConfig, { sha, imageDigest }, policy)
          );

        const first = yield* deliver(shaA, digestA);
        yield* planAfter("deliver v1");
        yield* deliver(shaB, digestB);
        yield* planAfter("deliver v2");

        const interrupted = yield* deliver(shaC, digestC).pipe(Effect.exit);
        expect(errorOf(interrupted)).toMatchObject({
          _tag: "ReleaseServiceApplyFailed",
          generation: 7,
          outcome: "unknown",
        });
        const { writer } = (yield* store.read).record;
        yield* provide(
          unlockReleaseWriter(
            hostedProofConfig,
            writer === null ? "" : writerFingerprint(writer.holderDigest)
          )
        );
        expect(yield* provide(recoverRelease(hostedProofConfig, policy))).toBe(
          null
        );
        yield* deliver(shaC, digestC);
        yield* planAfter("recovery deliver v3");
        // Two older releases are now tagged, in a different record order
        // from the one the traffic apply declared.
        expect((yield* store.read).record.compatible).toHaveLength(2);

        const { record } = yield* store.read;
        yield* provide(
          restoreRelease(
            hostedProofConfig,
            {
              releaseId: first.releaseId,
              expectedGeneration: record.generation,
            },
            policy
          )
        );
        yield* planAfter("restore v1");

        // What `release deploy` runs after the state snapshot is restored.
        yield* provide(runStack(hostedProofConfig, "deploy"));
        yield* planAfter("plain deploy");
        return checkpoints;
      })
    );

    expect(checkpoints.map((checkpoint) => checkpoint.step)).toEqual([
      "deliver v1",
      "deliver v2",
      "recovery deliver v3",
      "restore v1",
      "plain deploy",
    ]);
    for (const { step, deploy, plan } of checkpoints) {
      const applied = apiServiceProps(
        hostedProofConfig,
        deploy.declaring,
        deploy.now
      );
      const planned = apiServiceProps(
        hostedProofConfig,
        plan.declaring,
        plan.now
      );
      expect({ step, planned }).toEqual({ step, planned: applied });
      if (applied === undefined || planned === undefined) {
        throw new Error(`${step} declared no API service`);
      }
      // Alchemy's own comparison for a provider diff that defers to props.
      expect({ step, changed: havePropsChanged(applied, planned) }).toEqual({
        step,
        changed: false,
      });
      const deployedStack = await declaredStackProps(deploy);
      // The hosted proof's whole stack: three private services, no edge.
      expect(Object.keys(deployedStack)).toEqual(
        expect.arrayContaining([
          "WorkspaceApi",
          "WorkspaceTasksWorker",
          "WorkspaceSchedulerWorker",
          "FrontendApiInvoker",
          "DeployerApiInvoker",
        ])
      );
      expect({ step, stack: await declaredStackProps(plan) }).toEqual({
        step,
        stack: deployedStack,
      });
    }
  });
});
