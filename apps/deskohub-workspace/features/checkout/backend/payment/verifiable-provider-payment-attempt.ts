import { Predicate } from "effect";
import {
  isProviderPaymentAttempt,
  type PaymentAttempt,
  type ProviderPaymentAttempt,
} from "../repositories/payment-attempt.repository";

/**
 * A payment attempt with the capability its provider needs for verification.
 */
export type VerifiableProviderPaymentAttempt = ProviderPaymentAttempt & {
  readonly securityToken: string;
};

export const isVerifiableProviderPaymentAttempt = (
  attempt: PaymentAttempt | null | undefined
): attempt is VerifiableProviderPaymentAttempt =>
  Predicate.isNotNullish(attempt) &&
  isProviderPaymentAttempt(attempt) &&
  Boolean(attempt.securityToken);
