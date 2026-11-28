import { CampaignUnsubscribeTokenInvalid } from "@deskohub/workspace-domain/features/email-campaigns/campaign-token-errors";
import { and, eq } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "../../../db/database.service";
import {
  emailCampaignAutomationVersions,
  emailCampaignRecipients,
  emailCampaignSends,
  emailCampaigns,
} from "../../../db/schema";
import {
  MarketingConsentLedger,
  type MarketingConsentUnavailable,
} from "../../legal/backend/marketing-consent-ledger";
import {
  type MarketingManagementError,
  MarketingManagementService,
} from "../../legal/backend/marketing-management.service";
import {
  type CampaignUnsubscribeRecipient,
  openCampaignUnsubscribeToken,
  signCampaignUnsubscribeToken,
} from "../campaign-unsubscribe-token";
import { sendAutomationVersion, sendPurpose } from "./campaign-send-selection";
import { loadCampaignSigningKeys } from "./campaign-signing-keys";

type CampaignUnsubscribeOutcome = "withdrawn" | "unchanged";

export interface ICampaignUnsubscribeService {
  readonly sign: (
    recipient: CampaignUnsubscribeRecipient
  ) => Effect.Effect<string>;
  /**
   * Withdraws the marketing consent of the token's recipient. A repeated
   * request finds the consent withdrawn and changes nothing.
   */
  readonly unsubscribe: (
    token: string
  ) => Effect.Effect<
    CampaignUnsubscribeOutcome,
    | CampaignUnsubscribeTokenInvalid
    | EffectDrizzleQueryError
    | MarketingConsentUnavailable
  >;
  /** A fresh management token for the verified recipient. */
  readonly openPreferences: (
    token: string
  ) => Effect.Effect<
    string,
    | CampaignUnsubscribeTokenInvalid
    | EffectDrizzleQueryError
    | MarketingManagementError
  >;
}

/** One-click unsubscribe links of marketing campaign emails. */
export class CampaignUnsubscribeService extends Context.Service<
  CampaignUnsubscribeService,
  ICampaignUnsubscribeService
>()("@deskohub/workspace-backend/CampaignUnsubscribeService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const consents = yield* MarketingConsentLedger;
      const marketingManagement = yield* MarketingManagementService;
      const keys = yield* loadCampaignSigningKeys("unsubscribe-token");

      /**
       * Opens the token and checks that it names a recipient of a marketing
       * send, so a token for any other email can't touch consent.
       */
      const findRecipient = Effect.fn(
        "CampaignUnsubscribeService.findRecipient"
      )(function* (token: string) {
        const recipient = yield* openCampaignUnsubscribeToken(keys, token).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new CampaignUnsubscribeTokenInvalid()),
              onSome: Effect.succeed,
            })
          )
        );
        const [row] = yield* db
          .select({ purpose: sendPurpose })
          .from(emailCampaignRecipients)
          .innerJoin(
            emailCampaignSends,
            eq(emailCampaignSends.id, emailCampaignRecipients.sendId)
          )
          .innerJoin(
            emailCampaigns,
            eq(emailCampaigns.id, emailCampaignSends.campaignId)
          )
          .leftJoin(emailCampaignAutomationVersions, sendAutomationVersion)
          .where(
            and(
              eq(emailCampaignRecipients.sendId, recipient.sendId),
              eq(
                emailCampaignRecipients.dotyposCustomerId,
                recipient.dotyposCustomerId
              )
            )
          );
        if (row?.purpose !== "marketing") {
          return yield* new CampaignUnsubscribeTokenInvalid();
        }
        return recipient;
      });

      return {
        sign: (recipient) => signCampaignUnsubscribeToken(keys, recipient),
        unsubscribe: Effect.fn("CampaignUnsubscribeService.unsubscribe")(
          function* (token) {
            const { dotyposCustomerId } = yield* findRecipient(token);
            const withdrawn = yield* consents.withdrawActive(dotyposCustomerId);
            return withdrawn ? "withdrawn" : "unchanged";
          }
        ),
        openPreferences: Effect.fn(
          "CampaignUnsubscribeService.openPreferences"
        )(function* (token) {
          const { dotyposCustomerId } = yield* findRecipient(token);
          return yield* marketingManagement.issue(dotyposCustomerId);
        }),
      } satisfies ICampaignUnsubscribeService;
    })
  );

  static Configured = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        MarketingConsentLedger.Default,
        MarketingManagementService.Default
      )
    )
  );
}
