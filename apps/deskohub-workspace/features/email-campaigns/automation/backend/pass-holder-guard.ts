import "server-only";

import type { DotyposCustomer } from "@deskohub/dotypos";
import { DotyposService } from "@deskohub/dotypos";
import type { EmailVersionId } from "@deskohub/workspace-admin-api";
import { Effect, Option, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { customerHoldsCoveringPass } from "@/features/passes/backend/customer-pass-coverage";
import { currentInstant } from "@/shared/utils/temporal";
import {
  type BatchProfiles,
  BatchRequest,
  type BatchRequestClaim,
  type BatchRequestGuard,
  CampaignBatchDelivery,
  CampaignDeliveryIncomplete,
  type DeliveredAttempt,
  type PersistedBatch,
} from "../../backend/campaign-batch-delivery.service";
import { CampaignEmailConfig } from "../../backend/campaign-email.config";
import {
  CampaignEligibilityStage,
  campaignEligibility,
  consentingCampaignCustomers,
} from "../../backend/campaign-reachability";
import { renderFrozenEmailForBatch } from "./automated-campaign-send";

/**
 * The refusal code of a pass-holder-skipping send whose recipient's email
 * address or analytics identity changed after the batch was persisted: it
 * was never requested.
 */
const passHolderGuardRecipientChangedCode = "recipient-changed";

/**
 * Requests the one-customer batch of a Send that skips pass holders
 * through a guard that runs immediately before each provider request. The
 * guard rechecks the customer's consent and reachability and skips them
 * when they hold a covering pass then. A read the guard can't make leaves
 * the batch unrequested for the unit's retry. Guarded requests stay with
 * the chain's first provider.
 */
export const makePassHolderGuard = Effect.gen(function* () {
  const { db } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;
  const config = yield* CampaignEmailConfig;
  const batches = yield* CampaignBatchDelivery;
  const context = yield* Effect.context<WorkspaceDatabase>();

  const profilesFor = (batch: PersistedBatch) =>
    dotypos
      .getCustomersByIds(batch.dotyposCustomerIds, { concurrency: 1 })
      .pipe(Effect.mapError(() => incompleteRequest(batch)));

  const guard = (input: {
    readonly send: DeliveredAttempt;
    readonly batch: PersistedBatch;
    readonly expected: DotyposCustomer | undefined;
  }): BatchRequestGuard =>
    Effect.gen(function* () {
      const [id] = input.batch.dotyposCustomerIds;
      if (id === undefined) return true as const;
      const profiles = yield* profilesFor(input.batch);
      // `skipPassHolders` rechecks active marketing consent whatever the
      // campaign's purpose: an operational Send using it is still gated.
      const consenting = yield* consentingCampaignCustomers({
        db,
        purpose: "marketing",
        customerIds: [id],
      });
      const reachable = campaignEligibility({
        profile: Option.fromNullishOr(profiles.get(id)),
        stage: CampaignEligibilityStage.Delivery({
          consenting: consenting.has(id),
          deploymentEnvironment: config.deploymentEnvironment,
        }),
      });
      if (Result.isFailure(reachable)) return { skipReason: reachable.failure };

      const persisted = campaignEligibility({
        profile: Option.fromNullishOr(input.expected),
        stage: CampaignEligibilityStage.Resolution(),
      });
      if (
        Result.isFailure(persisted) ||
        persisted.success !== reachable.success
      )
        return { failureCode: passHolderGuardRecipientChangedCode };

      const covered = yield* currentInstant.pipe(
        Effect.flatMap((now) => customerHoldsCoveringPass(id, now)),
        Effect.provideContext(context),
        Effect.mapError(() => incompleteRequest(input.batch))
      );
      return covered ? { skipReason: "pass-holder" as const } : (true as const);
    });

  /**
   * The request of a persisted batch of the send: with the profiles it was
   * persisted from on the first request, or re-read for a replay. A send
   * whose version froze an Email Library email delivers its rendering.
   */
  const request =
    (input: {
      readonly profiles: Option.Option<BatchProfiles>;
      readonly claim: BatchRequestClaim;
    }) =>
    (
      send: DeliveredAttempt,
      batch: PersistedBatch,
      frozenEmailVersionId: EmailVersionId | null
    ) =>
      batches.request(
        BatchRequest.Guarded({
          batch,
          claim: input.claim,
          failureCodeOnStalePayload: passHolderGuardRecipientChangedCode,
          prepare: Effect.gen(function* () {
            const [id, ...others] = batch.dotyposCustomerIds;
            if (id === undefined || others.length > 0) return Option.none();
            const profiles = yield* Option.match(input.profiles, {
              onSome: Effect.succeed,
              onNone: () => profilesFor(batch),
            });
            const delivered =
              frozenEmailVersionId === null
                ? send
                : {
                    ...send,
                    campaign: {
                      ...send.campaign,
                      renderedByCustomer: yield* renderFrozenEmailForBatch(db, {
                        sendId: batch.sendId,
                        batch,
                        frozenEmailVersionId,
                      }),
                    },
                  };
            return Option.some({
              send: delivered,
              profiles,
              guard: guard({ send, batch, expected: profiles.get(id) }),
            });
          }),
        })
      );

  return { request };
});

const incompleteRequest = ({ sendId, deliveryAttempt }: PersistedBatch) =>
  new CampaignDeliveryIncomplete({ sendId, deliveryAttempt });
