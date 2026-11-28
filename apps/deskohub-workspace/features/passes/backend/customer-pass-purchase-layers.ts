import { Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { AccountingStorage } from "@/features/accounting/backend/accounting-storage";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentProvidersLive } from "@/features/checkout/backend/payment/payment-providers";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import { DiscountService } from "@/features/discounts/discount.service";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { ReferralReleaseGateForRun } from "@/features/referrals/referral-release-gate-run";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";

const passPricing = DiscountService.Live.pipe(
  Layer.provide(ReferralReleaseGateForRun)
);

const buyerCheckout = Layer.mergeAll(
  WorkspaceDatabase.Default,
  WorkspaceFeatureFlagService.Default,
  CustomerAccountContactService.ForProvidedAuthentication,
  CustomerAccountSections.ForProvidedAuthentication,
  passPricing
);

const availability = Layer.mergeAll(
  WorkspaceDatabase.Default,
  WorkspaceFeatureFlagService.Default,
  WorkspaceDotyposLayer,
  GoogleCalendarWorkspaceLimitationsService.Live,
  WorkspaceDatabaseAdvisoryLock.Default,
  WorkspaceReservationRepository.Default.pipe(
    Layer.provide(WorkspaceDatabase.Default)
  )
);

const begin = Layer.mergeAll(buyerCheckout, availability);

/** Purchase dependencies that use the authentication supplied by the caller. */
export const customerPassPurchaseLayers = {
  begin,
  reprice: buyerCheckout,
  agentStart: Layer.mergeAll(begin, SealedStateKeys.Default),
  availability,
  payment: Layer.mergeAll(
    buyerCheckout,
    AccountingStorage.Live,
    OrderPaymentHandlers.Live,
    LatePaymentVerificationService.Live,
    LegalEvidenceEventRepository.Live,
    CheckoutAnalytics.Live,
    PaymentProvidersLive,
    WorkspaceDotyposLayer
  ),
  status: Layer.mergeAll(
    WorkspaceDatabase.Default,
    AccountingStorage.Live,
    WorkspaceFeatureFlagService.Default,
    ProviderPaymentFinalizationService.Live,
    LatePaymentVerificationService.Live
  ),
};
