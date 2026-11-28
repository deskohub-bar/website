import "server-only";

import {
  type AutomationActivationType as AutomationActivation,
  type AutomationDetailType as AutomationDetail,
  type AutomationFlowType as AutomationFlow,
  type AutomationTriggerType as AutomationTrigger,
  type AutomationVersionDetailType as AutomationVersionDetail,
  type AutomationVersionSummaryType as AutomationVersionSummary,
  AutomationFlow as automationFlowContractSchema,
  requiredEmailLocale,
} from "@deskohub/workspace-admin-api";
import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { toStoredInstant } from "@/db/instant";
import {
  emailCampaignAudiences,
  emailCampaignAutomationPreviews,
  emailCampaignAutomationRuns,
  emailCampaignAutomationScheduleFires,
  emailCampaignAutomations,
  emailCampaignAutomationVersionProvenance,
  emailCampaignAutomationVersions,
  emailCampaignAutomationWorkUnits,
  emailCampaigns,
} from "@/db/schema";
import { authUser } from "@/db/schema/auth";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import { WorkspaceLocks } from "@/db/workspace-locks";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { getPassReminderDueAt } from "@/features/passes/pass-reminder-schedule";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import type { AudienceFilter } from "../../audience-filter";
import { ensureSavedAudienceFilter } from "../../audience-filter-usage";
import {
  lockCampaignEmailPublication,
  validatePublishedEmailForAutomationTrigger,
} from "../../backend/campaign-published-email";
import type {
  CampaignLocalizedContent,
  CampaignPurpose,
  CampaignTemplateKey,
} from "../../body/campaign-content";
import { writeCampaignContent } from "../../body/campaign-content-codec";
import {
  hashCampaignContent,
  hashCampaignEmailVersion,
} from "../../body/campaign-content-hash";
import type {
  CampaignAudienceId,
  CampaignId,
} from "../../campaign-identifiers";
import {
  type AudienceFilterContextInvalid,
  CampaignAudienceArchived,
  type CampaignDeliveryMismatch,
  CampaignFallbackContentMissing,
  type CampaignNotFound,
} from "../../errors";
import { campaignContentCoversAudience } from "../../recipient-locale";
import type { AutomationDraftHash } from "../automation-draft-hash";
import {
  automationFlowReferences,
  validateAutomationFlow,
} from "../automation-flow";
import type {
  AutomationPreviewId,
  AutomationVersionId,
} from "../automation-identifiers";
import {
  automationTriggerSummary,
  isPassReminderTrigger,
} from "../automation-triggers";
import { nextFireAfter } from "../automation-versions";
import {
  AutomationArchived,
  type AutomationCalendarNeverOccurs,
  AutomationDraftChanged,
  AutomationFlowInvalid,
  AutomationPreviewRequired,
  type AutomationScheduleMinutesNotAllowed,
  AutomationStatusConflict,
  AutomationTriggerInUse,
  AutomationVersionNotFound,
} from "../errors";
import { lockAutomationForLifecycle } from "./automation-lifecycle-lock";
import { nextPassReminderPreviewOccurrence } from "./automation-pass-reminder-preview";
import { closePreview } from "./automation-previews";
import { AutomationRunTransitions } from "./automation-run-transitions";
import { releaseAutomationUnitSubjects } from "./automation-unit-planning";
import { loadAutomationVersionActivations } from "./automation-version-activations";
import {
  type AutomationWorkingCopy,
  loadAutomationWorkingCopy,
} from "./automation-working-copy";
import {
  ensurePassReminderPurpose,
  ensurePassReminderWritesAllowed,
} from "./pass-reminder-write-policy";

type WorkingCopyError =
  | CampaignNotFound
  | CampaignDeliveryMismatch
  | AutomationFlowInvalid
  | DatabaseQueryError;

type FlowValidationError =
  | AutomationFlowInvalid
  | AutomationScheduleMinutesNotAllowed
  | AutomationCalendarNeverOccurs;

type AutomationActivationError =
  | WorkingCopyError
  | FlowValidationError
  | AutomationArchived
  | AutomationPreviewRequired
  | AutomationDraftChanged
  | AutomationTriggerInUse
  | CampaignAudienceArchived
  | AudienceFilterContextInvalid
  | CampaignFallbackContentMissing;

export interface IAutomationLifecycle {
  /** The automation's lifecycle, working copy and activation readiness. */
  readonly get: (
    campaignId: CampaignId
  ) => Effect.Effect<AutomationDetail, WorkingCopyError>;
  /**
   * Replaces the working copy with the validated, canonical flow. Any
   * status but archived can be edited; published versions never change.
   */
  readonly updateFlow: (input: {
    readonly campaignId: CampaignId;
    readonly flow: AutomationFlow;
  }) => Effect.Effect<
    AutomationDetail,
    WorkingCopyError | FlowValidationError | AutomationArchived
  >;
  /**
   * Publishes the working copy that a completed dry run of this campaign
   * evaluated (design §7.5). A retry returns the version it published.
   */
  readonly activate: (input: {
    readonly campaignId: CampaignId;
    readonly previewId: AutomationPreviewId;
    /** The administrator activating; null when the account is unknown. */
    readonly activatedBy: CustomerAccountId | null;
  }) => Effect.Effect<AutomationVersionSummary, AutomationActivationError>;
  /** Active → paused (D12); repeating it returns the current state. */
  readonly pause: (
    campaignId: CampaignId
  ) => Effect.Effect<
    AutomationDetail,
    WorkingCopyError | AutomationArchived | AutomationStatusConflict
  >;
  /** Paused → active (D12); repeating it returns the current state. */
  readonly resume: (
    campaignId: CampaignId
  ) => Effect.Effect<
    AutomationDetail,
    | WorkingCopyError
    | AutomationArchived
    | AutomationStatusConflict
    | AutomationTriggerInUse
  >;
  /**
   * Any status → archived, for good (D12); active runs end `archived`.
   * Repeating it returns the current state.
   */
  readonly archive: (
    campaignId: CampaignId
  ) => Effect.Effect<AutomationDetail, WorkingCopyError>;
  /** Published versions, newest first. */
  readonly listVersions: (
    campaignId: CampaignId
  ) => Effect.Effect<readonly AutomationVersionSummary[], WorkingCopyError>;
  readonly getVersion: (input: {
    readonly campaignId: CampaignId;
    readonly versionNumber: number;
  }) => Effect.Effect<
    AutomationVersionDetail,
    WorkingCopyError | AutomationVersionNotFound
  >;
}

