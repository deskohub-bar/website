import { Layer } from "effect";
import { CustomerReservationHistoryService } from "@/features/account";
import { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import { CheckoutStatusService } from "@/features/checkout/backend/checkout/checkout-status.service";
import { OfficeReleaseGate } from "@/features/office/backend/office-release-gate";
import { CoworkPassesReleaseGateForRun } from "@/features/passes/backend/cowork-passes-release-gate";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import { ReferralReleaseGateRequest } from "@/features/referrals/referral-release-gate.server";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import { SharedAvailabilityInventoryLive } from "@/features/reservation/backend/availability-inventory-cache.server";
import { OvernightStayReleaseGate } from "@/features/reservation/backend/overnight-stay-release-gate";
import { ReservationBooking } from "@/features/reservation/backend/reservation-booking.service";
import { SharedReservationRecordsLive } from "@/features/reservation/backend/reservation-records-cache.server";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { ReservationInvitees } from "@/features/reservation-invitees/backend/reservation-invitees.service";
import { ReviewSandbox } from "@/features/review-accounts";
import { TeamTableReleaseGateForRun } from "@/features/team-table/backend/team-table-release-gate-run";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";

/**
 * Public availability and Office capacity use shared advisory snapshots. A
 * complete Team Table quote rechecks its interval with the provider. Signed-in
 * tools book live and read the customer's own reservations from the shared
 * reservation records. An agent's tool call has no browser, so it remembers
 * no referral code.
 */
export const CustomerAgentToolsLive = Layer.mergeAll(
  CoworkPassesReleaseGateForRun,
  CustomerPasses.Default,
  WorkspaceAvailabilityService.Live,
  SharedAvailabilityInventoryLive,
  Layer.mergeAll(CheckoutPricingService.Live, ReservationBooking.Live).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ReferralReleaseGateRequest,
        OfficeReleaseGate.Live,
        TeamTableReleaseGateForRun,
        OvernightStayReleaseGate.Live
      )
    )
  ),
  RememberedReferral.none,
  WorkspaceReservationRepository.Live,
  CheckoutStatusService.withRecords(SharedReservationRecordsLive),
  CustomerReservationHistoryService.withRecords(SharedReservationRecordsLive),
  ReviewSandbox.Live,
  ReservationInvitees.Default,
  SealedStateKeys.Default
);
