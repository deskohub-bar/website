import { Effect } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  destructiveOperation,
  readPreview,
  writeOperation,
} from "./administration-operation";
import {
  emailAutomationOperations,
  emailCampaignOperations,
} from "./campaign-operations";
import { campaignErrors } from "./email-campaigns";
import {
  bareRequest,
  bodyRequest,
  type OperationGroupServer,
  operationGroup,
  operationHandler,
  paramsBodyRequest,
  paramsFieldRequest,
  paramsQueryRequest,
  paramsRequest,
  servesOperation,
} from "./operation-endpoints";
import { administrationOperationGroupCheckingDhwFirst } from "./workspace-admin-api";

const campaignEndpoints = administrationOperationGroupCheckingDhwFirst(
  HttpApiGroup.make("campaigns").add(
    HttpApiEndpoint.get(
      ...bareRequest(
        emailCampaignOperations.listCampaignAudiences,
        "/campaign-audiences",
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.listCampaignAudiences)),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailCampaignOperations.getCampaignAudience,
        "/campaign-audiences/:audienceId",
        ["audienceId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.getCampaignAudience)),
    HttpApiEndpoint.post(
      ...bodyRequest(
        emailCampaignOperations.createCampaignAudience,
        "/campaign-audiences",
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.createCampaignAudience, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.patch(
      ...paramsBodyRequest(
        emailCampaignOperations.updateCampaignAudience,
        "/campaign-audiences/:audienceId",
        ["audienceId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.updateCampaignAudience, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsRequest(
        emailCampaignOperations.archiveCampaignAudience,
        "/campaign-audiences/:audienceId/archive",
        ["audienceId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.archiveCampaignAudience, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview("campaigns.getCampaignAudience"),
        }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsRequest(
        emailCampaignOperations.unarchiveCampaignAudience,
        "/campaign-audiences/:audienceId/unarchive",
        ["audienceId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.unarchiveCampaignAudience, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.delete(
      ...paramsRequest(
        emailCampaignOperations.deleteCampaignAudience,
        "/campaign-audiences/:audienceId",
        ["audienceId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.deleteCampaignAudience, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview("campaigns.getCampaignAudience"),
        }),
      })
    ),
    HttpApiEndpoint.get(
      ...bareRequest(
        emailCampaignOperations.listCampaignTemplates,
        "/campaign-templates",
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.listCampaignTemplates)),
    // The body is the preview request alone, as released `dhw` sends it.
    HttpApiEndpoint.post(
      ...paramsFieldRequest(
        emailCampaignOperations.previewCampaignTemplate,
        "/campaign-templates/:templateKey/preview",
        ["templateKey"],
        "preview",
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.previewCampaignTemplate, {
        body: "preview",
      })
    ),
    HttpApiEndpoint.get(
      ...bareRequest(
        emailCampaignOperations.listCampaigns,
        "/campaigns",
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.listCampaigns)),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailCampaignOperations.getCampaign,
        "/campaigns/:campaignId",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.getCampaign)),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailCampaignOperations.getCampaignEditorContent,
        "/campaigns/:campaignId/editor-content",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.getCampaignEditorContent)),
    HttpApiEndpoint.post(
      ...bodyRequest(
        emailCampaignOperations.createCampaign,
        "/campaigns",
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.createCampaign, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.patch(
      ...paramsBodyRequest(
        emailCampaignOperations.updateCampaign,
        "/campaigns/:campaignId",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.updateCampaign, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsBodyRequest(
        emailCampaignOperations.duplicateCampaign,
        "/campaigns/:campaignId/duplicate",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.duplicateCampaign, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.delete(
      ...paramsRequest(
        emailCampaignOperations.deleteCampaign,
        "/campaigns/:campaignId",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.deleteCampaign, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview("campaigns.getCampaign"),
        }),
      })
    ),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailCampaignOperations.previewCampaignRecipients,
        "/campaigns/:campaignId/recipients",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.previewCampaignRecipients)),
    HttpApiEndpoint.get(
      ...bareRequest(
        emailCampaignOperations.getCampaignSettings,
        "/campaigns/settings",
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.getCampaignSettings)),
    HttpApiEndpoint.post(
      ...paramsBodyRequest(
        emailCampaignOperations.testSendCampaign,
        "/campaigns/:campaignId/test-send",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.testSendCampaign, {
        behavior: writeOperation({ idempotent: false }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsBodyRequest(
        emailCampaignOperations.sendCampaign,
        "/campaigns/:campaignId/send",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.sendCampaign, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview(
            "campaigns.getCampaign",
            "campaigns.previewCampaignRecipients"
          ),
        }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsBodyRequest(
        emailCampaignOperations.retryCampaign,
        "/campaigns/:campaignId/retry",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailCampaignOperations.retryCampaign, {
        behavior: destructiveOperation({
          idempotent: false,
          preview: readPreview("campaigns.getCampaignSendStatus"),
        }),
      })
    ),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailCampaignOperations.getCampaignSendStatus,
        "/campaigns/:campaignId/status",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailCampaignOperations.getCampaignSendStatus))
  )
);

/** Serves every endpoint of `campaignEndpoints` with the operation of its name. */
const campaignServer: OperationGroupServer<
  typeof campaignEndpoints,
  typeof emailCampaignOperations
> = (api, invoker, outputs) =>
  HttpApiBuilder.group(api, "campaigns", (handlers) =>
    Effect.map(invoker, (invoke) => {
      const serve = operationHandler(
        campaignEndpoints,
        emailCampaignOperations,
        invoke,
        outputs
      );
      return handlers.handleAll({
        listCampaignAudiences: serve("listCampaignAudiences"),
        getCampaignAudience: serve("getCampaignAudience"),
        createCampaignAudience: serve("createCampaignAudience"),
        updateCampaignAudience: serve("updateCampaignAudience"),
        archiveCampaignAudience: serve("archiveCampaignAudience"),
        unarchiveCampaignAudience: serve("unarchiveCampaignAudience"),
        deleteCampaignAudience: serve("deleteCampaignAudience"),
        listCampaignTemplates: serve("listCampaignTemplates"),
        previewCampaignTemplate: serve("previewCampaignTemplate"),
        listCampaigns: serve("listCampaigns"),
        getCampaign: serve("getCampaign"),
        getCampaignEditorContent: serve("getCampaignEditorContent"),
        createCampaign: serve("createCampaign"),
        updateCampaign: serve("updateCampaign"),
        duplicateCampaign: serve("duplicateCampaign"),
        deleteCampaign: serve("deleteCampaign"),
        previewCampaignRecipients: serve("previewCampaignRecipients"),
        getCampaignSettings: serve("getCampaignSettings"),
        testSendCampaign: serve("testSendCampaign"),
        sendCampaign: serve("sendCampaign"),
        retryCampaign: serve("retryCampaign"),
        getCampaignSendStatus: serve("getCampaignSendStatus"),
      });
    })
  );

/**
 * The CLI's campaign endpoints. Every endpoint declares the
 * `CliInputInvalid` an outdated `dhw` is refused with, so released binaries
 * print the refusal.
 */
export const AdminCliCampaignsApi = operationGroup(
  campaignEndpoints,
  emailCampaignOperations,
  campaignServer
);

const automationEndpoints = administrationOperationGroupCheckingDhwFirst(
  HttpApiGroup.make("automations").add(
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailAutomationOperations.getAutomation,
        "/automations/:campaignId/flow",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.getAutomation)),
    HttpApiEndpoint.put(
      ...paramsBodyRequest(
        emailAutomationOperations.updateAutomationFlow,
        "/automations/:campaignId/flow",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailAutomationOperations.updateAutomationFlow, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsRequest(
        emailAutomationOperations.dryRunAutomation,
        "/automations/:campaignId/dry-run",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailAutomationOperations.dryRunAutomation, {
        behavior: writeOperation({ idempotent: false }),
      })
    ),
    HttpApiEndpoint.get(
      ...paramsQueryRequest(
        emailAutomationOperations.getAutomationDryRun,
        "/automation-dry-runs/:previewId",
        ["previewId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.getAutomationDryRun)),
    HttpApiEndpoint.post(
      ...paramsBodyRequest(
        emailAutomationOperations.activateAutomation,
        "/automations/:campaignId/activate",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailAutomationOperations.activateAutomation, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview("automations.getAutomation"),
        }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsRequest(
        emailAutomationOperations.pauseAutomation,
        "/automations/:campaignId/pause",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailAutomationOperations.pauseAutomation, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview("automations.getAutomation"),
        }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsRequest(
        emailAutomationOperations.resumeAutomation,
        "/automations/:campaignId/resume",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailAutomationOperations.resumeAutomation, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview("automations.getAutomation"),
        }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsRequest(
        emailAutomationOperations.archiveAutomation,
        "/automations/:campaignId/archive",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(
      servesOperation(emailAutomationOperations.archiveAutomation, {
        behavior: destructiveOperation({
          idempotent: true,
          preview: readPreview("automations.getAutomation"),
        }),
      })
    ),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailAutomationOperations.listAutomationVersions,
        "/automations/:campaignId/versions",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.listAutomationVersions)),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailAutomationOperations.getAutomationVersion,
        "/automations/:campaignId/versions/:versionNumber",
        ["campaignId", "versionNumber"],
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.getAutomationVersion)),
    HttpApiEndpoint.get(
      ...paramsQueryRequest(
        emailAutomationOperations.getAutomationRunStats,
        "/automations/:campaignId/runs/stats",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.getAutomationRunStats)),
    HttpApiEndpoint.get(
      ...paramsQueryRequest(
        emailAutomationOperations.listAutomationRuns,
        "/automations/:campaignId/runs",
        ["campaignId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.listAutomationRuns)),
    HttpApiEndpoint.get(
      ...paramsRequest(
        emailAutomationOperations.getAutomationRun,
        "/automation-runs/:runId",
        ["runId"],
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.getAutomationRun)),
    HttpApiEndpoint.post(
      ...bodyRequest(
        emailAutomationOperations.previewCalendarExpression,
        "/calendar-expressions/preview",
        campaignErrors
      )
    ).pipe(
      servesOperation(emailAutomationOperations.previewCalendarExpression)
    ),
    HttpApiEndpoint.get(
      ...bareRequest(
        emailAutomationOperations.getAutomationEngineHealth,
        "/automations/engine-health",
        campaignErrors
      )
    ).pipe(servesOperation(emailAutomationOperations.getAutomationEngineHealth))
  )
);

/** Serves every endpoint of `automationEndpoints` with the operation of its name. */
const automationServer: OperationGroupServer<
  typeof automationEndpoints,
  typeof emailAutomationOperations
> = (api, invoker, outputs) =>
  HttpApiBuilder.group(api, "automations", (handlers) =>
    Effect.map(invoker, (invoke) => {
      const serve = operationHandler(
        automationEndpoints,
        emailAutomationOperations,
        invoke,
        outputs
      );
      return handlers.handleAll({
        getAutomation: serve("getAutomation"),
        updateAutomationFlow: serve("updateAutomationFlow"),
        dryRunAutomation: serve("dryRunAutomation"),
        getAutomationDryRun: serve("getAutomationDryRun"),
        activateAutomation: serve("activateAutomation"),
        pauseAutomation: serve("pauseAutomation"),
        resumeAutomation: serve("resumeAutomation"),
        archiveAutomation: serve("archiveAutomation"),
        listAutomationVersions: serve("listAutomationVersions"),
        getAutomationVersion: serve("getAutomationVersion"),
        getAutomationRunStats: serve("getAutomationRunStats"),
        listAutomationRuns: serve("listAutomationRuns"),
        getAutomationRun: serve("getAutomationRun"),
        previewCalendarExpression: serve("previewCalendarExpression"),
        getAutomationEngineHealth: serve("getAutomationEngineHealth"),
      });
    })
  );

/** The CLI's automation endpoints, with the campaign endpoints' errors. */
export const AdminCliAutomationsApi = operationGroup(
  automationEndpoints,
  emailAutomationOperations,
  automationServer
);