/**
 * The lifecycle of automated campaigns: edits to the working copy,
 * activation behind the dry-run gate, pause, resume and archive. It's the
 * only writer of an automated campaign's `status`, always under the
 * lifecycle lock (§5.4).
 */
export class AutomationLifecycle extends Context.Service<
  AutomationLifecycle,
  IAutomationLifecycle
>()("@deskohub-workspace/email-campaigns/AutomationLifecycle") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db, transaction } = yield* WorkspaceDatabase;

      const get = Effect.fn("AutomationLifecycle.get")(function* (
        campaignId: CampaignId
      ) {
        return yield* transaction(readDetail(campaignId));
      });

      const updateFlow = Effect.fn("AutomationLifecycle.updateFlow")(
        function* (input: {
          readonly campaignId: CampaignId;
          readonly flow: AutomationFlow;
        }) {
          return yield* transaction(
            Effect.Do.pipe(
              Effect.tap(() => lockAutomationForLifecycle(input.campaignId)),
              Effect.bind("copy", () =>
                loadAutomationWorkingCopy(input.campaignId)
              ),
              Effect.tap(({ copy }) => ensureNotArchived(copy)),
              Effect.bind("flow", ({ copy }) =>
                validateEditableFlow(input.flow, copy.campaign.purpose)
              ),
              Effect.tap(({ flow }) =>
                db
                  .update(emailCampaignAutomations)
                  .set({ flow, updatedAt: sql`now()` })
                  .where(
                    eq(emailCampaignAutomations.campaignId, input.campaignId)
                  )
              ),
              Effect.flatMap(() => readDetail(input.campaignId))
            )
          );
        }
      );

      const activate = Effect.fn("AutomationLifecycle.activate")(
        function* (input: {
          readonly campaignId: CampaignId;
          readonly previewId: AutomationPreviewId;
          readonly activatedBy: CustomerAccountId | null;
        }) {
          return yield* transaction(activateIn(input));
        }
      );

      const transition = <E>(
        name: string,
        apply: (
          input: TransitionInput
        ) => Effect.Effect<void, DatabaseQueryError | E, WorkspaceTransaction>
      ) =>
        Effect.fn(name)(function* (campaignId: CampaignId) {
          return yield* transaction(
            Effect.Do.pipe(
              Effect.tap(() => lockAutomationForLifecycle(campaignId)),
              // Sampled under the lock, so no engine commit that held it
              // first can postdate the operation (§5.4).
              Effect.bind("now", () => lifecycleInstant),
              Effect.bind("copy", () => loadAutomationWorkingCopy(campaignId)),
              Effect.tap(({ copy, now }) => apply({ copy, now })),
              Effect.flatMap(() => readDetail(campaignId))
            )
          );
        });

      const listVersions = Effect.fn("AutomationLifecycle.listVersions")(
        function* (campaignId: CampaignId) {
          return yield* transaction(
            loadAutomationWorkingCopy(campaignId).pipe(
              Effect.flatMap((copy) =>
                selectVersions({
                  campaignId,
                  activeVersionId: copy.automation.activeVersionId,
                })
              ),
              Effect.map((versions) => versions.map(toVersionSummary))
            )
          );
        }
      );

      const getVersion = Effect.fn("AutomationLifecycle.getVersion")(
        function* (input: {
          readonly campaignId: CampaignId;
          readonly versionNumber: number;
        }) {
          return yield* transaction(
            loadAutomationWorkingCopy(input.campaignId).pipe(
              Effect.flatMap((copy) =>
                selectVersions({
                  campaignId: input.campaignId,
                  activeVersionId: copy.automation.activeVersionId,
                  versionNumber: input.versionNumber,
                })
              ),
              Effect.flatMap(([version]) =>
                version === undefined
                  ? Effect.fail(new AutomationVersionNotFound(input))
                  : Effect.succeed(toVersionDetail(version))
              )
            )
          );
        }
      );

      return {
        get,
        updateFlow,
        activate,
        pause: transition("AutomationLifecycle.pause", pauseIn),
        resume: transition("AutomationLifecycle.resume", resumeIn),
        archive: transition("AutomationLifecycle.archive", archiveIn),
        listVersions,
        getVersion,
      } satisfies IAutomationLifecycle;
    })
  );

  static Live = this.Default.pipe(Layer.provide(WorkspaceDatabase.Default));
}

/** The instant a lifecycle operation records, at microsecond precision. */
const lifecycleInstant = Effect.map(currentInstant, toStoredInstant);

// --- Activation (§7.5) ------------------------------------------------------

