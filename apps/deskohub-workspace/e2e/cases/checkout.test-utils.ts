import type { Effect } from "effect";
import {
  checkoutAttemptKeySchema,
  checkoutSessionKeySchema,
  paymentAttemptIdSchema,
} from "@/features/checkout/checkout-identifiers";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import type { WorkspaceE2EStep } from "../case-runner";
import type { E2EPaymentProvider } from "../e2e-env";
import type { WorkspaceE2EError } from "../errors";
import type { HostedProviderSessionRow } from "../integrations/database";
import type { CheckoutRow } from "../types";

const defaultCheckoutRow: CheckoutRow = {
  reservation_id: workspaceReservationIdSchema.make("order-id"),
  checkout_session_key: checkoutSessionKeySchema.make("checkout-session"),
  checkout_attempt_key: checkoutAttemptKeySchema.make("checkout-attempt"),
  correlation_id: "checkout-correlation",
  dotypos_customer_id: null,
  dotypos_reservation_id: null,
  reservation_state: "held",
  payment_state: "pending",
  fulfillment_state: "not_started",
  active_payment_attempt_id: null,
  reservation_details: null,
  locale: "en-US",
  reservation_created_at: null,
  reservation_hold_expires_at: null,
  reservation_confirmed_at: null,
  reservation_cancelled_at: null,
  reservation_hold_expired_at: null,
  paid_at: null,
  fulfilled_at: null,
  fulfillment_failed_at: null,
  failure_code: null,
  fulfillment_failure_code: null,
  payment_attempt_id: null,
  provider: null,
  provider_order_id: null,
  security_token: null,
  payment_attempt_state: null,
  amount_value: null,
  amount_exponent: null,
  currency: null,
  provider_redirect_url: null,
  last_webhook_event_id: null,
  last_provider_operation_id: null,
  last_provider_status: null,
  payment_failure_code: null,
  webhook_id: null,
  webhook_provider: null,
  webhook_event_id: null,
  webhook_provider_order_id: null,
  webhook_processed_at: null,
  webhook_state: null,
  webhook_error_code: null,
};

export const hostedCheckoutRow = (
  attempt: string,
  providerOrder: string,
  provider: E2EPaymentProvider = "nexi",
  row: Partial<CheckoutRow> = {}
): HostedProviderSessionRow => ({
  ...defaultCheckoutRow,
  ...row,
  amount_value: 25000,
  amount_exponent: 2,
  currency: "CZK",
  payment_attempt_id: paymentAttemptIdSchema.make(attempt),
  provider,
  provider_order_id: providerOrder,
  provider_redirect_url: "https://workspace.example.test/payment",
  security_token: "synthetic-security-token",
});

export type ObservedStep = Pick<
  WorkspaceE2EStep<unknown, never, "provider-verification" | undefined>,
  "id" | "permit"
>;

export const fixtureStep =
  <A>(
    observe: (step: ObservedStep) => void,
    execute: (id: string) => Effect.Effect<A, WorkspaceE2EError>
  ) =>
  (step: ObservedStep) => {
    observe(step);
    return execute(step.id);
  };
