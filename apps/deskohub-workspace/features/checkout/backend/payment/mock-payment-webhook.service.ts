import { timingSafeEqual } from "node:crypto";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  authorizeMockPaymentSession,
  isMockPaymentCapability,
} from "./mock-payment-provider";
import { PaymentProvidersLive } from "./payment-providers";
import { paymentWebhookDependencies } from "./payment-webhook-dependencies";
import {
  makePaymentWebhookProcessor,
  type PaymentWebhookProtocol,
  type PaymentWebhookResult,
  type WebhookErrorCode,
  type WebhookFailure,
} from "./payment-webhook-processor";

export class MockPaymentWebhookError extends Data.TaggedError(
  "MockPaymentWebhookError"
)<{
  readonly errorCode: WebhookErrorCode<"mock">;
  readonly failure: WebhookFailure;
  readonly eventId?: string;
  readonly orderId?: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const mockPaymentWebhookSchema = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  paymentId: Schema.String,
  token: Schema.String,
});

const invalidNotification = () =>
  new MockPaymentWebhookError({
    errorCode: "mock_webhook_parse_failed",
    failure: "parse_failed",
    message: "Mock payment webhook notification payload was invalid.",
  });

export class MockPaymentWebhookService extends Context.Service<
  MockPaymentWebhookService,
  {
    readonly processNotification: (
      payload: Schema.Json
    ) => Effect.Effect<PaymentWebhookResult, MockPaymentWebhookError>;
  }
>()("MockPaymentWebhookService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const database = yield* WorkspaceDatabase;
      const protocol: PaymentWebhookProtocol<MockPaymentWebhookError> = {
        provider: "mock",
        label: "Mock payment",
        operation: "mockPaymentWebhook.processNotification",
        decode: Effect.fnUntraced(function* (payload) {
          const envelope = yield* Schema.decodeUnknownEffect(
            mockPaymentWebhookSchema
          )(payload).pipe(Effect.mapError(invalidNotification));
          if (!isMockPaymentCapability(envelope))
            return yield* invalidNotification();

          const authorized = yield* authorizeMockPaymentSession(envelope).pipe(
            Effect.provideService(WorkspaceDatabase, database),
            Effect.mapError(
              (cause) =>
                new MockPaymentWebhookError({
                  errorCode: "mock_webhook_verification_failed",
                  failure: "verification_failed",
                  message:
                    "Mock payment webhook capability could not be checked.",
                  cause,
                })
            )
          );
          if (!authorized) {
            return yield* new MockPaymentWebhookError({
              errorCode: "mock_webhook_verification_mismatch",
              failure: "verification_mismatch",
              message: "Mock payment webhook capability did not match.",
            });
          }

          return {
            eventId: envelope.eventId,
            providerOrderId: envelope.paymentId,
            token: envelope.token,
            refund: false,
          };
        }),
        checkToken: (notification, stored) =>
          notification &&
          stored &&
          Buffer.byteLength(notification) === Buffer.byteLength(stored) &&
          timingSafeEqual(Buffer.from(notification), Buffer.from(stored))
            ? "match"
            : "mismatch",
        error: ({ errorCode, ...input }) =>
          new MockPaymentWebhookError({
            ...input,
            errorCode: `mock_webhook_${errorCode}`,
            failure: errorCode,
          }),
        isError: (cause): cause is MockPaymentWebhookError =>
          cause instanceof MockPaymentWebhookError,
      };
      return yield* makePaymentWebhookProcessor(protocol);
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(paymentWebhookDependencies),
    Layer.provide(PaymentProvidersLive),
    Layer.provide(WorkspaceDatabase.Default)
  );
}
