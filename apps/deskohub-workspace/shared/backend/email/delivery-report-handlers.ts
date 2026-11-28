import { Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  customerAccessDeliveryReports,
  ReservationFulfillment,
} from "@/features/checkout/backend/fulfillment";
import { campaignDeliveryReports } from "@/features/email-campaigns/backend/campaign-delivery-reports";
import { CampaignDeliveryStatusService } from "@/features/email-campaigns/backend/campaign-delivery-status.service";
import {
  entryPackConfirmationDeliveryReports,
  unlimitedConfirmationDeliveryReports,
} from "@/features/passes/backend/pass-confirmation-delivery";
import type { DeliveryReportHandler } from "./delivery-reports";

/** The handlers of every email kind whose delivery reports Workspace applies. */
export const deliveryReportHandlers: readonly DeliveryReportHandler<
  ReservationFulfillment | CampaignDeliveryStatusService | WorkspaceDatabase
>[] = [
  customerAccessDeliveryReports,
  campaignDeliveryReports,
  entryPackConfirmationDeliveryReports,
  unlimitedConfirmationDeliveryReports,
];

/** The services the delivery-report handlers need. */
export const DeliveryReportHandlersLive = Layer.mergeAll(
  ReservationFulfillment.Live,
  CampaignDeliveryStatusService.Live,
  WorkspaceDatabase.Default
);
