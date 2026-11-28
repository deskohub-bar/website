import { Effect } from "effect";
import { CampaignDeliveryService } from "@/features/email-campaigns/backend/campaign-delivery.service";
import { campaignSendTopic } from "@/features/email-campaigns/backend/campaign-send-queue.service";
import { processCampaignSendMessage } from "@/features/email-campaigns/backend/campaign-send-queue-consumer";
import { defineQueueRoute } from "@/shared/backend/queue/queue-route";

export const maxDuration = 300;

export const POST = defineQueueRoute(
  "emailCampaignSendQueue",
  campaignSendTopic.topic,
  campaignSendTopic.consume((attempt) =>
    processCampaignSendMessage(attempt).pipe(
      Effect.provide(CampaignDeliveryService.Live)
    )
  )
);
