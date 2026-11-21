import { Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CheckoutAnalytics } from "../analytics/checkout-analytics.service";
import { PaymentAttemptRepository } from "../repositories/payment-attempt.repository";
import { PaymentRefundRepository } from "../repositories/payment-refund.repository";
import { WebhookEventRepository } from "../repositories/webhook-event.repository";
import { OrderPaymentHandlers } from "./order-payment-handlers.service";
import { PaymentRefundService } from "./payment-refund.service";

export const paymentWebhookDependencies = Layer.mergeAll(
  WebhookEventRepository.Default,
  PaymentAttemptRepository.Default,
  CheckoutAnalytics.Live,
  PaymentRefundService.Default.pipe(
    Layer.provide(PaymentRefundRepository.Default)
  ),
  OrderPaymentHandlers.Live
).pipe(Layer.provide(WorkspaceDatabase.Default));
