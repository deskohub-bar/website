import { Schema } from "effect";

export const CampaignContentHash = Schema.String.pipe(
  Schema.brand("CampaignContentHash")
).annotate({
  identifier: "CampaignContentHash",
  description:
    "SHA-256 of everything a campaign renders; a test-send confirmation code is bound to it.",
});
export type CampaignContentHash = typeof CampaignContentHash.Type;
