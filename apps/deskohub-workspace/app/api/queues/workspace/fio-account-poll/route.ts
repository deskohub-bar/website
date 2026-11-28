import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { FioAccountPollRepository } from "@/features/checkout/backend/fio/fio-account-poll.repository";
import {
  FioAccountPoller,
  fioPollRedelivery,
} from "@/features/checkout/backend/fio/fio-account-poller.service";
import { FioAccounts } from "@/features/checkout/backend/fio/fio-accounts.service";
import { FioMovements } from "@/features/checkout/backend/fio/fio-movements.service";
import { fioPollTopic } from "@/features/checkout/backend/fio/fio-poll-wake.service";
import { PaidFulfillmentQueueService } from "@/features/checkout/backend/fulfillment/paid-fulfillment-queue.service";
import { FioPaymentSettlementService } from "@/features/checkout/backend/payment/fio-payment-settlement.service";
import { LatePaymentRecoveryQueueService } from "@/features/checkout/backend/payment/late-payment-recovery-queue.service";
import { FioPaymentSettlementRepository } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";
import { PaymentLifecycleRepository } from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import { QrPaymentRepository } from "@/features/checkout/backend/repositories/qr-payment.repository";
import { defineQueueRoute } from "@/shared/backend/queue/queue-route";
import { VercelQueuePublisher } from "@/shared/backend/queue/vercel-queue-publisher";

// The persisted interrupted-read gate includes this execution limit.
export const maxDuration = 60;

const QrPaymentsLive = QrPaymentRepository.Default.pipe(
  Layer.provide(WorkspaceDatabase.Default)
);
const SettlementsLive = FioPaymentSettlementService.Default.pipe(
  Layer.provide(
    Layer.mergeAll(
      FioAccounts.Default,
      WorkspaceDatabase.Default,
      QrPaymentsLive,
      FioPaymentSettlementRepository.Default.pipe(
        Layer.provide(WorkspaceDatabase.Default)
      ),
      PaymentLifecycleRepository.Live,
      PaidFulfillmentQueueService.Default.pipe(
        Layer.provide(VercelQueuePublisher)
      ),
      LatePaymentRecoveryQueueService.Default.pipe(
        Layer.provide(VercelQueuePublisher)
      )
    )
  )
);
const PollerLive = FioAccountPoller.Default.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspaceDatabase.Default,
      QrPaymentsLive,
      SettlementsLive,
      FioAccountPollRepository.Default,
      FioAccounts.Default,
      FioMovements.Live,
      VercelQueuePublisher
    )
  )
);

export const POST = defineQueueRoute(
  "fioAccountPollQueue",
  fioPollTopic.topic,
  fioPollTopic.consume(
    (job) =>
      Effect.flatMap(FioAccountPoller, (poller) => poller.consume(job)).pipe(
        Effect.provide(PollerLive)
      ),
    fioPollRedelivery
  )
);
