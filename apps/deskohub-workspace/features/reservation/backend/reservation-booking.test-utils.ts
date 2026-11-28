import { Effect, Layer } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import { OpenSpaceTableMoves } from "@/features/team-table/backend/open-space-table-moves";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import {
  type PayStateSubmission,
  prepareWorkspacePayState,
  ReservationBooking,
} from "./reservation-booking.service";
import { ReservationHolds } from "./reservation-holds.service";

const teamTableDisabled = Layer.mergeAll(
  TeamTableReleaseGate.fromDecision(false),
  Layer.mock(OpenSpaceTableMoves, {})
);

/**
 * Books one submission through `ReservationBooking` and `ReservationHolds`
 * built over the services the test provides, the way their `Live` layers
 * build them over live services.
 */
export const prepareOverProvidedServices = (submission: PayStateSubmission) =>
  prepareWorkspacePayState(submission).pipe(
    Effect.provide(
      ReservationBooking.Default.pipe(
        Layer.provide(
          Layer.mergeAll(ReservationHolds.Default, teamTableDisabled).pipe(
            Layer.provideMerge(makeRecordingAdvisoryLock().layer)
          )
        )
      )
    )
  );

/**
 * Books one submission through `ReservationBooking` built over the services
 * the test provides, `ReservationHolds` among them, for booking cases that
 * only need a hold outcome.
 */
export const prepareOverProvidedHolds = (submission: PayStateSubmission) =>
  prepareWorkspacePayState(submission).pipe(
    Effect.provide(
      ReservationBooking.Default.pipe(
        Layer.provide(
          Layer.mergeAll(teamTableDisabled, makeRecordingAdvisoryLock().layer)
        )
      )
    )
  );
