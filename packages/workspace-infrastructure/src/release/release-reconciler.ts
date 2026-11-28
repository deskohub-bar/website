import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { ImageDigest, WorkspaceWorkload } from "../config/stack-config";
import { workspaceApiServiceId } from "../resources/workload-names";
import {
  type CompatibleDeployment,
  compatibleDeploymentWindowHours,
  type GitSha,
  type MaterializedDeployment,
  type ReleaseDeployment,
  ReleaseId,
  type ReleaseOrigin,
  type ReleaseRecord,
  templateRevisionOf,
  type VerifiedDeployment,
} from "./release-record";

export class StaleReleaseGeneration extends Data.TaggedError(
  "StaleReleaseGeneration"
)<{
  readonly expectedGeneration: number;
  readonly currentGeneration: number;
}> {}

export class ReleaseApplyPending extends Data.TaggedError(
  "ReleaseApplyPending"
)<{
  readonly releaseId: ReleaseId;
}> {}

/** The candidate revision's readback does not match the staged release. */
export class CandidateNotVerified extends Data.TaggedError(
  "CandidateNotVerified"
)<{
  readonly releaseId: ReleaseId;
}> {}

export class NoPendingReleaseApply extends Data.TaggedError(
  "NoPendingReleaseApply"
) {}

export class ReleaseNotStaged extends Data.TaggedError("ReleaseNotStaged")<{
  readonly releaseId: ReleaseId;
}> {}

/**
 * Restore accepts only the active release, the previous one, or an
 * unexpired compatible one.
 */
export class ReleaseNotRestorable extends Data.TaggedError(
  "ReleaseNotRestorable"
)<{
  readonly releaseId: ReleaseId;
}> {}

/**
 * Readback does not show the intended target serving on the API service
 * and its image on every worker. The intent stays
 * pending and blocks every other release step: the caller re-applies the
 * same declaration (apply is idempotent) and settles again. There is no
 * abandon step until Cloud Run operation evidence can prove an interrupted
 * write can no longer land.
 */
export class ReleaseApplyNotObserved extends Data.TaggedError(
  "ReleaseApplyNotObserved"
)<{
  readonly intended: ReleaseId;
  readonly servingRevision: string | null;
  /** What each release-owned service showed; a missing one reads all null. */
  readonly observed: Readonly<Record<WorkspaceWorkload, TrafficReadback>>;
}> {}

/** What the platform actually serves, read back after an apply. */
export interface TrafficReadback {
  /** Revision taking 100% of untagged traffic, or null when split/unknown. */
  readonly servingRevision: string | null;
  readonly servingImageDigest: ImageDigest | null;
  /** The traffic generation stamped on the service, or null when absent. */
  readonly trafficGeneration: number | null;
}

/** The workers that run the serving release's image beside the API service. */
export type ReleaseWorker = Exclude<WorkspaceWorkload, "api">;

/**
 * The revision the API service's live template declares and the image
 * digest it pins, or null while the service does not exist.
 */
export interface LiveTemplate {
  readonly revision: string | null;
  readonly imageDigest: ImageDigest | null;
  /** The spec fingerprint the template was declared with, if any. */
  readonly specFingerprint: string | null;
  /** The template's own revision is ready, routed or not. */
  readonly ready: boolean;
}

/** What a step needs to decide which revision template to declare. */
export interface TemplateInput {
  /** The API service's live template, read just before the step. */
  readonly liveTemplate: LiveTemplate | null;
  /** The fingerprint of the template spec the stack declares now for an image. */
  readonly specFingerprintOf: (imageDigest: ImageDigest) => string;
}

/**
 * The live template is this deployment's, under the name the record
 * declares it, ready, and declared from the spec the stack declares now,
 * which is also the spec a minted name was decided for: re-declaring it
 * changes nothing.
 */
const keepsTemplate = (
  input: TemplateInput,
  deployment: MaterializedDeployment | null
): deployment is MaterializedDeployment =>
  input.liveTemplate !== null &&
  deployment !== null &&
  input.liveTemplate.ready &&
  input.liveTemplate.revision === templateRevisionOf(deployment) &&
  input.liveTemplate.imageDigest === deployment.imageDigest &&
  input.liveTemplate.specFingerprint ===
    input.specFingerprintOf(deployment.imageDigest) &&
  (deployment.template === undefined ||
    deployment.template.specFingerprint ===
      input.specFingerprintOf(deployment.imageDigest));

