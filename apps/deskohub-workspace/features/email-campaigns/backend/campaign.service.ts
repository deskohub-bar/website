import "server-only";

import {
  AutomationTrigger,
  type CampaignPatchInput,
  type EmailId,
} from "@deskohub/workspace-admin-api";
import { and, desc, eq, ne, notExists, or } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  type CampaignRow,
  emailCampaignAudiences,
  emailCampaignAutomations,
  emailCampaignAutomationVersions,
  emailCampaigns,
} from "@/db/schema";
import { currentInstant } from "@/shared/utils/temporal";
import {
  ensureSavedAudienceFilter,
  isSavedAudienceFilter,
} from "../audience-filter-usage";
import { validateStoredAutomationFlow } from "../automation/backend/automation-working-copy";
import { ensurePassReminderPurpose } from "../automation/backend/pass-reminder-write-policy";
import type {
  AutomationCalendarNeverOccurs,
  AutomationFlowInvalid,
  AutomationScheduleMinutesNotAllowed,
} from "../automation/errors";
import {
  type CampaignLocalizedContent,
  type CampaignPurpose,
  type CampaignTemplateKey,
  campaignLocalizedContent,
} from "../body/campaign-content";
import {
  type CampaignContentChanges,
  campaignContentImages,
  changeCampaignContent,
} from "../body/campaign-content-codec";
import {
  campaignImageCloudName,
  isUploadedCampaignImage,
} from "../body/campaign-image-account";
import type { CampaignAudienceId, CampaignId } from "../campaign-identifiers";
import {
  type CampaignDelivery,
  isOnceCampaign,
  type OnceCampaignStatus,
} from "../campaign-states";
import {
  type AudienceFilterContextInvalid,
  CampaignAudienceArchived,
  CampaignAudienceNotFound,
  type CampaignBodyDocumentInvalid,
  type CampaignBodyMarkdownInvalid,
  CampaignContentInvalid,
  CampaignDeliveryMismatch,
  CampaignImageNotUploaded,
  type CampaignLocaleContentMissing,
  CampaignNotFound,
  CampaignPublished,
  CampaignPublishedEmailInvalid,
  CampaignReadOnly,
} from "../errors";
import {
  getCampaignEmailPublication,
  getLinkedCampaignEmail,
  getLinkedCampaignEmails,
  lockCampaignEmailPublication,
  validatePublishedEmailForDelivery,
} from "./campaign-published-email";

type Campaign = CampaignRow;

/** A campaign that sends once; only these can be sent or duplicated. */
type OnceCampaign = Campaign & {
  readonly delivery: "once";
  readonly status: OnceCampaignStatus;
};

type CampaignDraftInput = {
  readonly title: string;
  readonly purpose: CampaignPurpose;
  readonly templateKey: CampaignTemplateKey;
  readonly content: CampaignLocalizedContent;
  readonly audienceId: CampaignAudienceId | null;
  readonly emailId?: EmailId | null;
};

type CampaignEdit = {
  readonly campaignId: CampaignId;
} & Partial<CampaignDraftInput>;

type CampaignWriteError =
  | CampaignAudienceNotFound
  | CampaignAudienceArchived
  | AudienceFilterContextInvalid
  | CampaignContentInvalid
  | CampaignImageNotUploaded
  | CampaignPublishedEmailInvalid;

/** The automation row of an automated campaign, as a copy inherits it. */
type AutomationWorkingCopy = Pick<
  typeof emailCampaignAutomations.$inferSelect,
  "flow"
>;

type CampaignTransactionError = EffectDrizzleQueryError | SqlError.SqlError;

type CampaignEditError =
  | CampaignNotFound
  | CampaignReadOnly
  | AutomationFlowInvalid
  | CampaignWriteError
  | CampaignTransactionError;

const decodeStoredTrigger = Schema.decodeUnknownOption(
  Schema.Struct({ trigger: AutomationTrigger })
);

/** One-off campaigns are editable in Draft, automated ones until archived. */
const isEditable = (campaign: Campaign) =>
  campaign.delivery === "automated"
    ? campaign.status !== "archived"
    : campaign.status === "draft";

const editable = or(
  and(eq(emailCampaigns.delivery, "once"), eq(emailCampaigns.status, "draft")),
  and(
    eq(emailCampaigns.delivery, "automated"),
    ne(emailCampaigns.status, "archived")
  )
);

