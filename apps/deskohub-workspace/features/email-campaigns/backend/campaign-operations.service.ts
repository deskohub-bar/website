import "server-only";

import {
  type CampaignOperations as CampaignOperationRegistry,
  type CampaignTemplatePreviewInputType,
  campaignOperations,
  type EmailDocument,
  OperationConflict,
  OperationInputInvalid,
} from "@deskohub/workspace-admin-api";
import { Context, Effect, Layer, Match, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import type { CampaignRow } from "@/db/schema";
import {
  type AdministrationOperationPort,
  makeAdministrationOperationPort,
  type OperationHandlers,
  type OperationResults,
} from "@/features/administration/administration-operation-port";
import { AccountRoleGrants } from "@/features/administrators/backend/account-role-grants.service";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import type { Locale } from "@/features/i18n";
import { type AudienceFilter, audienceFilterSchema } from "../audience-filter";
import { previewCalendarExpression } from "../automation/automation-calendar-preview";
import {
  AutomationDryRun,
  type AutomationDryRunWithLifecycle,
} from "../automation/backend/automation-dry-run.service";
import { AutomationEngineHealth } from "../automation/backend/automation-engine-health.service";
import { AutomationLifecycle } from "../automation/backend/automation-lifecycle.service";
import {
  type AutomationRunDetailWithLifecycle,
  AutomationRunLog,
  type AutomationRunPageWithLifecycle,
} from "../automation/backend/automation-run-log.service";
import {
  readCampaignContent,
  readCampaignDraftContent,
} from "../body/campaign-content-codec";
import { campaignTemplates } from "../body/campaign-templates";
import { renderCampaignEmailPreview } from "../campaign-email";
import { campaignContentLocaleOrder } from "../recipient-locale";
import { CampaignService } from "./campaign.service";
import { CampaignAudienceService } from "./campaign-audience.service";
import {
  CampaignEmailConfig,
  toCampaignSettings,
} from "./campaign-email.config";
import {
  type CampaignOperationCause,
  toOperationError,
} from "./campaign-operation-errors";
import {
  toAdministrationAudience,
  toAdministrationCampaignDetail,
  toAdministrationCampaignEditorContent,
  toAdministrationCampaignSummary,
  toAdministrationSendStatus,
} from "./campaign-operation-projections";
import { sampleCampaignEmailContent } from "./campaign-published-email";
import { CampaignRecipientService } from "./campaign-recipient.service";
import { CampaignSendService } from "./campaign-send.service";
import { CampaignSendStatusService } from "./campaign-send-status.service";
import { OperationRequestLedger } from "./operation-request-ledger.service";

type Registry = CampaignOperationRegistry;

/** The dry run's and run log's reads add each customer's lifecycle for the Admin UI. */
type CampaignOperationResults = OperationResults<
  Registry,
  {
    readonly getAutomationDryRun: AutomationDryRunWithLifecycle;
    readonly listAutomationRuns: AutomationRunPageWithLifecycle;
    readonly getAutomationRun: AutomationRunDetailWithLifecycle;
  }
>;

/**
 * One handler per registered operation; a missing one fails the typecheck.
 * A handler may read who acts, as activation records it.
 */
type CampaignOperationHandlers = OperationHandlers<
  Registry,
  CampaignOperationCause,
  CurrentAdministrator,
  CampaignOperationResults
>;

export type ICampaignOperations = AdministrationOperationPort<
  Registry,
  OperationRequestLedger,
  CampaignOperationResults
>;

/** The single port the admin UI, `/api/v1/cli` and future adapters call. */
export class CampaignOperations extends Context.Service<
  CampaignOperations,
  ICampaignOperations
>()("@deskohub-workspace/email-campaigns/CampaignOperations") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const handlers: CampaignOperationHandlers =
        yield* makeCampaignOperationHandlers;
      return yield* makeAdministrationOperationPort({
        group: "CampaignOperations",
        operations: campaignOperations,
        handlers,
        ledger: OperationRequestLedger,
        toOperationError,
      });
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        AccountRoleGrants.Live,
        CampaignAudienceService.Live,
        CampaignService.Live,
        CampaignRecipientService.Live,
        CampaignSendService.Live,
        CampaignSendStatusService.Live,
        AutomationLifecycle.Live,
        AutomationDryRun.Live,
        AutomationRunLog.Live,
        AutomationEngineHealth.Default.pipe(
          Layer.provide(WorkspaceDatabase.Default)
        )
      )
    )
  );
}

