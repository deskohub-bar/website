import { randomBytes } from "node:crypto";
import { sha256Hex } from "@deskohub/workspace-cloud-run/sha256";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  requireQuietReleaseServices,
  requireRecordCoversLiveService,
  requireRecordNamesApiRevisions,
} from "./live-release-services";
import {
  ReleaseServiceApply,
  type StackApplyRequest,
} from "./release-platform";
import { ReleaseApplyPending } from "./release-reconciler";
import {
  type ReleaseOperation,
  type ReleaseRecord,
  type ReleaseWriterLock,
  WriterDigest,
} from "./release-record";
import {
  ReleaseRecordStore,
  type StoredReleaseRecord,
} from "./release-record-store";

/**
 * Preview services stay undeclared until IAP and per-SHA worker isolation
 * exist (#1455); a preview must never get an unprotected public service.
 * Every release operation on preview refuses before it reads or writes.
 */
export class PreviewServicesUnprotected extends Data.TaggedError(
  "PreviewServicesUnprotected"
) {}

/** The short, printable name of a lock: its digest's first 12 characters. */
export const writerFingerprint = (digest: WriterDigest) => digest.slice(0, 12);

/** Another writer holds the stage, or left it in doubt. Nothing was written. */
export class ReleaseWriterBusy extends Data.TaggedError("ReleaseWriterBusy")<{
  readonly fingerprint: string;
  readonly operation: ReleaseOperation;
  readonly acquiredAt: string;
  readonly state: ReleaseWriterLock["state"];
}> {}

/**
 * The record no longer names this writer's lock: an operator unlocked it,
 * so another writer may now own the stage. The run stops without writing.
 */
export class ReleaseWriterLost extends Data.TaggedError("ReleaseWriterLost")<{
  /** The lock the record holds now, if any. */
  readonly heldFingerprint: string | null;
}> {}

/** A stack run of a release stage without a writer token. */
export class ReleaseWriterRequired extends Data.TaggedError(
  "ReleaseWriterRequired"
) {}

/**
 * The stack run's mode disagrees with the lock: a plain run (deploy, plan)
 * got a generation fence, or a fenced run (deliver, restore, recover) none.
 */
export class ReleaseWriterModeMismatch extends Data.TaggedError(
  "ReleaseWriterModeMismatch"
)<{
  readonly operation: ReleaseOperation;
  readonly generation: number | null;
}> {}

/** `unlock` named a lock the record does not hold. Nothing was cleared. */
export class ReleaseWriterNotHeld extends Data.TaggedError(
  "ReleaseWriterNotHeld"
)<{
  readonly fingerprint: string;
  readonly heldFingerprint: string | null;
}> {}

/** A writer's secret token. Only its digest is ever stored or compared. */
export interface ReleaseWriter {
  readonly token: Redacted.Redacted<string>;
  readonly holderDigest: WriterDigest;
  readonly operation: ReleaseOperation;
}

export const writerDigestOf = (token: Redacted.Redacted<string>) =>
  WriterDigest.make(sha256Hex(Redacted.value(token)));

const heldFingerprint = (record: ReleaseRecord) =>
  record.writer === null ? null : writerFingerprint(record.writer.holderDigest);

/** The record names this digest's lock, and its holder is still running. */
const holds = (record: ReleaseRecord, holderDigest: WriterDigest) =>
  record.writer?.holderDigest === holderDigest &&
  record.writer.state === "held";

const requireHeld = (record: ReleaseRecord, holderDigest: WriterDigest) =>
  holds(record, holderDigest)
    ? Effect.void
    : Effect.fail(
        new ReleaseWriterLost({ heldFingerprint: heldFingerprint(record) })
      );

const refusePreview = (config: WorkspaceStackConfig) =>
  config.stage === "preview"
    ? Effect.fail(new PreviewServicesUnprotected())
    : Effect.void;

/** The lock a running operation holds, and whether an apply is in flight. */
export class HeldReleaseWriter extends Context.Service<
  HeldReleaseWriter,
  {
    readonly writer: ReleaseWriter;
    /**
     * True from the start of an apply until its outcome is known. A run
     * that ends while it is set leaves the lock in doubt.
     */
    readonly applyInFlight: Ref.Ref<boolean>;
  }
>()("@deskohub/workspace-infrastructure/HeldReleaseWriter") {}

/**
 * Prepare to take the stage's writer lock: refuse while any lock exists,
 * while a release-owned service is rolling out, or over a lost record.
 * `take` writes the lock with a compare-and-set on the version those
 * checks read.
 */
