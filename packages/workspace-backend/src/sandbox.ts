import { randomUUID } from "node:crypto";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { CampaignContentHash } from "@deskohub/workspace-domain/features/email-campaigns/campaign-content-hash";
import {
  campaignIdSchema,
  campaignSendIdSchema,
} from "@deskohub/workspace-domain/features/email-campaigns/campaign-identifiers";
import { currentInstant } from "@deskohub/workspace-domain/shared/utils/temporal";
import { CampaignUnsubscribeToken } from "@deskohub/workspace-rpc";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "./db/database.service";
import {
  customerMarketingConsents,
  emailCampaignRecipients,
  emailCampaignSends,
  emailCampaigns,
} from "./db/schema";
import { CampaignUnsubscribeService } from "./features/email-campaigns/backend/campaign-unsubscribe.service";

export class WorkspaceSandboxFixture extends Context.Service<
  WorkspaceSandboxFixture,
  { readonly issue: () => Effect.Effect<CampaignUnsubscribeToken> }
>()("@deskohub/workspace-backend/WorkspaceSandboxFixture") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db, transaction } = yield* WorkspaceDatabase;
      const unsubscribe = yield* CampaignUnsubscribeService;

      return {
        issue: Effect.fn("WorkspaceSandboxFixture.issue")(function* () {
          const campaignId = campaignIdSchema.make(randomUUID());
          const sendId = campaignSendIdSchema.make(randomUUID());
          const dotyposCustomerId = DotyposCustomerIdSchema.make(
            `workspace-sandbox-${randomUUID()}`
          );

          yield* transaction(
            Effect.gen(function* () {
              yield* db.insert(emailCampaigns).values({
                id: campaignId,
                title: "Workspace sandbox proof",
                purpose: "marketing",
                templateKey: "workspace",
              });
              yield* db.insert(emailCampaignSends).values({
                id: sendId,
                campaignId,
                audienceFilter: { _tag: "Group", operator: "and", filters: [] },
                contentHash: CampaignContentHash.make("0".repeat(64)),
              });
              yield* db.insert(emailCampaignRecipients).values({
                sendId,
                dotyposCustomerId,
                locale: "cs-CZ",
                status: "delivered",
              });
              yield* db.insert(customerMarketingConsents).values({
                dotyposCustomerId,
                documentHash: "workspace-sandbox-proof",
                locale: "cs-CZ",
                grantedAt: yield* currentInstant,
              });
            })
          ).pipe(
            Effect.catch(() =>
              Effect.die(
                new Error("Workspace sandbox fixture could not be created")
              )
            )
          );

          return CampaignUnsubscribeToken.make(
            yield* unsubscribe.sign({ sendId, dotyposCustomerId })
          );
        }),
      };
    })
  );
}

const workspaceSandboxFixtureLayer = WorkspaceSandboxFixture.Default;

export { workspaceSandboxFixtureLayer as WorkspaceSandboxFixtureLive };
