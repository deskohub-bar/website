import {
  type CampaignLocalizedContent,
  type CampaignPurpose,
  type CampaignTemplateKey,
  campaignLocaleContentFields,
  campaignLocaleSchema,
} from "@deskohub/workspace-domain/features/email-campaigns/campaign-content";
import { type Option, Schema } from "effect";
import { campaignBodyDocument } from "./campaign-body-document";

export {
  type CampaignLocalizedContent,
  CampaignPurpose,
  CampaignTemplateKey,
} from "@deskohub/workspace-domain/features/email-campaigns/campaign-content";

/**
 * One locale's campaign texts. Its body's images must come from the
 * Cloudinary account `imageCloudName`.
 */
export const campaignLocaleContent = (imageCloudName: Option.Option<string>) =>
  Schema.Struct({
    ...campaignLocaleContentFields,
    body: campaignBodyDocument(imageCloudName),
  });
export type CampaignLocaleContent = ReturnType<
  typeof campaignLocaleContent
>["Type"];

/** Per-locale campaign texts; a locale without content is absent. */
export const campaignLocalizedContent = (
  imageCloudName: Option.Option<string>
) =>
  Schema.Record(
    campaignLocaleSchema,
    Schema.optionalKey(campaignLocaleContent(imageCloudName))
  );

/** Everything a campaign email renders from. */
export type CampaignContent = {
  readonly purpose: CampaignPurpose;
  readonly templateKey: CampaignTemplateKey;
  readonly locales: CampaignLocalizedContent;
};