const activateIn = (input: {
  readonly campaignId: CampaignId;
  readonly previewId: AutomationPreviewId;
  readonly activatedBy: CustomerAccountId | null;
}) =>
  Effect.Do.pipe(
    // 1. The lifecycle lock, then the instant and working copy as of its
    // grant: an occurrence a unit committed under v1 while this waited
    // precedes `activated_at` (§5.10).
    Effect.tap(() => lockAutomationForLifecycle(input.campaignId)),
    Effect.bind("now", () => lifecycleInstant),
    Effect.bind("copy", () => loadAutomationWorkingCopy(input.campaignId)),
    Effect.tap(({ copy }) => ensureNotArchived(copy)),
    // 2. A completed dry run of this campaign.
    Effect.bind("preview", () => completedPreview(input)),
    // 3. Of the current draft.
    Effect.bind("publishable", ({ copy, preview }) =>
      currentPublishable(copy).pipe(
        Option.filter(({ draftHash }) => draftHash === preview.draftHash),
        Option.match({
          onNone: () =>
            Effect.fail(
              new AutomationDraftChanged({
                campaignId: input.campaignId,
                previewId: input.previewId,
              })
            ),
          onSome: Effect.succeed,
        })
      )
    ),
    // 4. Still publishable.
    Effect.bind("flow", ({ copy, publishable }) =>
      validateActivation({ copy, publishable, previewId: input.previewId })
    ),
    // 5. A retry returns the version it published.
    Effect.bind("latest", () => latestVersion(input.campaignId)),
    Effect.flatMap(
      ({
        copy,
        publishable,
        flow,
        latest,
        now,
        preview,
      }): Effect.Effect<
        AutomationVersionId,
        AutomationPreviewRequired | AutomationTriggerInUse | DatabaseQueryError,
        WorkspaceTransaction
      > => {
        if (
          Option.isSome(latest) &&
          latest.value.draftHash === publishable.draftHash
        ) {
          return Effect.succeed(latest.value.id);
        }
        if (!previewIsCurrent(flow, preview.asOf, now)) {
          return Effect.fail(new AutomationPreviewRequired(input));
        }
        const ownership =
          copy.campaign.status === "paused"
            ? Effect.succeed({ at: now, available: true })
            : passReminderOwnership(input.campaignId, flow.trigger, now);
        return ownership.pipe(
          Effect.map(({ at, available }) => ({
            at: nextVersionActivationTime(latest, at),
            available,
          })),
          Effect.filterOrFail(
            ({ at }) => previewIsCurrent(flow, preview.asOf, at),
            () => new AutomationPreviewRequired(input)
          ),
          Effect.flatMap(requirePassReminderOwnership(input.campaignId)),
          Effect.flatMap((activatedAt) =>
            publishVersion({
              copy,
              publishable,
              flow,
              latest,
              activatedBy: input.activatedBy,
              activatedAt,
            })
          )
        );
      }
    ),
    Effect.flatMap((versionId) =>
      selectVersions({
        campaignId: input.campaignId,
        activeVersionId: versionId,
        versionId,
      })
    ),
    Effect.flatMap(([version]) =>
      version === undefined
        ? Effect.die(
            new Error("The activated version vanished in its transaction.")
          )
        : Effect.succeed(toVersionSummary(version))
    )
  );

const previewIsCurrent = (
  flow: AutomationFlow,
  asOf: Temporal.Instant,
  now: Temporal.Instant
) =>
  !isPassReminderTrigger(flow.trigger) ||
  nextPassReminderPreviewOccurrence(flow.trigger, now).fireAt.equals(asOf);

/** Check the published owner after the lock wait, in a fresh statement snapshot. */
const passReminderOwnership = Effect.fn(
  "AutomationLifecycle.passReminderOwnership"
)(function* (
  campaignId: CampaignId,
  trigger: AutomationTrigger,
  now: Temporal.Instant
) {
  if (!isPassReminderTrigger(trigger)) return { at: now, available: true };
  const { db } = yield* WorkspaceTransaction;
  yield* WorkspaceLocks.passReminderCampaign(trigger._tag);
  const [owner] = yield* db
    .select({ id: emailCampaignAutomations.campaignId })
    .from(emailCampaignAutomations)
    .innerJoin(
      emailCampaigns,
      eq(emailCampaigns.id, emailCampaignAutomations.campaignId)
    )
    .innerJoin(
      emailCampaignAutomationVersions,
      eq(
        emailCampaignAutomationVersions.id,
        emailCampaignAutomations.activeVersionId
      )
    )
    .where(
      and(
        ne(emailCampaignAutomations.campaignId, campaignId),
        eq(emailCampaigns.status, "active"),
        eq(emailCampaignAutomationVersions.purpose, "marketing"),
        eq(emailCampaignAutomationVersions.triggerKind, trigger._tag)
      )
    )
    .limit(1);
  // Read the time after the wait. A campaign must start accepting before
  // 10:00 Prague time to enter that day's fire.
  const at = yield* lifecycleInstant;
  const dueAt = getPassReminderDueAt(
    plainDateStringSchema.make(getWorkspaceDate(at).toString())
  );
  return {
    at: at.equals(dueAt) ? at.add({ microseconds: 1 }) : at,
    available: owner === undefined,
  };
});

const requirePassReminderOwnership =
  (campaignId: CampaignId) =>
  (ownership: { readonly at: Temporal.Instant; readonly available: boolean }) =>
    ownership.available
      ? Effect.succeed(ownership.at)
      : Effect.fail(new AutomationTriggerInUse({ campaignId }));

/** The named dry run if it's a completed one for this campaign. */
const completedPreview = (input: {
  readonly campaignId: CampaignId;
  readonly previewId: AutomationPreviewId;
}) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    db
      .select({
        draftHash: emailCampaignAutomationPreviews.draftHash,
        asOf: emailCampaignAutomationPreviews.asOf,
      })
      .from(emailCampaignAutomationPreviews)
      .where(
        and(
          eq(emailCampaignAutomationPreviews.id, input.previewId),
          eq(emailCampaignAutomationPreviews.campaignId, input.campaignId),
          eq(emailCampaignAutomationPreviews.status, "completed")
        )
      )
      .pipe(
        Effect.flatMap(([preview]) =>
          preview === undefined
            ? Effect.fail(new AutomationPreviewRequired(input))
            : Effect.succeed(preview)
        )
      )
  );

