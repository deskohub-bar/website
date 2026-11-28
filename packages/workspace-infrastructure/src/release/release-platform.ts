import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { ImageDigest, WorkspaceWorkload } from "../config/stack-config";
import type { ObservedService } from "../readback";

/** The live platform could not be read, so nothing about it is known. */
export class ReleaseReadbackUnavailable extends Data.TaggedError(
  "ReleaseReadbackUnavailable"
)<{
  /** The Cloud Run resource name that was read. */
  readonly resource: string;
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly reason: string;
}> {}

/** One Cloud Run revision as the platform reports it. */
export interface ObservedRevision {
  readonly revision: string;
  /** The digest Cloud Run resolved for the serving container, if any. */
  readonly imageDigest: ImageDigest | null;
  /** The revision's Ready condition succeeded. */
  readonly ready: boolean;
}

/**
 * Independent readback of the release-owned Cloud Run services. It reads
 * the live platform, never the apply tool's own result, so a stale or
 * interrupted apply shows up as drift instead of passing.
 */
export class ReleaseServiceReadback extends Context.Service<
  ReleaseServiceReadback,
  {
    /** The live service of one workload, or null while it does not exist. */
    readonly service: (
      workload: WorkspaceWorkload
    ) => Effect.Effect<ObservedService | null, ReleaseReadbackUnavailable>;
    /** One API service revision, or null when Cloud Run has none by that name. */
    readonly revision: (
      revision: string
    ) => Effect.Effect<ObservedRevision | null, ReleaseReadbackUnavailable>;
  }
>()("@deskohub/workspace-infrastructure/ReleaseServiceReadback") {}

/**
 * One run of the stack under the writer lock. `deploy` changes resources;
 * `plan` only previews them. A fenced run declares the release-owned
 * services only from the record at exactly `generation`; a plain run
 * (`generation` null) re-declares the current record.
 */
export interface StackApplyRequest {
  readonly action: "deploy" | "plan";
  readonly generation: number | null;
  /** The writer's secret token; the stack refuses to run without it. */
  readonly writer: Redacted.Redacted<string>;
}

/**
 * The stack run did not finish. `not-started` means it failed before the
 * apply process existed, so nothing changed; `unknown` means it may have
 * changed resources before it failed.
 */
export class ReleaseServiceApplyFailed extends Data.TaggedError(
  "ReleaseServiceApplyFailed"
)<{
  readonly generation: number | null;
  readonly outcome: "not-started" | "unknown";
  readonly reason: string;
}> {}

/**
 * Runs the stack for one request. A fenced run refuses a record at any
 * other generation, and applying the same generation again is idempotent.
 */
export class ReleaseServiceApply extends Context.Service<
  ReleaseServiceApply,
  {
    readonly apply: (
      request: StackApplyRequest
    ) => Effect.Effect<void, ReleaseServiceApplyFailed>;
  }
>()("@deskohub/workspace-infrastructure/ReleaseServiceApply") {}
