import "server-only";

import {
  CampaignUnsubscribeService as CampaignUnsubscribe,
  type ICampaignUnsubscribeService as CampaignUnsubscribeOperations,
} from "@deskohub/workspace-backend/features/email-campaigns/backend/campaign-unsubscribe.service";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { appendVercelPreviewProtectionBypass } from "@/features/checkout/backend/checkout/vercel-preview-protection-bypass";
import { getRuntimeMarketingPreferencesAccessUrl } from "@/features/legal/marketing-preferences-access-url";
import {
  getWorkspaceRuntimeCallbackOrigin,
  type WorkspaceUrlConfigError,
} from "@/shared/backend/config/workspace-url.config";

export interface ICampaignUnsubscribeService {
  readonly unsubscribe: CampaignUnsubscribeOperations["unsubscribe"];
  readonly unsubscribeUrl: (
    recipient: Parameters<CampaignUnsubscribeOperations["sign"]>[0]
  ) => Effect.Effect<string, WorkspaceUrlConfigError>;
  readonly preferencesUrl: (
    token: string
  ) => Effect.Effect<
    string,
    | Effect.Error<ReturnType<CampaignUnsubscribeOperations["openPreferences"]>>
    | WorkspaceUrlConfigError
  >;
}

/** Builds public links on the frontend origin. */
export class CampaignUnsubscribeService extends Context.Service<
  CampaignUnsubscribeService,
  ICampaignUnsubscribeService
>()("@deskohub-workspace/email-campaigns/CampaignUnsubscribeService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const unsubscribe = yield* CampaignUnsubscribe;
      return {
        unsubscribe: unsubscribe.unsubscribe,
        unsubscribeUrl: Effect.fn("CampaignUnsubscribeService.unsubscribeUrl")(
          function* (recipient) {
            const url = new URL(
              "/api/email-campaigns/unsubscribe",
              yield* getWorkspaceRuntimeCallbackOrigin
            );
            url.searchParams.set("token", yield* unsubscribe.sign(recipient));
            appendVercelPreviewProtectionBypass(url);
            return url.href;
          }
        ),
        preferencesUrl: (token) =>
          unsubscribe
            .openPreferences(token)
            .pipe(
              Effect.flatMap((accessToken) =>
                getRuntimeMarketingPreferencesAccessUrl(accessToken)
              )
            ),
      };
    })
  ).pipe(Layer.provide(CampaignUnsubscribe.Configured));

  static Live = this.Default.pipe(Layer.provide(WorkspaceDatabase.Default));
}
