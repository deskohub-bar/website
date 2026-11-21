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
import { QueuePublisher } from "@/shared/backend/queue/queue-publisher";

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
      PaidFulfillmentQueueService.Live,
      LatePaymentRecoveryQueueService.Live
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
      QueuePublisher.Default
    )
  )
);

export const POST = fioPollTopic.consume(
  "fioAccountPollQueue",
  (job) =>
    Effect.flatMap(FioAccountPoller, (poller) => poller.consume(job)).pipe(
      Effect.provide(PollerLive)
    ),
  fioPollRedelivery
);
