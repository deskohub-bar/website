import { Context, type Duration, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { OrderId } from "@/features/order";
import {
  type PaymentAttempt,
  PaymentAttemptRepository,
} from "../repositories/payment-attempt.repository";
import type { OrderPaymentHandler } from "./order-payment-handler";
import { OrderPaymentHandlers } from "./order-payment-handlers.service";
import { PaymentProviders, type PaymentVerification } from "./payment-provider";
import { PaymentProvidersLive } from "./payment-providers";
import {
  isVerifiableProviderPaymentAttempt,
  type VerifiableProviderPaymentAttempt,
} from "./verifiable-provider-payment-attempt";

type LatePaymentVerificationResult =
  | "confirmed_unpaid"
  | "not_applicable"
  | "not_verifiable"
  | "not_settled"
  | "provider_verification_failed"
  | "recovery_started"
  | "verification_mismatch";

const isTerminalPaymentState = (state: string) =>
  state === "failed" || state === "cancelled" || state === "expired";

/** A terminal attempt that can be verified with its stored security token. */
const isVerifiableTerminalAttempt = (
  attempt: PaymentAttempt | null
): attempt is VerifiableProviderPaymentAttempt =>
  isVerifiableProviderPaymentAttempt(attempt) &&
  isTerminalPaymentState(attempt.state);

export interface ILatePaymentVerificationService {
  /**
   * Verifies the order's terminal provider attempt and starts durable
   * late-payment recovery if the provider settled it after the attempt ended.
   * Provider and database failures are logged and reported as a result so the
   * customer status page still renders the stored status.
   */
  readonly startRecoveryIfSettled: (input: {
    readonly orderId: OrderId;
    readonly expectedPaymentAttemptId?: PaymentAttemptId;
    /** Bounds payment verification, retries included. */
    readonly verificationDeadline?: Duration.Input;
  }) => Effect.Effect<LatePaymentVerificationResult>;
}

export class LatePaymentVerificationService extends Context.Service<
  LatePaymentVerificationService,
  ILatePaymentVerificationService
>()("@deskohub-workspace/checkout/LatePaymentVerificationService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const handlers = yield* OrderPaymentHandlers;
      const paymentAttempts = yield* PaymentAttemptRepository;
      const providers = yield* PaymentProviders;

      /** The provider's verification, or undefined when the lookup failed. */
      const verifyAttemptOutcome = Effect.fnUntraced(function* (
        attempt: VerifiableProviderPaymentAttempt,
        correlationId: string,
        verificationDeadline: Duration.Input | undefined
      ) {
        return yield* providers
          .forAttempt(attempt.provider)
          .verify({
            providerOrderId: attempt.providerOrderId,
            correlationId,
            amount: attempt.amount,
            securityToken: attempt.securityToken,
            deadline: verificationDeadline,
          })
          .pipe(
            Effect.catchIf(
              (cause) => !cause.invalidInput,
              (cause) =>
                Effect.logWarning(
                  "Late-payment verification provider lookup failed",
                  { cause }
                ).pipe(Effect.as(undefined))
            )
          );
      });

      const startRecoveryFromVerification = Effect.fnUntraced(function* (
        paymentAttemptId: PaymentAttemptId,
        orderId: OrderId,
        handler: OrderPaymentHandler,
        verification: PaymentVerification | undefined
      ) {
        if (!verification) return "provider_verification_failed" as const;
        if (verification.mismatches.length > 0) {
          yield* Effect.logWarning(
            "Late-payment verification provider facts mismatch",
            { mismatches: verification.mismatches }
          );
          return "verification_mismatch" as const;
        }
        if (verification.status !== "success") {
          if (verification.closedWithoutPayment) {
            return "confirmed_unpaid" as const;
          }
          return "not_settled" as const;
        }

        yield* Effect.logWarning(
          "Provider payment settled after the local payment attempt became terminal"
        );
        const { providerOperationId, providerStatus } = verification;
        yield* handler.startRecovery({
          orderId,
          paymentAttemptId,
          providerOperationId,
          providerStatus,
          verifiedPaidAt: Temporal.Now.instant(),
        });
        return "recovery_started" as const;
      });

      const startRecoveryIfSettled = Effect.fn(
        "latePaymentVerification.startRecoveryIfSettled"
      )(
        function* (
          input: Parameters<
            ILatePaymentVerificationService["startRecoveryIfSettled"]
          >[0]
        ) {
          const handler = yield* handlers.forOrder(input.orderId);
          if (!handler) return "not_applicable" as const;
          const order = yield* handler.load(input.orderId);
          const paymentAttemptId = order?.activePaymentAttemptId;
          if (
            !(order && paymentAttemptId) ||
            !isTerminalPaymentState(order.paymentState) ||
            (input.expectedPaymentAttemptId !== undefined &&
              input.expectedPaymentAttemptId !== paymentAttemptId)
          ) {
            return "not_applicable" as const;
          }

          if (
            yield* handler.resumeRecovery({
              orderId: order.id,
              paymentAttemptId,
            })
          ) {
            return "recovery_started" as const;
          }

          const attempt = yield* paymentAttempts.findById(paymentAttemptId);
          if (
            !isVerifiableTerminalAttempt(attempt) ||
            attempt.orderId !== order.id
          ) {
            return "not_verifiable" as const;
          }

          const verification = yield* verifyAttemptOutcome(
            attempt,
            order.correlationId,
            input.verificationDeadline
          );
          return yield* startRecoveryFromVerification(
            paymentAttemptId,
            order.id,
            handler,
            verification
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.tapError((cause) =>
              Effect.logError("Late-payment verification failed", { cause })
            ),
            Effect.orElseSucceed(() => "not_verifiable" as const),
            Effect.annotateLogs({ orderId: input.orderId })
          )
      );

      return LatePaymentVerificationService.of({ startRecoveryIfSettled });
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        OrderPaymentHandlers.Live,
        PaymentAttemptRepository.Default,
        PaymentProvidersLive
      )
    ),
    Layer.provide(WorkspaceDatabase.Default)
  );
}