/**
 * A template for `target` under a name minted for this decision's
 * generation, for when the live one cannot be kept. Every new decision
 * mints its own name, even when an earlier one minted a name for the same
 * release and spec: that name may have landed and been displaced since, and
 * Cloud Run never re-creates a revision name with another spec. Only
 * re-applying the persisted decision (recovery) declares a name again.
 * Traffic keeps targeting the release's own revision.
 */
const freshTemplate = (
  target: ReleaseDeployment,
  generation: number,
  input: TemplateInput
): MaterializedDeployment => ({
  ...deploymentOf(target),
  template: {
    revision: `${target.revision}-t${generation}`,
    specFingerprint: input.specFingerprintOf(target.imageDigest),
  },
});

const templateIs = (
  live: LiveTemplate | null,
  deployment: ReleaseDeployment | null
): deployment is ReleaseDeployment =>
  live !== null &&
  deployment !== null &&
  live.revision === deployment.revision &&
  live.imageDigest === deployment.imageDigest;

const fence = (record: ReleaseRecord, expectedGeneration: number) =>
  record.generation === expectedGeneration
    ? Effect.void
    : Effect.fail(
        new StaleReleaseGeneration({
          expectedGeneration,
          currentGeneration: record.generation,
        })
      );

const requireNoPendingApply = (record: ReleaseRecord) =>
  record.pendingApply === null
    ? Effect.void
    : Effect.fail(
        new ReleaseApplyPending({
          releaseId: record.pendingApply.target.releaseId,
        })
      );

const isoOf = (now: DateTime.Utc) => DateTime.formatIso(now);

const unexpired = (
  compatible: ReadonlyArray<CompatibleDeployment>,
  now: DateTime.Utc
) =>
  compatible.filter((entry) =>
    DateTime.isGreaterThan(DateTime.makeUnsafe(entry.expiresAt), now)
  );

const withoutRelease = <A extends { readonly releaseId: ReleaseId }>(
  entries: ReadonlyArray<A>,
  releaseId: ReleaseId
) => entries.filter((entry) => entry.releaseId !== releaseId);

const deploymentOf = ({
  releaseId,
  sha,
  imageDigest,
  origin,
  revision,
}: ReleaseDeployment): ReleaseDeployment => ({
  releaseId,
  sha,
  imageDigest,
  origin,
  revision,
});

export interface StageInput {
  readonly expectedGeneration: number;
  readonly sha: GitSha;
  readonly imageDigest: ImageDigest;
  readonly origin: ReleaseOrigin;
  /** The API service's live template, read just before the step. */
  readonly liveTemplate: LiveTemplate | null;
  readonly now: DateTime.Utc;
}

/**
 * Record a built image as the candidate, replacing any earlier one. Its
 * release ID and Cloud Run revision name derive from the new generation, so
 * reruns never collide. A replaced candidate whose template already landed
 * becomes the materialized template, so the record never forgets the
 * revision Cloud Run runs.
 *
 * A first release whose promotion never settled is replaced instead: no
 * release has served, so there is no traffic to protect and no candidate
 * revision to verify. The new build is staged and promoted in one step
 * (`promoted`), so the record never shows "no release, nothing pending"
 * while services may exist. Any other pending change refuses the stage.
 */
export const stage = Effect.fn("WorkspaceRelease.stage")(function* (
  record: ReleaseRecord,
  input: StageInput
) {
  yield* fence(record, input.expectedGeneration);
  const generation = record.generation + 1;
  const releaseId = ReleaseId.make(`r${generation}-${input.sha.slice(0, 7)}`);
  const deployment: ReleaseDeployment = {
    releaseId,
    sha: input.sha,
    imageDigest: input.imageDigest,
    origin: input.origin,
    revision: `${workspaceApiServiceId}-${releaseId}`,
  };
  if (record.active === null && record.pendingApply?.operation === "promote") {
    return {
      releaseId,
      promoted: true,
      record: {
        ...record,
        generation,
        trafficGeneration: record.trafficGeneration + 1,
        // The unsettled release's template may already run on Cloud Run.
        materialized: templateIs(input.liveTemplate, record.candidate)
          ? deploymentOf(record.candidate)
          : record.materialized,
        candidate: deployment,
        pendingApply: {
          operation: "promote",
          target: deployment,
          trafficGeneration: record.trafficGeneration + 1,
          startedAt: isoOf(input.now),
        },
      } satisfies ReleaseRecord,
    };
  }
  yield* requireNoPendingApply(record);
  return {
    releaseId,
    promoted: false,
    record: {
      ...record,
      generation,
      materialized: templateIs(input.liveTemplate, record.candidate)
        ? deploymentOf(record.candidate)
        : record.materialized,
      candidate: deployment,
    } satisfies ReleaseRecord,
  };
});

