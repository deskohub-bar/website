import {
  CampaignUnsubscribeRejected,
  CampaignUnsubscribeToken,
} from "@deskohub/workspace-rpc";
import { Config, Effect, Match, Schema } from "effect";
import { NextResponse } from "next/server";
import { CampaignUnsubscribeService } from "@/features/email-campaigns/backend/campaign-unsubscribe.service";
import { getRuntimeMarketingPreferencesAccessUrl } from "@/features/legal/marketing-preferences-access-url";
import { hasSignedClaimsEncoding } from "@/shared/backend/signed-claims";
import {
  defineWorkspaceRoute,
  WorkspaceRouteFailure,
} from "@/shared/backend/workspace-route";
import {
  withWorkspaceRpcClient,
  workspaceRpcCaller,
} from "@/shared/rpc/workspace-rpc-client.server";

const invalidLink = () =>
  new WorkspaceRouteFailure({
    statusCode: 400,
    publicMessage: "This unsubscribe link is invalid.",
  });

const linkToken = (request: Request) =>
  new URL(request.url).searchParams.get("token") ?? "";

const emailPreferencesTransport = Config.schema(
  Schema.Literals(["local", "rpc"]),
  "WORKSPACE_EMAIL_PREFERENCES_TRANSPORT"
).pipe(Config.withDefault("local"));

const decodeRpcToken = Schema.decodeEffect(
  CampaignUnsubscribeToken.check(Schema.makeFilter(hasSignedClaimsEncoding))
);

const rpcToken = (token: string) =>
  decodeRpcToken(token).pipe(
    Effect.mapError(() => new CampaignUnsubscribeRejected())
  );

const unsubscribe = Effect.fn("emailPreferences.unsubscribe")(function* (
  request: Request
) {
  const token = linkToken(request);
  if ((yield* emailPreferencesTransport) === "local") {
    return yield* CampaignUnsubscribeService.pipe(
      Effect.flatMap((service) => service.unsubscribe(token)),
      Effect.provide(CampaignUnsubscribeService.Live)
    );
  }

  const validated = yield* rpcToken(token);
  return yield* withWorkspaceRpcClient(workspaceRpcCaller(request), (client) =>
    client.unsubscribeOneClick({ token: validated })
  );
});

const preferencesUrl = Effect.fn("emailPreferences.preferencesUrl")(function* (
  request: Request
) {
  const token = linkToken(request);
  if ((yield* emailPreferencesTransport) === "local") {
    return yield* CampaignUnsubscribeService.pipe(
      Effect.flatMap((service) => service.preferencesUrl(token)),
      Effect.provide(CampaignUnsubscribeService.Live)
    );
  }

  const validated = yield* rpcToken(token);
  const caller = workspaceRpcCaller(request);
  const { accessToken } = yield* withWorkspaceRpcClient(caller, (client) =>
    client.openPreferences({ token: validated })
  );
  return yield* getRuntimeMarketingPreferencesAccessUrl(
    accessToken,
    caller.locale
  );
});

/**
 * POST /api/email-campaigns/unsubscribe?token=…
 *
 * RFC 8058 one-click unsubscribe: a mail client posts
 * `List-Unsubscribe=One-Click` here, and the recipient's marketing consent is
 * withdrawn. Repeating the request succeeds without changing anything.
 */
export const POST = defineWorkspaceRoute(
  {
    operation: "emailCampaignUnsubscribe",
    cancellation: "continue-after-disconnect",
    caller: "client",
  },
  (request) =>
    unsubscribe(request).pipe(
      Effect.tap((outcome) =>
        Effect.logInfo("Campaign unsubscribe processed", { outcome })
      ),
      Effect.as(NextResponse.json({ status: "unsubscribed" })),
      Effect.mapError((error) =>
        Match.value(error).pipe(
          Match.tag(
            "CampaignUnsubscribeTokenInvalid",
            "CampaignUnsubscribeRejected",
            invalidLink
          ),
          Match.orElse(
            WorkspaceRouteFailure.internal(
              "Unsubscribe could not be processed."
            )
          )
        )
      )
    )
);

/**
 * GET /api/email-campaigns/unsubscribe?token=…
 *
 * Opening the link (the email footer, or a client that only follows it)
 * never unsubscribes; it opens the recipient's marketing preferences.
 */
export const GET = defineWorkspaceRoute(
  {
    operation: "emailCampaignPreferences",
    cancellation: "interrupt-on-disconnect",
    caller: "client",
  },
  (request) =>
    preferencesUrl(request).pipe(
      Effect.map((url) => NextResponse.redirect(url, 303)),
      Effect.mapError((error) =>
        Match.value(error).pipe(
          Match.tag(
            "CampaignUnsubscribeTokenInvalid",
            "CampaignUnsubscribeRejected",
            invalidLink
          ),
          Match.orElse(
            WorkspaceRouteFailure.internal(
              "Marketing preferences could not be opened."
            )
          )
        )
      )
    )
);