type Publishable = {
  readonly flow: AutomationFlow;
  readonly audience: NonNullable<
    Option.Option.Value<AutomationWorkingCopy["audience"]>
  >;
  readonly draftHash: AutomationDraftHash;
};

const currentPublishable = (
  copy: AutomationWorkingCopy
): Option.Option<Publishable> =>
  Option.all({
    flow: copy.flow,
    audience: copy.audience,
    draftHash: copy.draftHash,
  });

/**
 * Step 4: a non-archived audience, content covering it with the one-off
 * rules, a valid flow whose calendars occur, and every referenced audience
 * and campaign present. Returns the canonical flow to publish.
 */
const validateActivation = (input: {
  readonly copy: AutomationWorkingCopy;
  readonly publishable: Publishable;
  readonly previewId: AutomationPreviewId;
}) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      input.publishable.audience.archivedAt === null
        ? Effect.void
        : Effect.fail(
            new CampaignAudienceArchived({
              audienceId: input.publishable.audience.id,
            })
          )
    ),
    Effect.tap(() =>
      ensureSavedAudienceFilter(input.publishable.audience.filter)
    ),
    Effect.tap(
      Effect.fnUntraced(function* () {
        if (input.copy.campaign.emailId === null) {
          if (
            !campaignContentCoversAudience({
              content: input.copy.campaign.content,
              audienceFilter: Option.some(input.publishable.audience.filter),
            })
          ) {
            return yield* Effect.fail(
              new CampaignFallbackContentMissing({
                campaignId: input.copy.campaign.id,
              })
            );
          }
          return;
        }
        const publication = yield* lockCampaignEmailPublication(
          input.copy.campaign.emailId
        );
        if (
          !publication ||
          !Option.exists(
            input.copy.publishedEmail,
            ({ versionId }) => versionId === publication.versionId
          )
        ) {
          return yield* Effect.fail(
            new AutomationDraftChanged({
              campaignId: input.copy.campaign.id,
              previewId: input.previewId,
            })
          );
        }
        if (
          !Object.hasOwn(publication.document.translations, requiredEmailLocale)
        ) {
          return yield* Effect.fail(
            new CampaignFallbackContentMissing({
              campaignId: input.copy.campaign.id,
            })
          );
        }
        yield* validatePublishedEmailForAutomationTrigger(
          publication.document,
          input.publishable.flow.trigger
        );
      })
    ),
    Effect.flatMap(() =>
      validatePublishableFlow(
        input.publishable.flow,
        input.copy.campaign.purpose
      )
    )
  );

/** Draft flow rules (§2, §3.3, §4.5) plus the database check of its references. */
const validateEditableFlow = (flow: AutomationFlow, purpose: CampaignPurpose) =>
  ensurePassReminderPurpose(flow.trigger, purpose).pipe(
    Effect.andThen(validateAutomationFlow(flow)),
    Effect.tap((validated) => ensureReferencesExist(validated))
  );

/** Publishing also requires the pass reminder release gate to be globally open. */
const validatePublishableFlow = (
  flow: AutomationFlow,
  purpose: CampaignPurpose
) =>
  ensurePassReminderWritesAllowed(flow.trigger, purpose).pipe(
    Effect.andThen(validateEditableFlow(flow, purpose))
  );

const ensureReferencesExist = (flow: AutomationFlow) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) => {
    const { savedAudienceIds, campaignIds } = automationFlowReferences(flow);
    return Effect.all({
      audiences:
        savedAudienceIds.length === 0
          ? Effect.succeed([])
          : db
              .select({ id: emailCampaignAudiences.id })
              .from(emailCampaignAudiences)
              .where(inArray(emailCampaignAudiences.id, [...savedAudienceIds]))
              // Held until commit, so deleting a referenced audience waits
              // for this write and then sees the reference (audience-in-use).
              .for("share"),
      campaigns:
        campaignIds.length === 0
          ? Effect.succeed([])
          : db
              .select({ id: emailCampaigns.id })
              .from(emailCampaigns)
              .where(inArray(emailCampaigns.id, [...campaignIds])),
    }).pipe(
      Effect.flatMap(({ audiences, campaigns }) => {
        const missingAudiences = missingIds(savedAudienceIds, audiences);
        const missingCampaigns = missingIds(campaignIds, campaigns);
        return missingAudiences.length === 0 && missingCampaigns.length === 0
          ? Effect.void
          : Effect.fail(
              new AutomationFlowInvalid({
                message: [
                  missingAudiences.length > 0 &&
                    `The flow's conditions name saved audiences that don't exist: ${missingAudiences.join(", ")}.`,
                  missingCampaigns.length > 0 &&
                    `The flow's conditions name campaigns that don't exist: ${missingCampaigns.join(", ")}.`,
                ]
                  .filter(Boolean)
                  .join(" "),
              })
            );
      })
    );
  });

const missingIds = <Id extends string>(
  wanted: readonly Id[],
  found: readonly { readonly id: Id }[]
) => {
  const present = new Set<string>(found.map(({ id }) => id));
  return wanted.filter((id) => !present.has(id));
};

const latestVersion = (campaignId: CampaignId) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    db
      .select({
        id: emailCampaignAutomationVersions.id,
        versionNumber: emailCampaignAutomationVersions.versionNumber,
        draftHash: emailCampaignAutomationVersions.draftHash,
        activatedAt: emailCampaignAutomationVersions.activatedAt,
      })
      .from(emailCampaignAutomationVersions)
      .where(eq(emailCampaignAutomationVersions.campaignId, campaignId))
      .orderBy(desc(emailCampaignAutomationVersions.versionNumber))
      .limit(1)
      .pipe(Effect.map(([version]) => Option.fromNullishOr(version)))
  );

