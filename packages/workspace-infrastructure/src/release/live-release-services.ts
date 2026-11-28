import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { WorkspaceWorkload } from "../config/stack-config";
import { workspaceApiServiceId } from "../resources/workload-names";
import { ReleaseServiceReadback } from "./release-platform";
import type { ReleaseRecord } from "./release-record";

/**
 * The record names no serving release, yet a release-owned service is
 * live: the record object was deleted or reset. Nothing proceeds from it, because a
 * fresh history would skip candidate verification and drop the previous
 * release; an operator restores the object's last good version instead.
 */
export class ReleaseRecordLost extends Data.TaggedError("ReleaseRecordLost")<{
  readonly liveWorkloads: ReadonlyArray<WorkspaceWorkload>;
  readonly liveRevisions: ReadonlyArray<string>;
}> {}

/**
 * A release-owned service is still rolling out a change. No writer starts
 * or is unlocked over it: the change may come from outside the writer lock
 * or from a holder that is still running.
 */
export class ReleaseServicesReconciling extends Data.TaggedError(
  "ReleaseServicesReconciling"
)<{
  readonly workloads: ReadonlyArray<WorkspaceWorkload>;
}> {}

export const releaseWorkloads: ReadonlyArray<WorkspaceWorkload> = [
  "api",
  "tasks-worker",
  "scheduler-worker",
];

/** Every release-owned service as Cloud Run reports it now. */
export const observeReleaseServices = Effect.gen(function* () {
  const readback = yield* ReleaseServiceReadback;
  return yield* Effect.forEach(releaseWorkloads, (workload) =>
    readback
      .service(workload)
      .pipe(Effect.map((service) => ({ workload, service })))
  );
});

/**
 * Refuse a record without a serving release while the API service or
 * either worker exists. Callers run it on the record version they are about
 * to write over, so no newer record slips in between check and write.
 */
export const requireRecordCoversLiveService = Effect.fn(
  "WorkspaceRelease.requireRecordCoversLiveService"
)(function* (record: ReleaseRecord) {
  if (record.active !== null || record.pendingApply !== null) {
    return;
  }
  const live = (yield* observeReleaseServices).flatMap(
    ({ workload, service }) => (service === null ? [] : [{ workload, service }])
  );
  if (live.length > 0) {
    return yield* new ReleaseRecordLost({
      liveWorkloads: live.map(({ workload }) => workload),
      liveRevisions: live.flatMap(({ service }) =>
        service.traffic.map((entry) => entry.revision)
      ),
    });
  }
});

/** Refuse while any release-owned service reports a rollout in progress. */
export const requireQuietReleaseServices = Effect.gen(function* () {
  const reconciling = (yield* observeReleaseServices).flatMap(
    ({ workload, service }) => (service?.reconciling === true ? [workload] : [])
  );
  if (reconciling.length > 0) {
    return yield* new ReleaseServicesReconciling({ workloads: reconciling });
  }
});

/**
 * The record names revisions of another service: a record written before
 * the web service became `workspace-api`. Cloud Run revisions belong to
 * the service that created them, so the API service can never route to
 * them. Nothing proceeds from it; an operator destroys the old stack and
 * resets the record before the first API release.
 */
export class ReleaseRecordNamesOtherService extends Data.TaggedError(
  "ReleaseRecordNamesOtherService"
)<{
  readonly revisions: ReadonlyArray<string>;
}> {}

/** Every revision name the record may declare or route traffic to. */
const recordRevisions = (record: ReleaseRecord) => [
  ...[
    record.materialized,
    record.active,
    record.previous,
    record.candidate,
    record.pendingApply?.target ?? null,
    ...record.compatible,
  ].flatMap((deployment) => (deployment === null ? [] : [deployment.revision])),
  ...(record.materialized?.template === undefined
    ? []
    : [record.materialized.template.revision]),
];

/** Refuse a record naming any revision outside the API service. */
export const requireRecordNamesApiRevisions = Effect.fn(
  "WorkspaceRelease.requireRecordNamesApiRevisions"
)(function* (record: ReleaseRecord) {
  const foreign = recordRevisions(record).filter(
    (revision) => !revision.startsWith(`${workspaceApiServiceId}-`)
  );
  if (foreign.length > 0) {
    return yield* new ReleaseRecordNamesOtherService({ revisions: foreign });
  }
});
