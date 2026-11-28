import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { AccountingStorage } from "@/features/accounting/backend/accounting-storage";
import { InvoiceEmailDeliveryRepository } from "@/features/accounting/backend/invoice-email-delivery.repository";
import { InvoiceEmailDeliveryService } from "@/features/accounting/backend/invoice-email-delivery.service";
import type { OrderId, OrderKind } from "@/features/order";
import { findOrderKind } from "@/features/order/backend/order-kind";
import {
  type EntryPackPaymentAdmissionDetails,
  makeEntryPackOrderPaymentHandler,
} from "@/features/passes/backend/entry-pack-order-payment-handler";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { WorkspaceEmailLayer } from "@/shared/backend/config/email.config";
import { VercelQueuePublisher } from "@/shared/backend/queue/vercel-queue-publisher";
import { PaidFulfillmentQueueService } from "../fulfillment/paid-fulfillment-queue.service";
import { ReservationFulfillment } from "../fulfillment/reservation-fulfillment.service";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import { PaymentLifecycleRepository } from "../repositories/payment-lifecycle.repository";
import { LatePaymentRecoveryQueueService } from "./late-payment-recovery-queue.service";
import type {
  AdmittingOrderPaymentHandler,
  OrderPaymentHandler,
} from "./order-payment-handler";
import {
  makeReservationOrderPaymentHandler,
  type ReservationPaymentAdmissionDetails,
} from "./reservation-order-payment-handler";

interface PaymentAdmissionDetails {
  readonly reservation: ReservationPaymentAdmissionDetails;
  readonly "pass-purchase": EntryPackPaymentAdmissionDetails;
}

export type PaymentAdmissionDetailsFor<Kind extends OrderKind> =
  PaymentAdmissionDetails[Kind];

type HandlersByKind = {
  readonly [Kind in OrderKind]?: AdmittingOrderPaymentHandler<
    PaymentAdmissionDetailsFor<Kind>
  >;
};

interface IOrderPaymentHandlers {
  readonly byKind: HandlersByKind;
  readonly forOrder: (
    orderId: OrderId
  ) => Effect.Effect<OrderPaymentHandler | undefined, EffectDrizzleQueryError>;
}

export class OrderPaymentHandlers extends Context.Service<
  OrderPaymentHandlers,
  IOrderPaymentHandlers
>()("OrderPaymentHandlers") {
  static make(
    byKind: HandlersByKind,
    findKind: (
      orderId: OrderId
    ) => Effect.Effect<OrderKind | undefined, EffectDrizzleQueryError>
  ): IOrderPaymentHandlers {
    return {
      byKind,
      forOrder: (orderId) =>
        findKind(orderId).pipe(Effect.map((kind) => kind && byKind[kind])),
    };
  }

  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const database = yield* WorkspaceDatabase;
      const reservation = yield* makeReservationOrderPaymentHandler;
      const passPurchase = yield* makeEntryPackOrderPaymentHandler;
      return OrderPaymentHandlers.make(
        { reservation, "pass-purchase": passPurchase },
        (orderId) =>
          findOrderKind(orderId).pipe(
            Effect.provideService(WorkspaceDatabase, database)
          )
      );
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceReservationRepository.Default,
        WorkspaceEmailLayer,
        WorkspaceDotyposLayer,
        GoogleCalendarWorkspaceLimitationsService.Live,
        WorkspaceDatabaseAdvisoryLock.Default,
        CustomerAccountSections.Live,
        AccountingStorage.Live,
        InvoiceEmailDeliveryService.Live,
        InvoiceEmailDeliveryRepository.Live,
        PaymentLifecycleRepository.Live,
        ReservationFulfillment.Live,
        PaidFulfillmentQueueService.Default.pipe(
          Layer.provide(VercelQueuePublisher)
        ),
        LatePaymentRecoveryRepository.Default,
        LatePaymentRecoveryQueueService.Default.pipe(
          Layer.provide(VercelQueuePublisher)
        )
      )
    ),
    Layer.provide(WorkspaceDatabase.Default)
  );
}
