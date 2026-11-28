import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ImageDigest } from "../config/stack-config";

/**
 * How long a demoted deployment stays routable for pages it already served:
 * the Next asset and Server Action skew window (#1458).
 */
export const compatibleDeploymentWindowHours = 12;

export const ReleaseId = Schema.String.check(
  Schema.isPattern(/^r[0-9]{1,9}-[0-9a-f]{7}$/)
).pipe(
  Schema.brand("ReleaseId"),
  Schema.annotate({
    identifier: "ReleaseId",
    description:
      "A release: the generation that staged it and the short commit SHA.",
  })
);
export type ReleaseId = typeof ReleaseId.Type;

export const GitSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}$/)
).pipe(
  Schema.brand("GitSha"),
  Schema.annotate({ identifier: "GitSha", description: "A full commit SHA." })
);
export type GitSha = typeof GitSha.Type;

/**
 * Where a release serves from. Only Cloud Run is verifiable from revision
 * and digest readback; the Vercel bridge (#1458) joins when it has its own
 * readback.
 */
export const ReleaseOrigin = Schema.Literals(["cloud-run"]);
export type ReleaseOrigin = typeof ReleaseOrigin.Type;

const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
);

export const ReleaseDeployment = Schema.Struct({
  releaseId: ReleaseId,
  sha: GitSha,
  imageDigest: ImageDigest,
  origin: ReleaseOrigin,
  /** The Cloud Run revision name the release creates. */
  revision: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/)),
}).annotate({ identifier: "ReleaseDeployment" });
export type ReleaseDeployment = typeof ReleaseDeployment.Type;

/**
 * A revision template the record declared under its own name instead of
 * the release's revision: Cloud Run's template under the release's name
 * failed or was declared from an older spec, and a revision name can never
 * be re-declared with a different spec.
 */
export const DeclaredTemplate = Schema.Struct({
  revision: ReleaseDeployment.fields.revision,
  /** The fingerprint of the template spec the name was minted for. */
  specFingerprint: Schema.String,
}).annotate({ identifier: "DeclaredTemplate" });
export type DeclaredTemplate = typeof DeclaredTemplate.Type;

/**
 * The deployment whose image the API template runs. Without `template`, the
 * template is declared under the deployment's own revision name.
 */
export const MaterializedDeployment = Schema.Struct({
  ...ReleaseDeployment.fields,
  template: Schema.optionalKey(DeclaredTemplate),
}).annotate({ identifier: "MaterializedDeployment" });
export type MaterializedDeployment = typeof MaterializedDeployment.Type;

/** The revision name the API template is declared under. */
export const templateRevisionOf = (deployment: MaterializedDeployment) =>
  deployment.template?.revision ?? deployment.revision;

export const VerifiedDeployment = Schema.Struct({
  ...ReleaseDeployment.fields,
  /** When traffic readback confirmed the release served. */
  verifiedAt: Instant,
}).annotate({ identifier: "VerifiedDeployment" });
export type VerifiedDeployment = typeof VerifiedDeployment.Type;

export const CompatibleDeployment = Schema.Struct({
  ...VerifiedDeployment.fields,
  /** End of the window in which already-open pages may still reach it. */
  expiresAt: Instant,
}).annotate({ identifier: "CompatibleDeployment" });
export type CompatibleDeployment = typeof CompatibleDeployment.Type;

/**
 * A traffic change persisted before it is applied. If the run dies, the
 * next reconciler finds it and settles it from readback.
 */
export const PendingApply = Schema.Struct({
  operation: Schema.Literals(["promote", "restore"]),
  target: ReleaseDeployment,
  /** The traffic generation the apply writes to the service. */
  trafficGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  startedAt: Instant,
}).annotate({ identifier: "PendingApply" });
export type PendingApply = typeof PendingApply.Type;

/** What a writer holds the release lock for. */
export const ReleaseOperation = Schema.Literals([
  "deliver",
  "restore",
  "recover",
  "deploy",
  "plan",
  // Tears the whole stack down; it declares nothing from the record.
  "destroy",
]);
export type ReleaseOperation = typeof ReleaseOperation.Type;

/** The sha256 hex digest of a writer's secret token. */
export const WriterDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/)
).pipe(
  Schema.brand("WriterDigest"),
  Schema.annotate({
    identifier: "WriterDigest",
    description: "The sha256 digest of the token a release writer holds.",
  })
);
export type WriterDigest = typeof WriterDigest.Type;

/**
 * The one writer allowed to change the stage's release record or its
 * services. Only its token's digest is stored. `in-doubt` marks a holder
 * whose apply ended without a known outcome; like a held lock it blocks
 * every writer until an operator unlocks it.
 */
export const ReleaseWriterLock = Schema.Struct({
  holderDigest: WriterDigest,
  operation: ReleaseOperation,
  acquiredAt: Instant,
  state: Schema.Literals(["held", "in-doubt"]),
}).annotate({ identifier: "ReleaseWriterLock" });
export type ReleaseWriterLock = typeof ReleaseWriterLock.Type;

/**
 * The authoritative Workspace release record. It lives outside the CI run
 * and every release decision advances `generation`, so a run holding an
 * older generation cannot overwrite a newer decision. Taking or releasing
 * the writer lock changes the store version only.
 */
export const ReleaseRecord = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * Advances only when traffic is meant to change. Every service apply
   * stamps it on the service, so readback can tell a delayed write from an
   * older run apart from the current intent.
   */
  trafficGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * The revision template Cloud Run last created. Promote and restore keep
   * it, so they change traffic only and never re-create a revision.
   */
  materialized: Schema.NullOr(MaterializedDeployment),
  active: Schema.NullOr(VerifiedDeployment),
  previous: Schema.NullOr(VerifiedDeployment),
  /**
   * The one staged release. Once a release is active, the API service
   * materializes the candidate as a zero-traffic revision for verification.
   */
  candidate: Schema.NullOr(ReleaseDeployment),
  compatible: Schema.Array(CompatibleDeployment),
  pendingApply: Schema.NullOr(PendingApply),
  /** Records written before the lock existed decode with no writer. */
  writer: Schema.NullOr(ReleaseWriterLock).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
}).annotate({ identifier: "ReleaseRecord" });
export type ReleaseRecord = typeof ReleaseRecord.Type;

export const emptyReleaseRecord: ReleaseRecord = {
  generation: 0,
  trafficGeneration: 0,
  materialized: null,
  active: null,
  previous: null,
  candidate: null,
  compatible: [],
  pendingApply: null,
  writer: null,
};
