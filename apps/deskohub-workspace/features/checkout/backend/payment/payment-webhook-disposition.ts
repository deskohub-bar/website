import type { WebhookDisposition } from "@/shared/backend/service-route";
import type { WebhookFailure } from "./payment-webhook-processor";

export const paymentWebhookDisposition = {
  inactive_provider: { kind: "declined", severity: "error" },
  parse_failed: {
    kind: "rejected",
    status: 400,
    severity: "error",
  },
  unknown_order: { kind: "declined", severity: "error" },
  missing_security_token: { kind: "declined", severity: "error" },
  invalid_currency: { kind: "declined", severity: "error" },
  verification_failed: { kind: "retry", severity: "error" },
  verification_mismatch: { kind: "declined", severity: "error" },
  late_payment: { kind: "declined", severity: "fatal" },
  late_payment_recovery_failed: {
    kind: "retry",
    severity: "error",
  },
  refund_reconciliation_failed: {
    kind: "retry",
    severity: "error",
  },
  transition_failed: { kind: "retry", severity: "fatal" },
  fulfillment_failed: { kind: "retry", severity: "fatal" },
} satisfies Record<WebhookFailure, WebhookDisposition>;
