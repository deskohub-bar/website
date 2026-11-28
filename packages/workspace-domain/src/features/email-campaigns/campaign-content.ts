import { supportedLocales } from "@deskohub/i18n/locale-registry";
import { AdministrationCampaignBodyDocument } from "@deskohub/workspace-admin-api";
import { Schema } from "effect";

/** Marketing emails require consent. Operational emails carry a reason line. */
export const CampaignPurpose = Schema.Literals(["marketing", "operational"]);
export type CampaignPurpose = typeof CampaignPurpose.Type;

export const CampaignTemplateKey = Schema.Literals(["workspace"]);
export type CampaignTemplateKey = typeof CampaignTemplateKey.Type;

export const campaignLocaleContentFields = {
  subject: Schema.String,
  preheader: Schema.String,
  body: AdministrationCampaignBodyDocument,
  operationalReason: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isNonEmpty())
  ),
};

export const campaignLocaleSchema = Schema.Literals(supportedLocales);

const campaignLocaleContent = Schema.Struct(campaignLocaleContentFields);
const campaignLocalizedContent = Schema.Record(
  campaignLocaleSchema,
  Schema.optionalKey(campaignLocaleContent)
);

export type CampaignLocalizedContent = typeof campaignLocalizedContent.Type;
