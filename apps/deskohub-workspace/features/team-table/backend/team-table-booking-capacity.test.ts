import { expect, test } from "bun:test";
import {
  DotyposReservationIdSchema,
  DotyposTableIdSchema,
  DotyposUncertain,
} from "@deskohub/dotypos";
import { Effect, Layer, Result } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  instantStringSchema,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import { OpenSpaceTableMoves } from "./open-space-table-moves";
import { withTeamTableBookingCapacity } from "./team-table-booking-capacity";

test.each(["complete", "unsettled"] as const)(
  "rediscovers source locks and posts only if the table clears (%s repack)",
  async (repackOutcome) => {
    const tableId = DotyposTableIdSchema.make("four-seat-table");
    const serviceDate = plainDateStringSchema.make("2027-01-11");
    const reservation = {
      kind: "table" as const,
      seats: 4,
      startsAt: instantStringSchema.make("2027-01-11T09:00:00Z"),
      endsAt: instantStringSchema.make("2027-01-11T09:15:00Z"),
    };
    const authorAccountId = customerAccountIdSchema.make("author");
    const oldId = workspaceReservationIdSchema.make("first-source");
    const newId = workspaceReservationIdSchema.make("second-source");
    const source = (reservationId: typeof oldId) => ({
      reservationId,
      sourceReservationId: DotyposReservationIdSchema.make(reservationId),
      targetTableId: DotyposTableIdSchema.make("open-space"),
      serviceDate,
      status: "CONFIRMED" as const,
      startsAt: Temporal.Instant.from("2027-01-10T23:00:00Z"),
      endsAt: Temporal.Instant.from("2027-01-11T16:00:00Z"),
    });
    const calls: unknown[] = [];
    let reads = 0;
    const result = await withTeamTableBookingCapacity(
      { reservation, authorAccountId },
      ({ assignTableId }) =>
        Effect.tap(assignTableId, (id) =>
          Effect.sync(() => calls.push(["create", id]))
        )
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(WorkspaceAvailabilityService, {
            getLiveTeamTablePlan: (_reservation, exactId) =>
              Effect.sync(() => {
                if (exactId) {
                  calls.push(["verify", exactId]);
                  return { tableId, moves: [] };
                }
                return {
                  tableId,
                  moves: [source(reads++ === 0 ? oldId : newId)],
                };
              }),
          }),
          Layer.mock(WorkspaceDatabaseAdvisoryLock, {
            withLocks: (keys, effect) =>
              Effect.sync(() => calls.push(keys)).pipe(Effect.andThen(effect)),
          }),
          Layer.mock(OpenSpaceTableMoves, {
            repackInCapacitySection: ({ moves }) =>
              Effect.gen(function* () {
                calls.push([
                  "repack",
                  moves.map(({ reservationId }) => reservationId),
                ]);
                if (repackOutcome === "unsettled") {
                  return yield* new DotyposUncertain({
                    operation: "createReservation",
                    request: "reservation.create",
                    reason: "transport",
                    message: "Synthetic uncertain move",
                  });
                }
                return true;
              }),
          })
        )
      ),
      Effect.result,
      Effect.runPromise
    );
    if (repackOutcome === "complete") {
      expect(Result.getOrThrow(result)).toBe(tableId);
    } else {
      expect(result).toMatchObject({
        failure: { _tag: "WorkspaceTableUnavailableError" },
      });
    }
    expect(calls).toEqual([
      [
        ["reservation-order", oldId],
        ["customer-account", authorAccountId],
        ["reservation-capacity", serviceDate],
      ],
      [
        ["reservation-order", newId],
        ["customer-account", authorAccountId],
        ["reservation-capacity", serviceDate],
      ],
      ["repack", [newId]],
      ...(repackOutcome === "complete"
        ? [
            ["verify", tableId],
            ["create", tableId],
          ]
        : []),
    ]);
  }
);
