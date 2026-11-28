import { type DotyposReservation, DotyposService } from "@deskohub/dotypos";
import { Context, Effect, Layer } from "effect";
import {
  type WorkspaceCheckoutNetworkDetails,
  WorkspaceCheckoutNetworkDetailsService,
} from "@/features/checkout/backend/fulfillment/network-details.service";
import type {
  StoredWorkspaceReservationDetails,
  WorkspaceReservationId,
} from "@/features/reservation/persistence-contracts";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { AdvisoryAvailabilityInventory } from "./availability-inventory";
import { decodeBookedReservation } from "./booked-reservation";
import {
  type CustomerReservationPlacement,
  getCustomerReservationPlacement,
} from "./customer-reservation-placement";
import { loadOpenSpaceTableExclusions } from "./open-space-table-exclusions";
import { WorkspaceReservationRepository } from "./workspace-reservation.repository";

/**
 * What a booked customer needs on site, as the confirmation email tells
 * them: the table they use and the Wi-Fi.
 */
export type ReservationOnSiteDetails = {
  readonly table?: NonNullable<CustomerReservationPlacement["table"]>;
  readonly network: WorkspaceCheckoutNetworkDetails;
};

/** A confirmed website reservation whose on-site details can be shown. */
export type OnSiteReservation = {
  readonly id: WorkspaceReservationId;
  readonly reservationDetails: StoredWorkspaceReservationDetails;
  readonly dotyposReservation: Pick<
    DotyposReservation,
    "_tableId" | "startDate" | "endDate" | "seats"
  >;
};

interface IReservationOnSite {
  /**
   * Each reservation's table and Wi-Fi. Reads the shared tables snapshot the
   * status page uses once. Open Space also checks Team Table bookings live.
   * A failed overlap check leaves out the shared table list.
   */
  readonly forReservations: (
    reservations: readonly OnSiteReservation[]
  ) => Effect.Effect<
    ReadonlyMap<WorkspaceReservationId, ReservationOnSiteDetails>
  >;
}

export class ReservationOnSite extends Context.Service<
  ReservationOnSite,
  IReservationOnSite
>()("@deskohub-workspace/reservation/ReservationOnSite") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const inventory = yield* AdvisoryAvailabilityInventory;
      const networks = yield* WorkspaceCheckoutNetworkDetailsService;
      const dotypos = yield* DotyposService;
      const reservations = yield* WorkspaceReservationRepository;

      return {
        forReservations: Effect.fn("ReservationOnSite.forReservations")(
          function* (bookings: readonly OnSiteReservation[]) {
            if (bookings.length === 0) {
              return new Map<
                WorkspaceReservationId,
                ReservationOnSiteDetails
              >();
            }
            const tables = yield* inventory.tables.pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Reservation on-site tables load failed", {
                  cause,
                })
              ),
              Effect.orElseSucceed(() => [])
            );
            const exclusions = yield* loadOpenSpaceTableExclusions(
              bookings.map(
                ({ id, reservationDetails, dotyposReservation }) => ({
                  id,
                  reservationDetails,
                  occupiedInterval: decodeBookedReservation(
                    dotyposReservation,
                    reservationDetails
                  ).occupiedInterval,
                })
              ),
              { dotypos, reservations }
            ).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning(
                  "Reservation on-site Open Space table exclusions load failed",
                  { cause }
                )
              ),
              Effect.orElseSucceed(() => undefined)
            );
            const details = yield* Effect.forEach(
              bookings,
              Effect.fnUntraced(function* ({
                id,
                reservationDetails,
                dotyposReservation,
              }) {
                const { table } = getCustomerReservationPlacement({
                  reservationDetails,
                  dotyposReservation,
                  tables,
                  openSpaceExcludedTableIds: exclusions?.get(id),
                  seatingMap: false,
                });
                const network = yield* networks.resolveCustomerNetworkDetails({
                  reservation: { id },
                });
                return [id, { ...(table && { table }), network }] as const;
              })
            );
            return new Map<WorkspaceReservationId, ReservationOnSiteDetails>(
              details
            );
          }
        ),
      };
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(WorkspaceDotyposLayer, WorkspaceReservationRepository.Live)
    )
  );
}
