import type { DotyposService } from "@deskohub/dotypos";
import type { EmailServiceTag } from "@deskohub/email";
import { Layer } from "effect";
import type { WorkspaceDatabase } from "@/db/database.service";
import { CustomerValues } from "@/features/emails/values/customer";
import { syntheticEmailCustomer } from "@/features/emails/values/preparation/synthetic-email-customer";
import { AnalyticsConsentLedger } from "@/features/legal/backend/analytics-consent-ledger";
import { CampaignBatchDelivery } from "./campaign-batch-delivery.service";
import { CampaignDeliveryService } from "./campaign-delivery.service";
import type { CampaignEmailConfig } from "./campaign-email.config";
import { campaignOfferPreparationLayers } from "./campaign-personalized-delivery";
import { CampaignRecipientAnalyticsIdentity } from "./campaign-recipient-analytics-identity.service";
import { CampaignUnsubscribeService } from "./campaign-unsubscribe.service";

/**
 * The campaign batch protocol and the one-off delivery service on the
 * Dotypos, email provider and sender configuration a test supplies, with
 * real unsubscribe links and recipient analytics identities read through
 * `analyticsConsent` (the real ledger unless the test supplies one). The
 * test provides the Workspace database.
 */
export const campaignDeliveryTestLayer = <E, R>(
  dependencies: Layer.Layer<
    DotyposService | EmailServiceTag | CampaignEmailConfig,
    E,
    R
  >,
  analyticsConsent: Layer.Layer<
    AnalyticsConsentLedger,
    never,
    WorkspaceDatabase
  > = AnalyticsConsentLedger.Default,
  customers: Layer.Layer<CustomerValues> = CustomerValues.Synthetic(
    syntheticEmailCustomer
  )
) => {
  const batches = CampaignBatchDelivery.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        dependencies,
        campaignOfferPreparationLayers(customers),
        CampaignRecipientAnalyticsIdentity.Default.pipe(
          Layer.provide(analyticsConsent)
        ),
        CampaignUnsubscribeService.Default
      )
    )
  );
  return CampaignDeliveryService.Default.pipe(Layer.provideMerge(batches));
};
