import "server-only";
import { env } from "@/env";
import { isSyntheticE2EEmailRecipient } from "@/features/account/backend/auth/magic-link-policy";
import { NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE } from "@/features/checkout/payment-fallback";
import { isEndedUnpaidPaymentState } from "@/features/order";
import type {
  PaymentCustomer,
  PaymentProvider,
  PaymentProviderMode,
  RetriedPaymentAttempt,
} from "./payment-provider";
import { allowsMockPaymentProvider } from "./payment-provider-environment";

export const isMockPaymentPreview = () => allowsMockPaymentProvider(env);

export const configuredPaymentProvider = (): PaymentProviderMode =>
  env.WORKSPACE_PAYMENT_PROVIDER ?? "nexi";

export const isMockPaymentEnabled = () =>
  isMockPaymentPreview() && configuredPaymentProvider() !== "nexi";

export const selectCheckoutPaymentProvider = (
  mode: PaymentProviderMode,
  customer: PaymentCustomer,
  retriedAttempt?: RetriedPaymentAttempt
): PaymentProvider => {
  if (mode === "mock") return "mock";
  if (
    mode === "fallback" &&
    customer.email &&
    isSyntheticE2EEmailRecipient(customer.email) &&
    retriedAttempt?.provider === "nexi" &&
    isEndedUnpaidPaymentState(retriedAttempt.state) &&
    retriedAttempt.failureCode === NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE
  ) {
    return "mock";
  }
  return "nexi";
};
