import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CallerContext } from "./caller";

export const CampaignUnsubscribeToken = Schema.String.pipe(
  Schema.brand("CampaignUnsubscribeToken")
).annotate({
  identifier: "CampaignUnsubscribeToken",
  description: "Opaque token from the unsubscribe link in a campaign email.",
});
export type CampaignUnsubscribeToken = typeof CampaignUnsubscribeToken.Type;

export const MarketingManagementAccessToken = Schema.NonEmptyString.pipe(
  Schema.brand("MarketingManagementAccessToken")
).annotate({
  identifier: "MarketingManagementAccessToken",
  description: "Fresh access token issued when opening marketing preferences.",
});
export type MarketingManagementAccessToken =
  typeof MarketingManagementAccessToken.Type;

export const MarketingManagementAccessGrant = Schema.Struct({
  accessToken: MarketingManagementAccessToken,
});

export const CampaignUnsubscribeOutcome = Schema.Literals([
  "withdrawn",
  "unchanged",
]);

export class CampaignUnsubscribeRejected extends Schema.TaggedError<CampaignUnsubscribeRejected>()(
  "CampaignUnsubscribeRejected",
  {}
) {}

export const openPreferences = "EmailPreferences.openPreferences";
export const unsubscribeOneClick = "EmailPreferences.unsubscribeOneClick";

export class EmailPreferencesRpcs extends RpcGroup.make(
  Rpc.make(openPreferences, {
    payload: { token: CampaignUnsubscribeToken },
    success: MarketingManagementAccessGrant,
    error: CampaignUnsubscribeRejected,
  }),
  Rpc.make(unsubscribeOneClick, {
    payload: { token: CampaignUnsubscribeToken },
    success: CampaignUnsubscribeOutcome,
    error: CampaignUnsubscribeRejected,
  })
).middleware(CallerContext) {}