/** Activation time orders published versions, including across clock changes. */
const nextVersionActivationTime = (
  latest: Option.Option<{ readonly activatedAt: Temporal.Instant }>,
  now: Temporal.Instant
) =>
  latest.pipe(
    Option.filter(
      ({ activatedAt }) => Temporal.Instant.compare(activatedAt, now) >= 0
    ),
    Option.match({
      onNone: () => now,
      onSome: ({ activatedAt }) => activatedAt.add({ microseconds: 1 }),
    })
  );

/**
 * Steps 6 and 7: inserts version n + 1 with its provenance, points the
 * automation at it, and applies the status and schedule rules.
 */
const publishVersion = (input: {
  readonly copy: AutomationWorkingCopy;
  readonly publishable: Publishable;
  readonly flow: AutomationFlow;
  readonly latest: Option.Option<
    Option.Option.Value<Effect.Success<ReturnType<typeof latestVersion>>>
  >;
  readonly activatedBy: CustomerAccountId | null;
  readonly activatedAt: Temporal.Instant;
}) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) => {
    const { activatedAt } = input;
    const { campaign, automation, publishedEmail } = input.copy;
    const frozenEmail = Option.getOrUndefined(publishedEmail);
    const purpose = frozenEmail?.document.purpose ?? campaign.purpose;
    const templateKey =
      frozenEmail?.document.templateKey ?? campaign.templateKey;
    const content = frozenEmail ? {} : campaign.content;
    const contentHash = frozenEmail
      ? hashCampaignEmailVersion(frozenEmail.versionId)
      : hashCampaignContent({
          purpose: campaign.purpose,
          templateKey: campaign.templateKey,
          locales: campaign.content,
        });
    return Effect.Do.pipe(
      Effect.bind("versionId", () =>
        db
          .insert(emailCampaignAutomationVersions)
          .values({
            campaignId: campaign.id,
            versionNumber: Option.match(input.latest, {
              onNone: () => 1,
              onSome: ({ versionNumber }) => versionNumber + 1,
            }),
            emailId: frozenEmail?.emailId ?? null,
            frozenEmailVersionId: frozenEmail?.versionId ?? null,
            flow: input.flow,
            purpose,
            templateKey,
            content,
            contentHash,
            audienceFilter: input.publishable.audience.filter,
            draftHash: input.publishable.draftHash,
            activatedAt,
          })
          .returning({ id: emailCampaignAutomationVersions.id })
          .pipe(
            Effect.flatMap(([version]) =>
              version === undefined
                ? Effect.die(new Error("The version insert returned no row."))
                : Effect.succeed(version.id)
            )
          )
      ),
      Effect.tap(({ versionId }) =>
        db.insert(emailCampaignAutomationVersionProvenance).values({
          versionId,
          audienceId: input.publishable.audience.id,
          activatedByAccountId: input.activatedBy,
        })
      ),
      Effect.bind("nextFireAt", () =>
        loadAutomationVersionActivations(campaign.id).pipe(
          Effect.map((versions) =>
            nextFireAt({
              status: campaign.status,
              currentNextFireAt: automation.nextFireAt,
              fireAfter: (after) => nextFireAfter(versions, after),
              now: activatedAt,
            })
          )
        )
      ),
      Effect.tap(({ versionId, nextFireAt }) =>
        db
          .update(emailCampaignAutomations)
          .set({
            activeVersionId: versionId,
            nextFireAt,
            ...(campaign.status === "draft" && { acceptingSince: activatedAt }),
            updatedAt: sql`now()`,
          })
          .where(eq(emailCampaignAutomations.campaignId, campaign.id))
      ),
      Effect.tap(() =>
        campaign.status === "draft"
          ? db
              .update(emailCampaigns)
              .set({ status: "active", updatedAt: sql`now()` })
              .where(eq(emailCampaigns.id, campaign.id))
              .pipe(Effect.asVoid)
          : Effect.void
      ),
      Effect.map(({ versionId }) => versionId)
    );
  });

/**
 * The schedule rule of activation (§5.10, §7.5 step 7). A first activation
 * schedules the next fire; a paused automation keeps none until it resumes;
 * an active one keeps a due backlog, whose fires switch calendars at the
 * new activation, and otherwise follows the new version from now.
 */
const nextFireAt = (input: {
  readonly status: AutomationWorkingCopy["campaign"]["status"];
  readonly currentNextFireAt: Temporal.Instant | null;
  readonly fireAfter: (
    after: Temporal.Instant
  ) => Option.Option<Temporal.Instant>;
  readonly now: Temporal.Instant;
}): Temporal.Instant | null => {
  if (input.status === "paused") return null;
  if (
    input.status === "active" &&
    input.currentNextFireAt !== null &&
    Temporal.Instant.compare(input.currentNextFireAt, input.now) <= 0
  ) {
    return input.currentNextFireAt;
  }
  return Option.getOrNull(input.fireAfter(input.now));
};

// --- Pause, resume, archive (§5.10) -----------------------------------------

type TransitionInput = {
  readonly copy: AutomationWorkingCopy;
  readonly now: Temporal.Instant;
};

type TransitionError =
  | DatabaseQueryError
  | AutomationArchived
  | AutomationFlowInvalid
  | AutomationStatusConflict;

type ResumeError = TransitionError | AutomationTriggerInUse;

const ensureNotArchived = (copy: AutomationWorkingCopy) =>
  copy.campaign.status === "archived"
    ? Effect.fail(new AutomationArchived({ campaignId: copy.campaign.id }))
    : Effect.void;

