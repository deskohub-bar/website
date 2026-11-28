import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { AccountingStorage } from "@/features/accounting/backend/accounting-storage";
import { ReservationFulfillment } from "@/features/checkout/backend/fulfillment";
import { UnpaidHoldRelease } from "@/features/checkout/backend/holds";
import {
  LatePaymentRecoveryService,
  latePaymentRecoveryTopic,
  processLatePaymentRecoveryMessage,
} from "@/features/checkout/backend/payment";
import { LatePaymentRecoveryRepository } from "@/features/checkout/backend/repositories";
import { WorkspaceTableAssignmentService } from "@/features/checkout/backend/reservation";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { TeamTableBookingCapacityLive } from "@/features/team-table/backend/team-table-booking-capacity";
import { TeamTableHoldClaims } from "@/features/team-table/backend/team-table-hold-claims";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { defineQueueRoute } from "@/shared/backend/queue/queue-route";

export const maxDuration = 300;

const databaseRepositories = Layer.mergeAll(
  Layer.mergeAll(
    LatePaymentRecoveryRepository.Default,
    WorkspaceReservationRepository.Default
  ).pipe(Layer.provide(WorkspaceDatabase.Default)),
  AccountingStorage.Live
);

const ConsumerLive = LatePaymentRecoveryService.Default.pipe(
  Layer.provide(TeamTableBookingCapacityLive),
  Layer.provide(
    TeamTableHoldClaims.Default.pipe(
      Layer.provide(
        Layer.merge(WorkspaceDatabase.Default, WorkspaceDotyposLayer)
      )
    )
  ),
  Layer.provide(UnpaidHoldRelease.Default),
  Layer.provide(databaseRepositories),
  Layer.provide(WorkspaceAvailabilityService.Live),
  Layer.provide(
    WorkspaceTableAssignmentService.Default.pipe(
      Layer.provide(databaseRepositories),
      Layer.provide(WorkspaceDotyposLayer)
    )
  ),
  Layer.provide(ReservationFulfillment.Live),
  Layer.provide(WorkspaceDatabaseAdvisoryLock.Default),
  Layer.provide(WorkspaceDotyposLayer)
);

export const POST = defineQueueRoute(
  "latePaymentRecoveryQueue",
  latePaymentRecoveryTopic.topic,
  latePaymentRecoveryTopic.consume((message) =>
    processLatePaymentRecoveryMessage(message).pipe(
      Effect.provide(ConsumerLive)
    )
  )
);