export interface TrafficChangeInput {
  readonly expectedGeneration: number;
  readonly releaseId: ReleaseId;
  readonly now: DateTime.Utc;
}

export interface PromoteInput extends TrafficChangeInput {
  /**
   * Readback of the zero-traffic candidate revision. Required once a
   * release is active; the very first release has no traffic to protect
   * and no candidate revision before its promotion.
   */
  readonly candidateReadback: {
    readonly revision: string;
    readonly imageDigest: ImageDigest | null;
  } | null;
}

/** Persist the intent to move traffic to the verified candidate. */
export const promote = Effect.fn("WorkspaceRelease.promote")(function* (
  record: ReleaseRecord,
  input: PromoteInput
) {
  yield* fence(record, input.expectedGeneration);
  yield* requireNoPendingApply(record);
  const target = record.candidate;
  if (target === null || target.releaseId !== input.releaseId) {
    return yield* new ReleaseNotStaged({ releaseId: input.releaseId });
  }
  const verified =
    input.candidateReadback !== null &&
    input.candidateReadback.revision === target.revision &&
    input.candidateReadback.imageDigest === target.imageDigest;
  if (record.active !== null && !verified) {
    return yield* new CandidateNotVerified({ releaseId: input.releaseId });
  }
  return {
    ...record,
    generation: record.generation + 1,
    trafficGeneration: record.trafficGeneration + 1,
    pendingApply: {
      operation: "promote",
      target,
      trafficGeneration: record.trafficGeneration + 1,
      startedAt: isoOf(input.now),
    },
  } satisfies ReleaseRecord;
});

export interface RestoreInput extends TrafficChangeInput, TemplateInput {}

/**
 * The template the API service keeps once restore or a plain deploy drops
 * the candidate: the candidate or the materialized template, whichever
 * Cloud Run runs ready from the current spec. Otherwise `target`'s image
 * gets a template under a fresh name, since a failed or outdated revision
 * name can never be re-declared with another spec.
 */
const templateWithoutCandidate = (
  record: ReleaseRecord,
  input: TemplateInput,
  target: ReleaseDeployment,
  generation: number
): MaterializedDeployment => {
  if (keepsTemplate(input, record.materialized)) {
    return record.materialized;
  }
  return keepsTemplate(input, record.candidate)
    ? deploymentOf(record.candidate)
    : freshTemplate(target, generation, input);
};

/**
 * Persist the intent to move traffic back to the previous verified release,
 * a deployment still inside its compatible window, or the active release
 * itself. It supersedes a pending traffic change: only the lock holder
 * restores, so the earlier apply's outcome is known or an operator
 * unlocked it. An unverified candidate is dropped, so it loses its traffic
 * tag; the service template stays the revision Cloud Run already runs when
 * that one is ready and current.
 */
export const restore = Effect.fn("WorkspaceRelease.restore")(function* (
  record: ReleaseRecord,
  input: RestoreInput
) {
  yield* fence(record, input.expectedGeneration);
  const candidates: ReadonlyArray<VerifiedDeployment> = [
    ...(record.active === null ? [] : [record.active]),
    ...(record.previous === null ? [] : [record.previous]),
    ...unexpired(record.compatible, input.now),
  ];
  const target = candidates.find(
    (entry) => entry.releaseId === input.releaseId
  );
  if (target === undefined) {
    return yield* new ReleaseNotRestorable({ releaseId: input.releaseId });
  }
  return {
    ...record,
    materialized: templateWithoutCandidate(
      record,
      input,
      target,
      record.generation + 1
    ),
    candidate: null,
    generation: record.generation + 1,
    trafficGeneration: record.trafficGeneration + 1,
    pendingApply: {
      operation: "restore",
      target: deploymentOf(target),
      trafficGeneration: record.trafficGeneration + 1,
      startedAt: isoOf(input.now),
    },
  } satisfies ReleaseRecord;
});

export interface SettleInput {
  readonly expectedGeneration: number;
  /** The API service's traffic. */
  readonly readback: TrafficReadback;
  /** Each worker's traffic; workers run the serving release's image. */
  readonly workers: Readonly<Record<ReleaseWorker, TrafficReadback>>;
  readonly now: DateTime.Utc;
}