/** The contract mirrors the domain filter; its own schema has the last word. */
const decodeAudienceFilter = (filter: AudienceFilter) =>
  Schema.decodeUnknownEffect(audienceFilterSchema)(filter).pipe(
    Effect.mapError(
      (cause) =>
        new OperationInputInvalid({
          code: "audience-filter-invalid",
          message: `The audience filter is invalid: ${cause.message}`,
          cause,
        })
    )
  );

const makeCampaignOperationHandlers = Effect.gen(function* () {
  const audiences = yield* CampaignAudienceService;
  const campaigns = yield* CampaignService;
  const recipients = yield* CampaignRecipientService;
  const sending = yield* CampaignSendService;
  const sendStatus = yield* CampaignSendStatusService;
  const automations = yield* AutomationLifecycle;
  const dryRuns = yield* AutomationDryRun;
  const runLog = yield* AutomationRunLog;
  const engineHealth = yield* AutomationEngineHealth;

  /**
   * The previewed locale of unsaved texts, texts still being written, or a
   * saved campaign.
   */
  const loadPreviewSource = (
    preview: Extract<
      CampaignTemplatePreviewInputType["preview"],
      { readonly _tag: "Content" | "UnfinishedContent" }
    >
  ) =>
    Match.value(preview).pipe(
      Match.tagsExhaustive({
        Content: ({ purpose, locale, content }) =>
          readCampaignContent({ [locale]: content }).pipe(
            Effect.map((read) => ({ purpose, content: read }))
          ),
        UnfinishedContent: ({ purpose, locale, content }) =>
          readCampaignDraftContent({ [locale]: content }).pipe(
            Effect.map((read) => ({ purpose, content: read }))
          ),
      })
    );

  const renderPublishedEmail = Effect.fn(
    "CampaignOperations.renderPublishedEmail"
  )(function* (
    publication: { readonly document: EmailDocument } | undefined,
    locale: Locale
  ) {
    if (!publication)
      return yield* new OperationInputInvalid({
        code: "published-email-invalid",
        message: "Select an available published marketing email.",
      });
    const content = yield* sampleCampaignEmailContent(
      publication.document,
      locale
    );
    const rendered = yield* renderCampaignEmailPreview({
      templateKey: publication.document.templateKey,
      purpose: publication.document.purpose,
      locale,
      content,
    });
    return { ...rendered, preheader: content.preheader };
  });

  const previewCampaignTemplate = Effect.fn(
    "CampaignOperations.previewCampaignTemplate"
  )(function* ({ templateKey, preview }: CampaignTemplatePreviewInputType) {
    const { locale } = preview;
    if (preview._tag === "PublishedEmail") {
      const publication = yield* campaigns.getPublishedEmail(preview.emailId);
      return yield* renderPublishedEmail(publication, locale);
    }
    const source = yield* preview._tag === "Campaign"
      ? campaigns.get(preview.campaignId).pipe(
          Effect.map((campaign) => ({
            purpose: campaign.purpose,
            content: campaign.content,
            campaign,
          }))
        )
      : loadPreviewSource(preview).pipe(
          Effect.map((inline) => ({ ...inline, campaign: undefined }))
        );
    if (source.campaign?.emailId)
      return yield* renderPublishedEmail(
        yield* campaigns.getLinkedEmail(source.campaign),
        locale
      );
    const content = source.content[locale];
    if (!content)
      return yield* new OperationInputInvalid({
        code: "content-locale-missing",
        message: `The campaign has no ${locale} content.`,
      });
    return yield* renderCampaignEmailPreview({
      templateKey,
      locale,
      content,
      purpose: source.purpose,
    });
  });

  const withLinkedLocales = <T extends { readonly locales: readonly Locale[] }>(
    campaign: CampaignRow,
    projected: T
  ) =>
    campaign.emailId
      ? campaigns.getLinkedEmail(campaign).pipe(
          Effect.map((publication) => ({
            ...projected,
            locales: linkedLocales(publication),
          }))
        )
      : Effect.succeed(projected);

  const linkedLocales = (
    publication: Effect.Success<ReturnType<typeof campaigns.getLinkedEmail>>
  ) =>
    publication
      ? campaignContentLocaleOrder.filter((locale) =>
          Object.hasOwn(publication.document.translations, locale)
        )
      : [];

  const campaignDetail = (campaign: CampaignRow) =>
    withLinkedLocales(campaign, toAdministrationCampaignDetail(campaign));

  /** Who the campaign's audience reaches now, as the real send would. */
  const previewCampaignRecipients = Effect.fn(
    "CampaignOperations.previewCampaignRecipients"
  )(function* (campaignId: Parameters<typeof campaigns.get>[0]) {
    const campaign = yield* campaigns.get(campaignId);
    if (campaign.audienceId === null) {
      return yield* new OperationConflict({
        code: "campaign-audience-missing",
        message: "The campaign has no audience. Set one first.",
      });
    }
    const audience = yield* audiences.get(campaign.audienceId);
    const resolution = yield* recipients.resolve({
      purpose: campaign.purpose,
      filter: audience.filter,
    });
    return {
      recipients: resolution.recipients.map(
        ({ dotyposCustomerId, locale, email }) => ({
          customerId: dotyposCustomerId,
          locale,
          email,
        })
      ),
      exclusions: resolution.exclusions.map(
        ({ dotyposCustomerId, reason }) => ({
          customerId: dotyposCustomerId,
          reason,
        })
      ),
      duplicates: resolution.duplicates,
    };
  });

  const handlers: CampaignOperationHandlers = {
    listCampaignAudiences: () =>
      audiences
        .list({ includeArchived: true })
        .pipe(Effect.map((rows) => rows.map(toAdministrationAudience))),
    getCampaignAudience: ({ audienceId }) =>
      audiences.get(audienceId).pipe(Effect.map(toAdministrationAudience)),
    createCampaignAudience: ({ audience }) =>
      decodeAudienceFilter(audience.filter).pipe(
        Effect.flatMap((filter) =>
          audiences.create({ title: audience.title, filter })
        ),
        Effect.map(toAdministrationAudience)
      ),
    updateCampaignAudience: ({ filter, ...update }) =>
      (filter === undefined
        ? audiences.update(update)
        : decodeAudienceFilter(filter).pipe(
            Effect.flatMap((decoded) =>
              audiences.update({ ...update, filter: decoded })
            )
          )
      ).pipe(Effect.map(toAdministrationAudience)),
    archiveCampaignAudience: ({ audienceId }) =>
      audiences.archive(audienceId).pipe(Effect.map(toAdministrationAudience)),
    unarchiveCampaignAudience: ({ audienceId }) =>
      audiences
        .unarchive(audienceId)
        .pipe(Effect.map(toAdministrationAudience)),
    deleteCampaignAudience: ({ audienceId }) =>
      audiences.delete(audienceId).pipe(Effect.as({ id: audienceId })),
    listCampaignTemplates: () =>
      Effect.succeed(
        Object.values(campaignTemplates).map(({ key, name, description }) => ({
          key,
          name,
          description,
        }))
      ),
    previewCampaignTemplate,
    listCampaigns: () =>
      campaigns.list.pipe(
        Effect.flatMap((rows) => {
          if (!rows.some(({ emailId }) => emailId)) {
            return Effect.succeed(rows.map(toAdministrationCampaignSummary));
          }
          return campaigns.getLinkedEmails(rows).pipe(
            Effect.map((publications) =>
              rows.map((campaign) => {
                const summary = toAdministrationCampaignSummary(campaign);
                return campaign.emailId
                  ? {
                      ...summary,
                      locales: linkedLocales(publications.get(campaign.id)),
                    }
                  : summary;
              })
            )
          );
        })
      ),
    getCampaign: ({ campaignId }) =>
      campaigns.get(campaignId).pipe(Effect.flatMap(campaignDetail)),
    getCampaignEditorContent: ({ campaignId }) =>
      campaigns
        .get(campaignId)
        .pipe(
          Effect.flatMap((campaign) =>
            withLinkedLocales(
              campaign,
              toAdministrationCampaignEditorContent(campaign)
            )
          )
        ),
    createCampaign: ({ campaign }) =>
      readCampaignContent(campaign.content).pipe(
        Effect.flatMap((content) =>
          campaigns.create({
            title: campaign.title,
            purpose: campaign.purpose,
            templateKey: campaign.templateKey,
            audienceId: campaign.audienceId,
            delivery: campaign.delivery ?? "once",
            ...(campaign.emailId && { emailId: campaign.emailId }),
            content,
          })
        ),
        Effect.flatMap(campaignDetail)
      ),
    updateCampaign: (input) =>
      campaigns.patch(input).pipe(Effect.flatMap(campaignDetail)),
    duplicateCampaign: ({ campaignId }) =>
      campaigns.duplicate(campaignId).pipe(Effect.flatMap(campaignDetail)),
    deleteCampaign: ({ campaignId }) =>
      campaigns.delete(campaignId).pipe(Effect.as({ id: campaignId })),
    previewCampaignRecipients: ({ campaignId }) =>
      previewCampaignRecipients(campaignId),
    // Resolved per call, so a deployment without campaign email still
    // serves every other operation.
    getCampaignSettings: () =>
      toCampaignSettings(
        CampaignEmailConfig.pipe(Effect.provide(CampaignEmailConfig.Default))
      ),
    testSendCampaign: ({ campaignId, recipients: extraRecipients }) =>
      sending.testSend({ campaignId, extraRecipients }).pipe(
        Effect.map((result) => ({
          recipients: result.recipients,
          locales: result.locales,
          codeExpiresAt: result.codeExpiresAt.toString(),
        }))
      ),
    sendCampaign: (input) => sending.send(input),
    retryCampaign: (input) => sending.retryUndelivered(input),
    getCampaignSendStatus: ({ campaignId }) =>
      sendStatus
        .get({ campaignId })
        .pipe(Effect.map(toAdministrationSendStatus)),
    getAutomation: ({ campaignId }) => automations.get(campaignId),
    updateAutomationFlow: (input) => automations.updateFlow(input),
    dryRunAutomation: ({ campaignId }) => dryRuns.start(campaignId),
    getAutomationDryRun: (input) => dryRuns.get(input),
    activateAutomation: (input) =>
      CurrentAdministrator.pipe(
        Effect.flatMap(({ accountId }) =>
          automations.activate({ ...input, activatedBy: accountId })
        )
      ),
    pauseAutomation: ({ campaignId }) => automations.pause(campaignId),
    resumeAutomation: ({ campaignId }) => automations.resume(campaignId),
    archiveAutomation: ({ campaignId }) => automations.archive(campaignId),
    listAutomationVersions: ({ campaignId }) =>
      automations.listVersions(campaignId),
    getAutomationVersion: (input) => automations.getVersion(input),
    getAutomationRunStats: (input) => runLog.getRunStats(input),
    listAutomationRuns: (input) => runLog.listRuns(input),
    getAutomationRun: (input) => runLog.getRun(input),
    previewCalendarExpression: (input) => previewCalendarExpression(input),
    getAutomationEngineHealth: () => engineHealth.get,
  };

  return handlers;
});
