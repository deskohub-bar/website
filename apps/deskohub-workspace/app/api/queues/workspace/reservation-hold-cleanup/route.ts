import { Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  ReservationHoldCleanupService,
  reservationHoldCleanupConsumer,
  reservationHoldCleanupTopic,
} from "@/features/checkout/backend/holds";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { defineQueueRoute } from "@/shared/backend/queue/queue-route";

const ReservationHoldCleanupScheduleConsumerLive = Layer.mergeAll(
  ReservationHoldCleanupService.Live,
  WorkspaceReservationRepository.Default.pipe(
    Layer.provide(WorkspaceDatabase.Default)
  )
);

export const POST = defineQueueRoute(
  "reservationHoldCleanupSchedule",
  reservationHoldCleanupTopic.topic,
  reservationHoldCleanupConsumer(ReservationHoldCleanupScheduleConsumerLive)
);
