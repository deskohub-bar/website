import {
  Caller,
  CallerContext,
  CampaignUnsubscribeRejected,
  decodeCallerHeaders,
  EmailPreferencesRpcs,
  MarketingManagementAccessToken,
} from "@deskohub/workspace-rpc";
import { Effect, Layer, Match } from "effect";
import { CampaignUnsubscribeService } from "./features/email-campaigns/backend/campaign-unsubscribe.service";

export const CallerContextLive = Layer.succeed(
  CallerContext,
  (effect, { headers }) =>
    Effect.flatMap(decodeCallerHeaders(headers), (caller) =>
      effect.pipe(
        Effect.provideService(Caller, caller),
        Effect.annotateLogs({ correlationId: caller.correlationId }),
        Effect.annotateSpans({ correlationId: caller.correlationId })
      )
    )
);

const campaignRpc = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
) =>
  Effect.catch(effect, (error) =>
    Match.value(error._tag).pipe(
      Match.when("CampaignUnsubscribeTokenInvalid", () =>
        Effect.fail(new CampaignUnsubscribeRejected())
      ),
      Match.orElse(() =>
        Effect.logError("Email preferences RPC failed", {
          failure: error._tag,
        }).pipe(
          Effect.andThen(
            Effect.die(new Error("Email preferences are unavailable"))
          )
        )
      )
    )
  );

export const WorkspaceRpcHandlers = EmailPreferencesRpcs.toLayer(
  Effect.gen(function* () {
    const preferences = yield* CampaignUnsubscribeService;
    return EmailPreferencesRpcs.of({
      "EmailPreferences.openPreferences": ({ token }) =>
        campaignRpc(preferences.openPreferences(token)).pipe(
          Effect.map((accessToken) => ({
            accessToken: MarketingManagementAccessToken.make(accessToken),
          }))
        ),
      "EmailPreferences.unsubscribeOneClick": ({ token }) =>
        campaignRpc(Effect.uninterruptible(preferences.unsubscribe(token))),
    });
  })
);