export interface ICampaignService {
  readonly getPublishedEmail: (
    emailId: EmailId
  ) => ReturnType<typeof getCampaignEmailPublication>;
  readonly getLinkedEmail: (
    campaign: CampaignRow
  ) => ReturnType<typeof getLinkedCampaignEmail>;
  readonly getLinkedEmails: (
    campaigns: readonly CampaignRow[]
  ) => ReturnType<typeof getLinkedCampaignEmails>;
  readonly list: Effect.Effect<readonly Campaign[], EffectDrizzleQueryError>;
  readonly get: (
    campaignId: CampaignId
  ) => Effect.Effect<Campaign, CampaignNotFound | EffectDrizzleQueryError>;
  /** Gets a campaign for a one-off operation, refusing an automated one. */
  readonly getOnce: (
    campaignId: CampaignId
  ) => Effect.Effect<
    OnceCampaign,
    CampaignNotFound | CampaignDeliveryMismatch | EffectDrizzleQueryError
  >;
  /**
   * Creates a Draft, `once` unless `delivery` says otherwise. An automated
   * campaign gets its automation row, with no flow yet, in the same
   * transaction.
   */
  readonly create: (
    input: CampaignDraftInput & { readonly delivery?: CampaignDelivery }
  ) => Effect.Effect<Campaign, CampaignWriteError | CampaignTransactionError>;
  /**
   * Edits a one-off Draft or a non-archived automated campaign; any other
   * campaign is read-only. An automated edit changes only the working copy,
   * never the status or a published version, and serializes with lifecycle
   * operations on the automation's lifecycle lock. A one-off edit's row
   * update waits on a confirmation's campaign row lock and then rechecks the
   * status, so content can't change between a confirmation's content check
   * and its move to Sending.
   */
  readonly update: (
    input: CampaignEdit
  ) => Effect.Effect<Campaign, CampaignEditError>;
  /**
   * Edits a campaign as `update` does, merging per-locale text changes with
   * Markdown or document bodies into its current content: omitted locales and fields
   * keep their value, a locale mapped to null loses its content, and a null
   * `operationalReason` restores the default reason line.
   */
  readonly patch: (
    input: CampaignPatchInput
  ) => Effect.Effect<
    Campaign,
    | CampaignEditError
    | CampaignBodyDocumentInvalid
    | CampaignBodyMarkdownInvalid
    | CampaignLocaleContentMissing
  >;
  /**
   * Deletes a Draft that never published: a one-off campaign that left Draft
   * keeps its history, and an automated one that published a version keeps
   * it for its runs and sends.
   */
  readonly delete: (
    campaignId: CampaignId
  ) => Effect.Effect<
    void,
    | CampaignNotFound
    | CampaignReadOnly
    | CampaignPublished
    | CampaignTransactionError
  >;
  /**
   * Copies a campaign of any status into a new Draft titled "Copy of …" with
   * the same delivery mode; an automated copy also gets the working copy of
   * the flow, step ids included, once it passes the rules a save applies.
   * The copy keeps the source's audience only while it exists, isn't
   * archived, and holds a filter a campaign can use; otherwise the admin
   * picks one.
   */
  readonly duplicate: (
    campaignId: CampaignId
  ) => Effect.Effect<
    Campaign,
    | CampaignNotFound
    | AutomationFlowInvalid
    | AutomationScheduleMinutesNotAllowed
    | AutomationCalendarNeverOccurs
    | CampaignTransactionError
  >;
}

/** Campaign drafts and the read-only record of sent campaigns. */
export class CampaignService extends Context.Service<
  CampaignService,
  ICampaignService
