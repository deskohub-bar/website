import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import {
  type DotyposReservation,
  type DotyposReservationId,
  DotyposService,
  type DotyposTable,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { WorkspaceCheckoutNetworkDetailsService } from "@/features/checkout/backend/fulfillment/network-details.service";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { AdvisoryAvailabilityInventory } from "./availability-inventory";
import {
  type OnSiteReservation,
  ReservationOnSite,
} from "./reservation-on-site-details";
import { WorkspaceReservationRepository } from "./workspace-reservation.repository";

const reservation: OnSiteReservation = {
  id: workspaceReservationIdSchema.make("customer-booking"),
  reservationDetails: {
    kind: "cowork",
    entryTier: "open-space",
    coffee: false,
  },
  dotyposReservation: {
    _tableId: "open-9",
    startDate: "2026-06-12T07:00:00Z",
    endDate: "2026-06-12T11:00:00Z",
  },
};

const tables: readonly DotyposTable[] = ["9", "10", "11", "12", "13", "14"].map(
  (name) => ({
    id: `open-${name}`,
    _cloudId: "synthetic-cloud",
    name,
    display: true,
    enabled: true,
    seats: "4",
    tags: ["cowork:open-space"],
  })
);

const providerBooking = (
  id: string,
  table: string,
  startsAt: string,
  endsAt: string,
  status: DotyposReservation["status"] = "CONFIRMED"
): DotyposReservation => ({
  _cloudId: "synthetic-cloud",
  _branchId: "synthetic-branch",
  id,
  _tableId: `open-${table}`,
  startDate: `2026-06-12T${startsAt}:00Z`,
  endDate: `2026-06-12T${endsAt}:00Z`,
  status,
});

const network = { ssid: "Test Wi-Fi", password: "test-password" };

const loadOnSite = (
  readInterval: DotyposService["Service"]["listActiveReservationsOverlapping"],
  bookings: readonly OnSiteReservation[] = [reservation]
) =>
  Effect.gen(function* () {
    const onSite = yield* ReservationOnSite;
    return yield* onSite.forReservations(bookings);
  }).pipe(
    Effect.provide(
      ReservationOnSite.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AdvisoryAvailabilityInventory, {
              tables: Effect.succeed(tables),
            }),
            Layer.mock(WorkspaceReservationRepository, {
              selectTeamTableDotyposReservationIds: (
                ids: readonly DotyposReservationId[]
              ) => Effect.succeed(ids.filter((id) => id !== "ordinary-cowork")),
              selectExpiredHoldDotyposReservationIds: () =>
                Effect.succeed(["expired-team"]),
            }),
            Layer.mock(DotyposService, {
              listActiveReservationsOverlapping: readInterval,
            }),
            Layer.succeed(WorkspaceCheckoutNetworkDetailsService, {
              resolveCustomerNetworkDetails: () => Effect.succeed(network),
            })
          )
        )
      )
    ),
    Effect.runPromise
  );

test("on-site placement excludes overlapping active Team Tables by their live table", async () => {
  const details = await loadOnSite((interval) => {
    expect(interval.startDate.toISOString()).toBe("2026-06-12T07:00:00.000Z");
    expect(interval.endDate.toISOString()).toBe("2026-06-12T11:00:00.000Z");
    return Effect.succeed([
      providerBooking("confirmed-team", "12", "08:00", "10:00"),
      providerBooking("held-team", "13", "10:30", "12:00", "NEW"),
      providerBooking("expired-team", "10", "08:00", "10:00", "NEW"),
      providerBooking("adjacent-before", "11", "06:00", "07:00"),
      providerBooking("adjacent-after", "11", "11:00", "12:00"),
      providerBooking("ordinary-cowork", "9", "09:00", "11:00"),
      providerBooking("cancelled-team", "14", "09:00", "11:00", "CANCELLED"),
    ]);
  });

  expect(details.get(reservation.id)).toEqual({
    table: { mode: "shared", name: "9-11, 14" },
    network,
  });
});

test("on-site details keep the network when the Open Space table check fails", async () => {
  const details = await loadOnSite(() =>
    Effect.fail(
      new DotyposUnavailable({
        operation: "listActiveReservationsOverlapping",
        reason: "timeout",
      })
    )
  );

  expect(details.get(reservation.id)).toEqual({ network });
});

test("batches on-site overlap reads and excludes tables only within each booking", async () => {
  const afternoon: OnSiteReservation = {
    ...reservation,
    id: workspaceReservationIdSchema.make("afternoon-booking"),
    dotyposReservation: {
      ...reservation.dotyposReservation,
      startDate: "2026-06-12T11:00:00Z",
      endDate: "2026-06-12T15:00:00Z",
    },
  };
  const readInterval = mock(() =>
    Effect.succeed([
      providerBooking("morning-team", "12", "10:00", "11:00"),
      providerBooking("afternoon-team", "13", "11:00", "12:00"),
    ])
  );

  const details = await loadOnSite(readInterval, [reservation, afternoon]);

  expect(readInterval).toHaveBeenCalledTimes(1);
  expect(readInterval).toHaveBeenCalledWith({
    startDate: new Date("2026-06-12T07:00:00Z"),
    endDate: new Date("2026-06-12T15:00:00Z"),
  });
  expect(details.get(reservation.id)?.table).toEqual({
    mode: "shared",
    name: "9-11, 13, 14",
  });
  expect(details.get(afternoon.id)?.table).toEqual({
    mode: "shared",
    name: "9-12, 14",
  });
});