const servesPendingApply = (
  input: SettleInput,
  pending: NonNullable<ReleaseRecord["pendingApply"]>
) =>
  input.readback.servingRevision === pending.target.revision &&
  input.readback.servingImageDigest === pending.target.imageDigest &&
  input.readback.trafficGeneration === pending.trafficGeneration &&
  Object.values(input.workers).every(
    (worker) => worker.servingImageDigest === pending.target.imageDigest
  );

/**
 * Settle the persisted traffic intent from readback. A normal apply and a
 * recovery after an unknown apply response take the same path: only
 * readback showing the target serving completes it. Anything else keeps
 * the intent pending, because an interrupted request may still land.
 */
export const settleApply = Effect.fn("WorkspaceRelease.settleApply")(function* (
  record: ReleaseRecord,
  input: SettleInput
) {
  yield* fence(record, input.expectedGeneration);
  const pending = record.pendingApply;
  if (pending === null) {
    return yield* new NoPendingReleaseApply();
  }
  const generation = record.generation + 1;
  if (
    servesPendingApply(input, pending) &&
    pending.target.releaseId === record.active?.releaseId
  ) {
    // Restoring the active release only re-asserts its traffic.
    return {
      ...record,
      generation,
      pendingApply: null,
    } satisfies ReleaseRecord;
  }
  if (servesPendingApply(input, pending)) {
    const verified: VerifiedDeployment = {
      ...pending.target,
      verifiedAt: isoOf(input.now),
    };
    const demoted: ReadonlyArray<CompatibleDeployment> =
      record.active === null
        ? []
        : [
            {
              ...record.active,
              expiresAt: isoOf(
                DateTime.addDuration(
                  input.now,
                  Duration.hours(compatibleDeploymentWindowHours)
                )
              ),
            },
          ];
    const keptCompatible = withoutRelease(
      unexpired(record.compatible, input.now),
      pending.target.releaseId
    );
    return {
      generation,
      trafficGeneration: record.trafficGeneration,
      // The first release creates the template; later ones were candidates.
      materialized:
        record.materialized === null ||
        record.candidate?.releaseId === pending.target.releaseId
          ? pending.target
          : record.materialized,
      active: verified,
      previous: record.active,
      candidate:
        record.candidate?.releaseId === pending.target.releaseId
          ? null
          : record.candidate,
      compatible: [
        ...(record.active === null
          ? keptCompatible
          : withoutRelease(keptCompatible, record.active.releaseId)),
        ...demoted,
      ],
      pendingApply: null,
      writer: record.writer,
    } satisfies ReleaseRecord;
  }
  return yield* new ReleaseApplyNotObserved({
    intended: pending.target.releaseId,
    servingRevision: input.readback.servingRevision,
    observed: { api: input.readback, ...input.workers },
  });
});

export interface RefreshTemplateInput extends TemplateInput {
  readonly expectedGeneration: number;
}

/**
 * Decide the template a plain deploy declares, before it runs. It keeps
 * the template Cloud Run runs when that is ready and current. A staged
 * candidate is always dropped: only its own verification apply may declare
 * its name, and a plain deploy only ever finds one a failed delivery left.
 * The API service then keeps the candidate or materialized template Cloud
 * Run runs ready from the current spec, else the active release's image
 * gets a template under a fresh name.
 */
export const refreshTemplate = Effect.fn("WorkspaceRelease.refreshTemplate")(
  function* (record: ReleaseRecord, input: RefreshTemplateInput) {
    yield* fence(record, input.expectedGeneration);
    yield* requireNoPendingApply(record);
    const active = record.active;
    if (
      active === null ||
      (record.candidate === null && keepsTemplate(input, record.materialized))
    ) {
      return record;
    }
    const generation = record.generation + 1;
    return {
      ...record,
      generation,
      materialized: templateWithoutCandidate(record, input, active, generation),
      candidate: null,
    } satisfies ReleaseRecord;
  }
);

/** Revisions traffic may route to now: serving, pending and compatible. */
export const routableDeployments = (
  record: ReleaseRecord,
  now: DateTime.Utc
): ReadonlyArray<ReleaseDeployment> => {
  const entries: ReadonlyArray<ReleaseDeployment> = [
    ...(record.pendingApply === null ? [] : [record.pendingApply.target]),
    ...(record.active === null ? [] : [record.active]),
    ...unexpired(record.compatible, now),
  ];
  return entries
    .filter(
      (entry, index) =>
        entries.findIndex((other) => other.releaseId === entry.releaseId) ===
        index
    )
    .map(deploymentOf);
};