const statusConflict = (
  copy: AutomationWorkingCopy,
  operation: "pause" | "resume"
) =>
  new AutomationStatusConflict({
    campaignId: copy.campaign.id,
    operation,
    status: copy.campaign.status,
  });

const pauseIn = ({
  copy,
  now,
}: TransitionInput): Effect.Effect<
  void,
  TransitionError,
  WorkspaceTransaction
> =>
  Effect.flatMap(
    WorkspaceTransaction,
    ({ db }): Effect.Effect<void, TransitionError, WorkspaceTransaction> => {
      const campaignId = copy.campaign.id;
      switch (copy.campaign.status) {
        case "paused":
          return Effect.void;
        case "archived":
          return Effect.fail(new AutomationArchived({ campaignId }));
        case "draft":
          return Effect.fail(statusConflict(copy, "pause"));
        case "active":
          return Effect.all(
            [
              db
                .update(emailCampaigns)
                .set({ status: "paused", updatedAt: sql`now()` })
                .where(eq(emailCampaigns.id, campaignId)),
              db
                .update(emailCampaignAutomations)
                .set({
                  pausedAt: now,
                  acceptingSince: null,
                  nextFireAt: null,
                  updatedAt: sql`now()`,
                })
                .where(eq(emailCampaignAutomations.campaignId, campaignId)),
              dropEnteringFire({ campaignId, now }),
              // A dry run doesn't depend on the status, so pause leaves it running.
              stopUnits({ campaignId, now, exceptPreviews: true }),
            ],
            { discard: true }
          );
      }
    }
  );

const resumeIn = ({
  copy,
  now,
}: TransitionInput): Effect.Effect<void, ResumeError, WorkspaceTransaction> =>
  Effect.flatMap(
    WorkspaceTransaction,
    ({ db }): Effect.Effect<void, ResumeError, WorkspaceTransaction> => {
      const campaignId = copy.campaign.id;
      switch (copy.campaign.status) {
        case "active":
          return Effect.void;
        case "archived":
          return Effect.fail(new AutomationArchived({ campaignId }));
        case "draft":
          return Effect.fail(statusConflict(copy, "resume"));
        case "paused":
          return Effect.Do.pipe(
            Effect.bind("versions", () =>
              loadAutomationVersionActivations(campaignId)
            ),
            Effect.bind("resumedAt", ({ versions }) => {
              const active = versions.find(
                ({ id }) => id === copy.automation.activeVersionId
              );
              return active === undefined
                ? Effect.succeed(now)
                : ensurePassReminderWritesAllowed(
                    active.trigger,
                    "marketing"
                  ).pipe(
                    Effect.andThen(
                      passReminderOwnership(campaignId, active.trigger, now)
                    ),
                    Effect.flatMap(requirePassReminderOwnership(campaignId))
                  );
            }),
            Effect.flatMap(({ versions, resumedAt }) =>
              Effect.all(
                [
                  db
                    .update(emailCampaigns)
                    .set({ status: "active", updatedAt: sql`now()` })
                    .where(eq(emailCampaigns.id, campaignId)),
                  db
                    .update(emailCampaignAutomations)
                    .set({
                      resumedAt,
                      acceptingSince: resumedAt,
                      // Fires that fell due while paused are never entered (D12).
                      nextFireAt: Option.getOrNull(
                        nextFireAfter(versions, resumedAt)
                      ),
                      updatedAt: sql`now()`,
                    })
                    .where(eq(emailCampaignAutomations.campaignId, campaignId)),
                ],
                { discard: true }
              )
            )
          );
      }
    }
  );

const archiveIn = ({
  copy,
  now,
}: TransitionInput): Effect.Effect<
  void,
  DatabaseQueryError,
  WorkspaceTransaction
> =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) => {
    const campaignId = copy.campaign.id;
    return copy.campaign.status === "archived"
      ? Effect.void
      : Effect.all(
          [
            db
              .update(emailCampaigns)
              .set({ status: "archived", updatedAt: sql`now()` })
              .where(eq(emailCampaigns.id, campaignId)),
            db
              .update(emailCampaignAutomations)
              .set({
                archivedAt: now,
                acceptingSince: null,
                nextFireAt: null,
                updatedAt: sql`now()`,
              })
              .where(eq(emailCampaignAutomations.campaignId, campaignId)),
            dropEnteringFire({ campaignId, now }),
            // Runs before units, in the lock order of §5.4.
            endActiveRuns({ campaignId, now }),
            stopUnits({ campaignId, now, exceptPreviews: false }),
            closeRunningPreview({ campaignId, now }),
          ],
          { discard: true }
        );
  });

/** An archived automation can't activate, so its running dry run ends. */
const closeRunningPreview = (input: {
  readonly campaignId: CampaignId;
  readonly now: Temporal.Instant;
}): Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction> =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    db
      .select({ id: emailCampaignAutomationPreviews.id })
      .from(emailCampaignAutomationPreviews)
      .where(
        and(
          eq(emailCampaignAutomationPreviews.campaignId, input.campaignId),
          eq(emailCampaignAutomationPreviews.status, "running")
        )
      )
      .pipe(
        Effect.flatMap((running) =>
          Effect.forEach(running, ({ id }) =>
            closePreview({
              previewId: id,
              status: "failed",
              errorCode: AutomationArchived.code,
              at: input.now,
            })
          )
        ),
        Effect.asVoid
      )
  );

/** Pause and archive close the fire being entered; runs it started keep going. */
const dropEnteringFire = (input: {
  readonly campaignId: CampaignId;
  readonly now: Temporal.Instant;
}) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    db
      .update(emailCampaignAutomationScheduleFires)
      .set({ status: "dropped", settledAt: input.now })
      .where(
        and(
          eq(emailCampaignAutomationScheduleFires.campaignId, input.campaignId),
          eq(emailCampaignAutomationScheduleFires.status, "entering")
        )
      )
  );