const prepareReleaseWriter = Effect.fn("WorkspaceRelease.prepareReleaseWriter")(
  function* (config: WorkspaceStackConfig, operation: ReleaseOperation) {
    yield* refusePreview(config);
    const store = yield* ReleaseRecordStore;
    const current = yield* store.read;
    const held = current.record.writer;
    if (held !== null) {
      return yield* new ReleaseWriterBusy({
        fingerprint: writerFingerprint(held.holderDigest),
        operation: held.operation,
        acquiredAt: held.acquiredAt,
        state: held.state,
      });
    }
    yield* requireQuietReleaseServices;
    yield* requireRecordCoversLiveService(current.record);
    // A teardown may drain a stack whose record predates the API rename.
    if (operation !== "destroy") {
      yield* requireRecordNamesApiRevisions(current.record);
    }
    const token = Redacted.make(randomBytes(32).toString("hex"));
    const writer: ReleaseWriter = {
      token,
      holderDigest: writerDigestOf(token),
      operation,
    };
    const acquiredAt = DateTime.formatIso(yield* DateTime.now);
    return {
      writer,
      take: store.write(
        {
          ...current.record,
          writer: {
            holderDigest: writer.holderDigest,
            operation,
            acquiredAt,
            state: "held",
          },
        },
        current.version
      ),
    };
  }
);

/**
 * Release the lock, or mark it in doubt when an apply's outcome is
 * unknown. A lock this writer no longer holds is left alone.
 */
const releaseReleaseWriter = Effect.fn("WorkspaceRelease.releaseReleaseWriter")(
  function* (writer: ReleaseWriter, inDoubt: boolean) {
    const store = yield* ReleaseRecordStore;
    const current = yield* store.read;
    const held = current.record.writer;
    if (held === null || !holds(current.record, writer.holderDigest)) {
      return;
    }
    yield* store.write(
      {
        ...current.record,
        writer: inDoubt ? { ...held, state: "in-doubt" } : null,
      },
      current.version
    );
  }
);

/**
 * Run one operation as the stage's only writer. The lock has no expiry and
 * nothing takes it over: it is released when the operation ends with every
 * change's outcome known. An apply that failed after it started, or a run
 * interrupted or killed during one, leaves the lock blocking every writer
 * until an operator runs `unlock`.
 *
 * The lock only excludes runs that check it. A hosted workflow must run
 * each stage under a concurrency group that never cancels a run in
 * progress: a cancelled run is killed mid-apply, leaves the lock held and
 * forces a break-glass `unlock` (see `unlockReleaseWriter` for what that
 * cannot rule out).
 */
