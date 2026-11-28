import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DotyposBranchIdSchema,
  DotyposCloudIdSchema,
  DotyposCustomerIdSchema,
  DotyposRejected,
  type DotyposReservation,
  DotyposReservationIdSchema,
  DotyposService,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import {
  availabilityTags,
  reservationRecordTags,
} from "@/shared/utils/cache-tags";

const revalidateTag = mock(
  (_tag: string, _profile: { readonly expire: number }) => undefined
);

mock.module("next/cache", () => ({ revalidateTag }));

const { ReservationWritesExpireSharedReads } = await import("./dotypos.config");

const failure = new DotyposRejected({
  operation: "cancelReservation",
  reason: "invalid-response",
  message: "Synthetic timeout",
});
const reservationId = DotyposReservationIdSchema.make("1");
const booking = {
  customerId: DotyposCustomerIdSchema.make("1"),
  tableId: DotyposTableIdSchema.make("1"),
  seats: 1,
  startDate: new Date("2026-06-01T10:00:00.000Z"),
  endDate: new Date("2026-06-01T12:00:00.000Z"),
};
const sampleReservation: DotyposReservation = {
  id: reservationId,
  _branchId: DotyposBranchIdSchema.make("1"),
  _cloudId: DotyposCloudIdSchema.make("1"),
  startDate: "2026-06-01T10:00:00.000Z",
  endDate: "2026-06-01T12:00:00.000Z",
  seats: "1",
  status: "CONFIRMED",
};
const getTables = mock(() => Effect.succeed([]));
const dotypos = Layer.mock(DotyposService, {
  createReservation: () => Effect.succeed(sampleReservation),
  updateReservation: () => Effect.succeed(sampleReservation),
  cancelReservation: () => Effect.fail(failure),
  confirmReservation: () => Effect.succeed(sampleReservation),
  restoreCancelledReservation: () =>
    Effect.succeed({
      _tag: "Restored" as const,
      reservation: sampleReservation,
    }),
  getTables,
});

const runWithDotypos = <A, E>(
  use: (service: DotyposService["Service"]) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.result(
      Effect.flatMap(DotyposService, use).pipe(
        Effect.provide(
          ReservationWritesExpireSharedReads.pipe(Layer.provide(dotypos))
        )
      )
    )
  );

beforeEach(() => {
  revalidateTag.mockReset();
  revalidateTag.mockImplementation(() => undefined);
});

describe("Dotypos reservation writes", () => {
  test("expire shared availability and reservation records after each occupancy write", async () => {
    await runWithDotypos((service) =>
      Effect.all([
        service.createReservation({ ...booking, status: "CONFIRMED" }),
        service.updateReservation({ reservationId, note: "updated" }),
        service.restoreCancelledReservation({
          reservationId,
          expectedBooking: booking,
        }),
      ])
    );

    expect(revalidateTag.mock.calls).toEqual([
      [availabilityTags.reservations, { expire: 1 }],
      [reservationRecordTags.records, { expire: 1 }],
      [availabilityTags.reservations, { expire: 1 }],
      [reservationRecordTags.records, { expire: 1 }],
      [availabilityTags.reservations, { expire: 1 }],
      [reservationRecordTags.records, { expire: 1 }],
    ]);
  });

  test("expire only the reservation records when a hold is confirmed", async () => {
    await runWithDotypos((service) =>
      service.confirmReservation(reservationId)
    );

    expect(revalidateTag.mock.calls).toEqual([
      [reservationRecordTags.records, { expire: 1 }],
    ]);
  });

  test("expire the snapshot even when a write fails", async () => {
    const result = await runWithDotypos((service) =>
      service.cancelReservation(reservationId)
    );

    expect(result._tag).toBe("Failure");
    expect(revalidateTag).toHaveBeenCalledTimes(2);
  });

  test("keep the write result when cache invalidation throws", async () => {
    revalidateTag.mockImplementation(() => {
      throw new Error("Route rendered outside a request");
    });

    const result = await runWithDotypos((service) =>
      service.createReservation({ ...booking, status: "CONFIRMED" })
    );

    expect(result).toMatchObject({
      _tag: "Success",
      success: sampleReservation,
    });
  });

  test("leave reads untouched", async () => {
    await runWithDotypos((service) => service.getTables());

    expect(getTables).toHaveBeenCalledTimes(1);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