/**
 * Drops the automation's planned units, which hold no slot, after
 * releasing their subjects for replanning; marks its enqueued and claimed
 * units for cancellation, which frees no slot until their claimant or the
 * reaper settles them and releases their subjects (§5.10). A deliver unit
 * with a persisted batch is never touched: it's the batch's only recovery
 * path (§5.9). Lifecycle-owned units are campaign-scoped, so sweep pages
 * and intake units are never touched either.
 */
const stopUnits = (input: {
  readonly campaignId: CampaignId;
  readonly now: Temporal.Instant;
  readonly exceptPreviews: boolean;
}): Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction> =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) => {
    const owned = and(
      eq(emailCampaignAutomationWorkUnits.campaignId, input.campaignId),
      isNull(emailCampaignAutomationWorkUnits.sendId),
      input.exceptPreviews
        ? ne(emailCampaignAutomationWorkUnits.kind, "preview")
        : undefined
    );
    return Effect.Do.pipe(
      Effect.bind("planned", () =>
        db
          .select({
            id: emailCampaignAutomationWorkUnits.id,
            subject: emailCampaignAutomationWorkUnits.subject,
          })
          .from(emailCampaignAutomationWorkUnits)
          .where(
            and(owned, eq(emailCampaignAutomationWorkUnits.status, "planned"))
          )
      ),
      Effect.tap(({ planned }) => releaseAutomationUnitSubjects(planned)),
      Effect.tap(({ planned }) =>
        planned.length === 0
          ? Effect.void
          : db
              .update(emailCampaignAutomationWorkUnits)
              .set({ status: "dropped", settledAt: input.now })
              .where(
                and(
                  inArray(
                    emailCampaignAutomationWorkUnits.id,
                    planned.map(({ id }) => id)
                  ),
                  eq(emailCampaignAutomationWorkUnits.status, "planned")
                )
              )
              .pipe(Effect.asVoid)
      ),
      Effect.tap(() =>
        db
          .update(emailCampaignAutomationWorkUnits)
          .set({ cancelRequestedAt: input.now })
          .where(
            and(
              owned,
              inArray(emailCampaignAutomationWorkUnits.status, [
                "enqueued",
                "claimed",
              ]),
              isNull(emailCampaignAutomationWorkUnits.cancelRequestedAt)
            )
          )
      ),
      Effect.asVoid
    );
  });

/** Archive ends every active run; sending runs settle with their batch. */
const endActiveRuns = (input: {
  readonly campaignId: CampaignId;
  readonly now: Temporal.Instant;
}): Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction> =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    db
      .select({ id: emailCampaignAutomationRuns.id })
      .from(emailCampaignAutomationRuns)
      .where(
        and(
          eq(emailCampaignAutomationRuns.campaignId, input.campaignId),
          eq(emailCampaignAutomationRuns.status, "active")
        )
      )
      .pipe(
        Effect.flatMap((runs) =>
          runs.length === 0
            ? Effect.void
            : AutomationRunTransitions.end({
                runIds: runs.map(({ id }) => id),
                expect: { status: "active" },
                outcome: "archived",
                at: input.now,
              })
        ),
        Effect.asVoid
      )
  );

// --- Reads ------------------------------------------------------------------

const readDetail = (
  campaignId: CampaignId
): Effect.Effect<AutomationDetail, WorkingCopyError, WorkspaceTransaction> =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    Effect.Do.pipe(
      Effect.bind("copy", () => loadAutomationWorkingCopy(campaignId)),
      Effect.bind("activeVersion", ({ copy }) =>
        copy.automation.activeVersionId === null
          ? Effect.succeed(Option.none<VersionRow>())
          : selectVersions({
              campaignId,
              activeVersionId: copy.automation.activeVersionId,
              versionId: copy.automation.activeVersionId,
            }).pipe(Effect.map(([version]) => Option.fromNullishOr(version)))
      ),
      Effect.bind("versionCount", () =>
        db
          .select({ versions: count() })
          .from(emailCampaignAutomationVersions)
          .where(eq(emailCampaignAutomationVersions.campaignId, campaignId))
          .pipe(Effect.map(([row]) => row?.versions ?? 0))
      ),
      Effect.bind("activation", ({ copy, activeVersion }) =>
        activationOf({ copy, activeVersion })
      ),
      Effect.map(
        ({
          copy,
          activeVersion,
          versionCount,
          activation,
        }): AutomationDetail => ({
          campaignId,
          status: copy.campaign.status,
          flow: Option.getOrNull(copy.flow),
          trigger: copy.flow.pipe(
            Option.map(({ trigger }) => automationTriggerSummary(trigger)),
            Option.getOrNull
          ),
          activeVersion: activeVersion.pipe(
            Option.map(toVersionSummary),
            Option.getOrNull
          ),
          versionCount,
          pendingChanges: Option.exists(
            activeVersion,
            ({ draftHash }) => !Option.contains(copy.draftHash, draftHash)
          ),
          activation,
          acceptingSince: copy.automation.acceptingSince?.toString() ?? null,
          pausedAt: copy.automation.pausedAt?.toString() ?? null,
          archivedAt: copy.automation.archivedAt?.toString() ?? null,
          nextFireAt: copy.automation.nextFireAt?.toString() ?? null,
          updatedAt: copy.automation.updatedAt.toString(),
        })
      )
    )
  );

/**
 * The activation rule as adapters gate on it (§7.5): published when the
 * working copy equals the active version, else the latest dry run of the
 * current draft, running or completed. An archived automation is never
 * ready.
 */