export const withReleaseWriter =
  (config: WorkspaceStackConfig, operation: ReleaseOperation) =>
  <A, E, R>(operationEffect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask(
      Effect.fn("WorkspaceRelease.withReleaseWriter")(function* (restore) {
        // The checks stay interruptible; once the lock is written, the
        // operation's end always releases it or marks it in doubt.
        const { writer, take } = yield* restore(
          prepareReleaseWriter(config, operation)
        );
        yield* take;
        const applyInFlight = yield* Ref.make(false);
        const exit = yield* Effect.exit(
          restore(
            Effect.provideService(operationEffect, HeldReleaseWriter, {
              writer,
              applyInFlight,
            })
          )
        );
        const inDoubt = yield* Ref.get(applyInFlight);
        const released = yield* Effect.exit(
          releaseReleaseWriter(writer, inDoubt)
        );
        // A failed release after a successful operation leaves the lock
        // held, so it must not be reported as a clean finish.
        if (Exit.isSuccess(exit) && Exit.isFailure(released) && !inDoubt) {
          return yield* Effect.failCause(released.cause);
        }
        return yield* exit;
      })
    );

/**
 * One release step under the writer lock: read, confirm the record still
 * names this writer's lock, decide, compare-and-set.
 */
export const runLockedReleaseStep = <A, E, R>(
  step: (
    record: ReleaseRecord
  ) => Effect.Effect<
    { readonly record: ReleaseRecord; readonly result: A },
    E,
    R
  >
) =>
  Effect.gen(function* () {
    const { writer } = yield* HeldReleaseWriter;
    const store = yield* ReleaseRecordStore;
    const current = yield* store.read;
    yield* requireHeld(current.record, writer.holderDigest);
    const { record, result } = yield* step(current.record);
    yield* store.write(record, current.version);
    return result;
  });

/**
 * Run the stack for the lock holder. Until the run's outcome is known, a
 * run that ends leaves the lock in doubt; `plan` changes nothing, so it
 * never does.
 */
export const applyAsWriter = Effect.fn("WorkspaceRelease.applyAsWriter")(
  function* (request: Omit<StackApplyRequest, "writer">) {
    const { writer, applyInFlight } = yield* HeldReleaseWriter;
    const platform = yield* ReleaseServiceApply;
    yield* Ref.set(applyInFlight, request.action === "deploy");
    const exit = yield* Effect.exit(
      platform.apply({ ...request, writer: writer.token })
    );
    const outcomeKnown = Exit.match(exit, {
      onSuccess: () => true,
      onFailure: (cause) =>
        cause.reasons.every(
          (reason) =>
            reason._tag === "Fail" && reason.error.outcome === "not-started"
        ),
    });
    if (outcomeKnown) {
      yield* Ref.set(applyInFlight, false);
    }
    return yield* exit;
  }
);

/**
 * Break-glass: clear a lock whose holder an operator has confirmed stopped
 * (its CI run or process ended). It refuses unless `fingerprint` names the
 * held lock and no release-owned service is rolling out. Returns the
 * cleared lock.
 *
 * Residual risk: writes the old holder sent before it stopped (a lost
 * response, a frozen process) can still land after the unlock and over a
 * newer decision. Cloud Run accepts a service write without an etag; the
 * old holder's Alchemy state writes and its writes to foundation resources
 * (queues, schedules, buckets, IAM, monitoring) are not fenced by the lock
 * either. Neither the quiet-readback check, the operator's confirmation
 * that the holder stopped, nor any later check can rule that out. Hosted
 * workflows keep this rare by running each stage under a concurrency group
 * that never cancels a run in progress.
 */
export const unlockReleaseWriter = Effect.fn(
  "WorkspaceRelease.unlockReleaseWriter"
)(function* (config: WorkspaceStackConfig, fingerprint: string) {
  yield* refusePreview(config);
  const store = yield* ReleaseRecordStore;
  const current = yield* store.read;
  const held = current.record.writer;
  if (held === null || writerFingerprint(held.holderDigest) !== fingerprint) {
    return yield* new ReleaseWriterNotHeld({
      fingerprint,
      heldFingerprint: heldFingerprint(current.record),
    });
  }
  yield* requireQuietReleaseServices;
  yield* store.write({ ...current.record, writer: null }, current.version);
  return describeLock(held);
});

/** A lock as an operator sees it: the fingerprint, never the digest. */
export const describeLock = ({ holderDigest, ...lock }: ReleaseWriterLock) => ({
  ...lock,
  holder: writerFingerprint(holderDigest),
});

/** The stored record as `status` prints it. */
export const describeStoredRecord = ({
  record,
  version,
}: StoredReleaseRecord) => ({
  version,
  record: {
    ...record,
    writer: record.writer === null ? null : describeLock(record.writer),
  },
});

/**
 * Check a stack run against the lock before Alchemy touches state: a stage
 * that serves releases needs the token of the lock the record holds. Preview
 * declares no release-owned services and stays lock-free (#1455). Returns
 * the record read under the lock with that lock, or null for preview.
 */
export const requireStackWriter = Effect.fn(
  "WorkspaceRelease.requireStackWriter"
)(function* (
  config: WorkspaceStackConfig,
  token: Option.Option<Redacted.Redacted<string>>
) {
  if (config.stage === "preview") {
    return null;
  }
  if (Option.isNone(token)) {
    return yield* new ReleaseWriterRequired();
  }
  const { record } = yield* (yield* ReleaseRecordStore).read;
  const lock = record.writer;
  if (lock === null || !holds(record, writerDigestOf(token.value))) {
    return yield* new ReleaseWriterLost({
      heldFingerprint: heldFingerprint(record),
    });
  }
  return { record, lock };
});

/**
 * The mode the lock grants a stack run. `deploy`, `plan` and `destroy` run
 * unfenced; `deploy` and `plan` declare the current record and refuse a generation fence (an inherited one would
 * apply a stale intent) and a pending traffic change (`recover` owns it).
 * `deliver`, `restore` and `recover` declare only the record at their
 * fenced generation.
 */
export const requireStackMode = Effect.fn("WorkspaceRelease.requireStackMode")(
  function* (
    { record, lock }: { record: ReleaseRecord; lock: ReleaseWriterLock },
    generation: number | null
  ) {
    const plain =
      lock.operation === "deploy" ||
      lock.operation === "plan" ||
      lock.operation === "destroy";
    if (plain === (generation !== null)) {
      return yield* new ReleaseWriterModeMismatch({
        operation: lock.operation,
        generation,
      });
    }
    if (plain && record.pendingApply !== null) {
      return yield* new ReleaseApplyPending({
        releaseId: record.pendingApply.target.releaseId,
      });
    }
  }
);