>()("@deskohub-workspace/email-campaigns/CampaignService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db, transaction } = yield* WorkspaceDatabase;

      const find = (campaignId: CampaignId) =>
        db
          .select()
          .from(emailCampaigns)
          .where(eq(emailCampaigns.id, campaignId))
          .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

      const requireFound =
        (campaignId: CampaignId) => (campaign: Option.Option<Campaign>) =>
          Option.match(campaign, {
            onNone: () => Effect.fail(new CampaignNotFound({ campaignId })),
            onSome: Effect.succeed,
          });

      const get = (campaignId: CampaignId) =>
        find(campaignId).pipe(Effect.flatMap(requireFound(campaignId)));

      const getOnce = (campaignId: CampaignId) =>
        get(campaignId).pipe(
          Effect.filterOrFail(
            isOnceCampaign,
            ({ delivery }) =>
              new CampaignDeliveryMismatch({ campaignId, delivery })
          )
        );

      /** Explains why an edit matched no row. */
      const editRejection = Effect.fn("CampaignService.editRejection")(
        function* (campaignId: CampaignId) {
          const campaign = yield* get(campaignId);
          // An editable campaign misses only when it was deleted meanwhile.
          if (campaign.status === "draft" || isEditable(campaign)) {
            return yield* new CampaignNotFound({ campaignId });
          }
          return yield* new CampaignReadOnly({
            campaignId,
            status: campaign.status,
          });
        }
      );

      /** Explains why a deletion matched no row. */
      const deleteRejection = Effect.fn("CampaignService.deleteRejection")(
        function* (campaignId: CampaignId) {
          const campaign = yield* get(campaignId);
          if (campaign.status !== "draft") {
            return yield* new CampaignReadOnly({
              campaignId,
              status: campaign.status,
            });
          }
          if (campaign.delivery === "automated") {
            return yield* new CampaignPublished({ campaignId });
          }
          return yield* new CampaignNotFound({ campaignId });
        }
      );

      /**
       * Takes an automated campaign's lifecycle lock for the rest of the
       * transaction; a one-off campaign has no row to lock. Lifecycle
       * operations take it first too, so writes serialize with activation.
       */
      const lockAutomation = (
        campaignId: CampaignId,
        strength: "update" | "share"
      ) =>
        db
          .select({ flow: emailCampaignAutomations.flow })
          .from(emailCampaignAutomations)
          .where(eq(emailCampaignAutomations.campaignId, campaignId))
          .for(strength)
          .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

      /**
       * Share-locks the audience row for the rest of the transaction, so the
       * audience can't be archived or deleted before the campaign that
       * references it commits.
       */
      const lockAudience = (audienceId: CampaignAudienceId) =>
        db
          .select({
            archivedAt: emailCampaignAudiences.archivedAt,
            filter: emailCampaignAudiences.filter,
          })
          .from(emailCampaignAudiences)
          .where(eq(emailCampaignAudiences.id, audienceId))
          .for("share")
          .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

      const lockAssignableAudience = Effect.fn(
        "CampaignService.lockAssignableAudience"
      )(function* (audienceId: CampaignAudienceId | null) {
        if (audienceId === null) return;
        const audience = yield* lockAudience(audienceId);
        if (Option.isNone(audience)) {
          return yield* new CampaignAudienceNotFound({ audienceId });
        }
        if (audience.value.archivedAt !== null) {
          return yield* new CampaignAudienceArchived({ audienceId });
        }
        yield* ensureSavedAudienceFilter(audience.value.filter);
      });

      /**
       * Keeps the source's audience only if it's still assignable; its flow
       * must pass the rules a save applies.
       */
      const insertCopy = Effect.fn("CampaignService.insertCopy")(function* (
        source: Campaign,
        automation: Option.Option<AutomationWorkingCopy>
      ) {
        const flow = yield* validateStoredAutomationFlow(
          automation.pipe(
            Option.map(({ flow }) => flow),
            Option.getOrNull
          )
        );
        if (Option.isSome(flow)) {
          yield* ensurePassReminderPurpose(flow.value.trigger, source.purpose);
        }
        const audience =
          source.audienceId === null
            ? Option.none()
            : yield* lockAudience(source.audienceId);
        const assignable = Option.exists(
          audience,
          ({ archivedAt, filter }) =>
            archivedAt === null && isSavedAudienceFilter(filter)
        );
        const [campaign] = yield* db
          .insert(emailCampaigns)
          .values({
            title: `Copy of ${source.title}`,
            purpose: source.purpose,
            templateKey: source.templateKey,
            content: source.content,
            emailId: source.emailId,
            audienceId: assignable ? source.audienceId : null,
            delivery: source.delivery,
            status: "draft",
          })
          .returning();
        if (!campaign) {
          return yield* Effect.die("Campaign copy insert returned no row.");
        }
        if (source.delivery === "automated") {
          yield* db.insert(emailCampaignAutomations).values({
            campaignId: campaign.id,
            flow: Option.getOrNull(flow),
          });
        }
        return campaign;
      });

      /** Copies the source as it stands once its working copy is locked. */
      const copyCampaign = Effect.fn("CampaignService.copyCampaign")(function* (
        campaignId: CampaignId
      ) {
        const automation = yield* lockAutomation(campaignId, "share");
        const source = yield* db
          .select()
          .from(emailCampaigns)
          .where(eq(emailCampaigns.id, campaignId))
          .pipe(
            Effect.map((rows) => Option.fromNullishOr(rows[0])),
            Effect.flatMap(requireFound(campaignId))
          );
        return yield* insertCopy(source, automation);
      });

      const validateContent = (
        content: CampaignLocalizedContent | undefined
      ) =>
        content === undefined
          ? Effect.void
          : campaignImageCloudName.pipe(
              Effect.flatMap((imageCloudName) =>
                Schema.decodeEffect(campaignLocalizedContent(imageCloudName))(
                  content
                )
              ),
              Effect.asVoid,
              Effect.mapError((cause) => new CampaignContentInvalid({ cause }))
            );

      /**
       * Holds the images content adds to the campaign editor's uploads. An
       * image the campaign already has in any locale stays, wherever it's
       * stored, so content saved before the rule round-trips unchanged.
       */
      const requireUploadedImages = (
        content: CampaignLocalizedContent,
        current: CampaignLocalizedContent
      ) =>
        campaignImageCloudName.pipe(
          Effect.flatMap((imageCloudName) => {
            const kept = new Set(
              campaignContentImages(current).map(({ source }) => source)
            );
            const added = campaignContentImages(content).find(
              ({ source }) =>
                !kept.has(source) &&
                !isUploadedCampaignImage(source, imageCloudName)
            );
            return added === undefined
              ? Effect.void
              : Effect.fail(new CampaignImageNotUploaded(added));
          })
        );

      /** The campaign's draft, locked until the transaction ends. */
      const lockDraft = (campaignId: CampaignId) =>
        Effect.flatMap(WorkspaceTransaction, ({ db }) =>
          db
            .select()
            .from(emailCampaigns)
            .where(eq(emailCampaigns.id, campaignId))
            .for("update")
            .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
        );

      const selectPublishedEmail = Effect.fn(
        "CampaignService.selectPublishedEmail"
      )(function* (
        emailId: EmailId,
        delivery: CampaignDelivery,
        content?: CampaignLocalizedContent
      ) {
        if (content && Object.keys(content).length > 0)
          return yield* new CampaignPublishedEmailInvalid({
            reason: "inline-content",
          });
        const publication = yield* lockCampaignEmailPublication(emailId);
        if (!publication)
          return yield* new CampaignPublishedEmailInvalid({
            reason: "unavailable",
          });
        yield* validatePublishedEmailForDelivery(
          publication.document,
          delivery
        );
        return {
          emailId,
          purpose: publication.document.purpose,
          templateKey: publication.document.templateKey,
          content: {},
        };
      });

      /** Inserts a Draft, and an automated one's automation row with no flow. */
      const insertDraft = Effect.fn("CampaignService.insertDraft")(function* (
        input: CampaignDraftInput & { readonly delivery: CampaignDelivery }
      ) {
        yield* lockAssignableAudience(input.audienceId);
        const selection = input.emailId
          ? yield* selectPublishedEmail(
              input.emailId,
              input.delivery,
              input.content
            )
          : undefined;
        const [campaign] = yield* db
          .insert(emailCampaigns)
          .values({ ...input, ...selection, status: "draft" })
          .returning();
        if (!campaign) {
          return yield* Effect.die("Campaign insert returned no row.");
        }
        if (input.delivery === "automated") {
          yield* db
            .insert(emailCampaignAutomations)
            .values({ campaignId: campaign.id, flow: null });
        }
        return campaign;
      });

      /** Writes an edit if the campaign is still editable once locked. */
      const writeEdit = Effect.fn("CampaignService.writeEdit")(function* (
        { campaignId, ...changes }: CampaignEdit,
        automation: Option.Option<AutomationWorkingCopy>
      ) {
        if (changes.purpose !== undefined) {
          const flow = Option.flatMap(automation, ({ flow }) =>
            decodeStoredTrigger(flow)
          );
          if (Option.isSome(flow))
            yield* ensurePassReminderPurpose(
              flow.value.trigger,
              changes.purpose
            );
        }
        if (changes.audienceId !== undefined) {
          yield* lockAssignableAudience(changes.audienceId);
        }
        const updatedAt = yield* currentInstant;
        const [campaign] = yield* db
          .update(emailCampaigns)
          .set({ ...changes, updatedAt })
          .where(and(eq(emailCampaigns.id, campaignId), editable))
          .returning();
        return Option.fromNullishOr(campaign);
      });

      const requireEdited =
        (campaignId: CampaignId) => (campaign: Option.Option<Campaign>) =>
          Option.match(campaign, {
            onNone: () => editRejection(campaignId),
            onSome: Effect.succeed,
          });

      const update = Effect.fn("CampaignService.update")(function* (
        edit: CampaignEdit
      ) {
        const { content } = edit;
        yield* validateContent(content);
        return yield* transaction(
          Effect.gen(function* () {
            const automation = yield* lockAutomation(edit.campaignId, "update");
            const locked = yield* lockDraft(edit.campaignId);
            if (Option.isNone(locked) || !isEditable(locked.value))
              return Option.none<Campaign>();
            const current = locked.value;
            if (
              current.emailId &&
              edit.emailId === undefined &&
              (edit.content !== undefined ||
                edit.purpose !== undefined ||
                edit.templateKey !== undefined)
            ) {
              return yield* new CampaignPublishedEmailInvalid({
                reason: "inline-content",
              });
            }
            const selection = edit.emailId
              ? yield* selectPublishedEmail(
                  edit.emailId,
                  current.delivery,
                  content
                )
              : undefined;
            if (content !== undefined && !selection)
              yield* requireUploadedImages(content, current.content);
            return yield* writeEdit({ ...edit, ...selection }, automation);
          })
        ).pipe(Effect.flatMap(requireEdited(edit.campaignId)));
      });

      /**
       * Merges the content changes into the content as it stands once the
       * campaign is locked, so no concurrent edit is lost.
       */
      const patchContent = Effect.fn("CampaignService.patchContent")(
        function* ({
          content: changes,
          ...edit
        }: CampaignPatchInput & {
          readonly content: CampaignContentChanges;
        }) {
          const automation = yield* lockAutomation(edit.campaignId, "update");
          const current = yield* lockDraft(edit.campaignId);
          if (Option.isNone(current)) return Option.none<Campaign>();
          if (current.value.emailId && edit.emailId === undefined)
            return yield* new CampaignPublishedEmailInvalid({
              reason: "inline-content",
            });
          const content = yield* changeCampaignContent({
            campaignId: edit.campaignId,
            current: current.value.content,
            changes,
          });
          yield* validateContent(content);
          yield* requireUploadedImages(content, current.value.content);
          return yield* writeEdit({ ...edit, content }, automation);
        }
      );

      return {
        getPublishedEmail: (emailId) =>
          getCampaignEmailPublication(db, emailId),
        getLinkedEmail: (campaign) => getLinkedCampaignEmail(db, campaign),
        getLinkedEmails: (campaigns) => getLinkedCampaignEmails(db, campaigns),
        list: db
          .select()
          .from(emailCampaigns)
          .orderBy(desc(emailCampaigns.createdAt), desc(emailCampaigns.id))
          .pipe(Effect.withSpan("CampaignService.list")),
        get: Effect.fn("CampaignService.get")(get),
        getOnce: Effect.fn("CampaignService.getOnce")(getOnce),
        create: Effect.fn("CampaignService.create")(function* ({
          delivery = "once",
          ...input
        }) {
          yield* validateContent(input.content);
          yield* requireUploadedImages(input.content, {});
          return yield* transaction(insertDraft({ ...input, delivery }));
        }),
        update,
        patch: Effect.fn("CampaignService.patch")(function* ({
          content,
          ...edit
        }) {
          if (edit.emailId) {
            if (content && Object.keys(content).length > 0)
              return yield* new CampaignPublishedEmailInvalid({
                reason: "inline-content",
              });
            return yield* update(edit);
          }
          if (content === undefined) return yield* update(edit);
          return yield* transaction(patchContent({ ...edit, content })).pipe(
            Effect.flatMap(requireEdited(edit.campaignId))
          );
        }),
        delete: Effect.fn("CampaignService.delete")(function* (campaignId) {
          const deleted = yield* transaction(
            lockAutomation(campaignId, "update").pipe(
              Effect.andThen(
                db
                  .delete(emailCampaigns)
                  .where(
                    and(
                      eq(emailCampaigns.id, campaignId),
                      eq(emailCampaigns.status, "draft"),
                      notExists(
                        db
                          .select({
                            id: emailCampaignAutomationVersions.id,
                          })
                          .from(emailCampaignAutomationVersions)
                          .where(
                            eq(
                              emailCampaignAutomationVersions.campaignId,
                              emailCampaigns.id
                            )
                          )
                      )
                    )
                  )
                  .returning({ id: emailCampaigns.id })
              )
            )
          );
          if (deleted.length === 0) {
            return yield* deleteRejection(campaignId);
          }
        }),
        duplicate: Effect.fn("CampaignService.duplicate")(
          function* (campaignId) {
            return yield* transaction(copyCampaign(campaignId));
          }
        ),
      } satisfies ICampaignService;
    })
  );

  static Live = this.Default.pipe(Layer.provide(WorkspaceDatabase.Default));
}