const activationOf = (input: {
  readonly copy: AutomationWorkingCopy;
  readonly activeVersion: Option.Option<VersionRow>;
}): Effect.Effect<
  AutomationActivation,
  DatabaseQueryError,
  WorkspaceTransaction
> =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) => {
    const { draftHash } = input.copy;
    if (
      Option.exists(input.activeVersion, (version) =>
        Option.contains(draftHash, version.draftHash)
      )
    ) {
      return Effect.succeed({ _tag: "Published" });
    }
    if (Option.isNone(draftHash) || input.copy.campaign.status === "archived") {
      return Effect.succeed({ _tag: "PreviewRequired" });
    }
    return db
      .select({
        id: emailCampaignAutomationPreviews.id,
        status: emailCampaignAutomationPreviews.status,
        asOf: emailCampaignAutomationPreviews.asOf,
        unitsDone: emailCampaignAutomationPreviews.unitsDone,
        unitsTotal: emailCampaignAutomationPreviews.unitsTotal,
      })
      .from(emailCampaignAutomationPreviews)
      .where(
        and(
          eq(
            emailCampaignAutomationPreviews.campaignId,
            input.copy.campaign.id
          ),
          eq(emailCampaignAutomationPreviews.draftHash, draftHash.value),
          inArray(emailCampaignAutomationPreviews.status, [
            "running",
            "completed",
          ])
        )
      )
      .orderBy(desc(emailCampaignAutomationPreviews.createdAt))
      .limit(1)
      .pipe(
        Effect.flatMap(([preview]) =>
          lifecycleInstant.pipe(
            Effect.map((now): AutomationActivation => {
              if (preview === undefined) return { _tag: "PreviewRequired" };
              if (
                Option.exists(
                  input.copy.flow,
                  (flow) => !previewIsCurrent(flow, preview.asOf, now)
                )
              ) {
                return { _tag: "PreviewRequired" };
              }
              return preview.status === "completed"
                ? {
                    _tag: "Ready",
                    previewId: preview.id,
                    draftHash: draftHash.value,
                  }
                : {
                    _tag: "PreviewRunning",
                    previewId: preview.id,
                    unitsDone: preview.unitsDone,
                    unitsTotal: preview.unitsTotal,
                  };
            })
          )
        )
      );
  });

const selectVersions = (input: {
  readonly campaignId: CampaignId;
  readonly activeVersionId: AutomationVersionId | null;
  readonly versionId?: AutomationVersionId;
  readonly versionNumber?: number;
}) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) => {
    return db
      .select({
        id: emailCampaignAutomationVersions.id,
        campaignId: emailCampaignAutomationVersions.campaignId,
        versionNumber: emailCampaignAutomationVersions.versionNumber,
        flow: emailCampaignAutomationVersions.flow,
        purpose: emailCampaignAutomationVersions.purpose,
        templateKey: emailCampaignAutomationVersions.templateKey,
        content: emailCampaignAutomationVersions.content,
        audienceFilter: emailCampaignAutomationVersions.audienceFilter,
        draftHash: emailCampaignAutomationVersions.draftHash,
        activatedAt: emailCampaignAutomationVersions.activatedAt,
        audienceId: emailCampaignAutomationVersionProvenance.audienceId,
        activatedByEmail: authUser.email,
      })
      .from(emailCampaignAutomationVersions)
      .leftJoin(
        emailCampaignAutomationVersionProvenance,
        eq(
          emailCampaignAutomationVersionProvenance.versionId,
          emailCampaignAutomationVersions.id
        )
      )
      .leftJoin(
        authUser,
        eq(
          authUser.id,
          emailCampaignAutomationVersionProvenance.activatedByAccountId
        )
      )
      .where(
        and(
          eq(emailCampaignAutomationVersions.campaignId, input.campaignId),
          input.versionId === undefined
            ? undefined
            : eq(emailCampaignAutomationVersions.id, input.versionId),
          input.versionNumber === undefined
            ? undefined
            : eq(
                emailCampaignAutomationVersions.versionNumber,
                input.versionNumber
              )
        )
      )
      .orderBy(desc(emailCampaignAutomationVersions.versionNumber))
      .pipe(
        // Versions were validated when published, so an undecodable flow is a defect.
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeVersionFlow(row.flow).pipe(
              Effect.orDie,
              Effect.map(
                (flow): VersionRow => ({
                  ...row,
                  flow,
                  active: row.id === input.activeVersionId,
                })
              )
            )
          )
        )
      );
  });

type VersionRow = {
  readonly id: AutomationVersionId;
  readonly campaignId: CampaignId;
  readonly versionNumber: number;
  readonly flow: AutomationFlow;
  readonly purpose: CampaignPurpose;
  readonly templateKey: CampaignTemplateKey;
  readonly content: CampaignLocalizedContent;
  readonly audienceFilter: AudienceFilter;
  readonly draftHash: string;
  readonly activatedAt: Temporal.Instant;
  readonly audienceId: CampaignAudienceId | null;
  readonly activatedByEmail: string | null;
  readonly active: boolean;
};

const decodeVersionFlow = Schema.decodeUnknownEffect(
  automationFlowContractSchema
);

const toVersionSummary = (version: VersionRow): AutomationVersionSummary => ({
  campaignId: version.campaignId,
  versionNumber: version.versionNumber,
  trigger: automationTriggerSummary(version.flow.trigger),
  draftHash: version.draftHash,
  activatedAt: version.activatedAt.toString(),
  audienceId: version.audienceId,
  activatedByEmail: version.activatedByEmail,
  active: version.active,
});

const toVersionDetail = (version: VersionRow): AutomationVersionDetail => ({
  ...toVersionSummary(version),
  flow: version.flow,
  purpose: version.purpose,
  templateKey: version.templateKey,
  content: writeCampaignContent(version.content, "markdown"),
  audienceFilter: version.audienceFilter,
});
