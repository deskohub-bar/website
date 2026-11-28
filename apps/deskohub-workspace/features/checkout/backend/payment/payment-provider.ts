import { Context, Data, type Duration, type Effect } from "effect";
import type { Locale } from "@/features/i18n";
import type { Money } from "@/shared/money/money";
import type { CheckoutError } from "../checkout/checkout-error";
import type { PaymentAttempt } from "../repositories/payment-attempt.repository";

export type PaymentProvider = "nexi" | "mock";
export type PaymentProviderMode = PaymentProvider | "fallback";
export type ProviderPaymentFailureCode = `${PaymentProvider}_${string}`;
export type RetriedPaymentAttempt = Pick<
  PaymentAttempt,
  "id" | "provider" | "state" | "failureCode"
>;

export interface PaymentCustomer {
  readonly id?: string;
  readonly name: string;
  readonly email?: string;
  readonly mobilePhone?: {
    readonly countryCallingCode: string;
    readonly nationalNumber: string;
  };
}

export interface PaymentSessionInput {
  readonly amount: Money;
  readonly customer: PaymentCustomer;
  readonly locale: Locale;
  readonly correlationId: string;
  readonly resultUrl: string;
  readonly cancelUrl: string;
  readonly notificationUrl: string;
}

interface HostedPaymentSession {
  readonly providerOrderId: string;
  readonly securityToken: string;
  readonly hostedPage: string;
}

interface PreparedPaymentSession {
  readonly logFields?: Readonly<Record<string, string>>;
  readonly providerOrderId: string;
  readonly create: Effect.Effect<HostedPaymentSession, PaymentProviderError>;
}

export interface PaymentReference {
  readonly providerOrderId: string;
  readonly correlationId: string;
}

export interface VerifyPayment extends PaymentReference {
  readonly amount: Money;
  readonly securityToken: string;
  readonly deadline?: Duration.Input;
}

interface PaymentProviderOrder {
  readonly hasActivity: boolean;
  readonly canRetry: boolean;
  /** The provider corroborates that the marked attempt never reached authorization. */
  readonly canFallback?: boolean;
  readonly diagnostics?: {
    readonly lastOperationType?: string | undefined;
    readonly operations: readonly string[];
  };
  readonly refund?: {
    readonly amount: number;
    readonly lastRefundedAt?: string;
    readonly operationIds: readonly string[];
  };
}

interface PaymentVerificationDetails {
  readonly providerOperationId?: string;
  readonly providerStatus?: string;
  readonly providerOrderStatus?: string;
  readonly mismatches: readonly string[];
  readonly hasActivity: boolean;
  /** The provider confirms that this session ended and can no longer settle. */
  readonly closedWithoutPayment?: true;
}

export type PaymentVerification = PaymentVerificationDetails &
  (
    | { readonly status: "success" | "pending" }
    | {
        readonly status: "failure";
        readonly terminalState: "failed" | "cancelled" | "expired";
        readonly failureCode: ProviderPaymentFailureCode;
      }
  );

export class PaymentProviderError extends Data.TaggedError(
  "PaymentProviderError"
)<{
  readonly message: string;
  readonly cause?: unknown;
  readonly notFound?: boolean;
  readonly transportErrorTag?: string;
  readonly invalidInput?: boolean;
  readonly creationRejection?: {
    readonly failureCode: ProviderPaymentFailureCode;
    readonly providerStatus: string;
  };
}> {}

export interface PaymentProviderAdapter {
  readonly unconfirmedSessionFailureCode: ProviderPaymentFailureCode;
  readonly prepareSession: (
    input: PaymentSessionInput
  ) => Effect.Effect<PreparedPaymentSession, CheckoutError>;
  readonly lookup: (
    input: PaymentReference & { readonly expectedAmount?: Money }
  ) => Effect.Effect<PaymentProviderOrder, PaymentProviderError>;
  readonly verify: (
    input: VerifyPayment
  ) => Effect.Effect<PaymentVerification, PaymentProviderError>;
}

export class PaymentProviders extends Context.Service<
  PaymentProviders,
  {
    readonly activeProviders: readonly PaymentProvider[];
    readonly selectForCustomer: (
      customer: PaymentCustomer,
      retriedAttempt?: RetriedPaymentAttempt
    ) => Effect.Effect<PaymentProvider, CheckoutError>;
    readonly forAttempt: (provider: PaymentProvider) => PaymentProviderAdapter;
  }
>()("PaymentProviders") {}
