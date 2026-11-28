import type { DotyposReservation } from "@deskohub/dotypos";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  openSpaceTableMoves,
  orders,
  passEntryClaims,
  passPurchases,
  unlimitedPassDayMoves,
  workspaceReservations,
} from "@/db/schema";
import { noteNamesPaymentOrder } from "@/features/checkout/backend/reservation/order-reservation-note";
import type { TableBooking } from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import { movablePassDay } from "@/features/passes/backend/movable-pass-day";
import { getCapacityInventory } from "@/features/passes/backend/pass-day-capacity-bookings";
import { formatPassDayMarker } from "@/features/passes/pass-day-marker";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import type { ReservationRecord } from "@/features/reservation/backend/reservation-record";
import { storedCoworkReservationDetailsSchema } from "@/features/reservation/cowork-reservation-product";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import type { TeamTableBooking } from "./team-table-plan";

type Move = Extract<TeamTableBooking, { readonly kind: "shared" }>["move"];
type ProviderRecord = ReservationRecord &
  Pick<DotyposReservation, "_customerId" | "note">;
type LocalHold = typeof workspaceReservations.$inferSelect;
type EntryClaim = Pick<typeof passEntryClaims.$inferSelect, "status" | "date">;

const projectBooking = (booking: TableBooking): TeamTableBooking => {
  const interval = {
    startsAt: Temporal.Instant.fromEpochMilliseconds(booking.startsAt),
    endsAt: Temporal.Instant.fromEpochMilliseconds(booking.endsAt),
  };
  return booking.exclusive
    ? { kind: "team-table", tableId: booking.tableId, interval }
    : {
        kind: "shared",
        tableId: booking.tableId,
        seats: booking.seats,
        interval,
      };
};

/** Capacity checks without local ownership treat active provider holds as exclusive. */
export const getUnclassifiedTeamTableBookings = (
  records: readonly ProviderRecord[],
  claims: Parameters<typeof getCapacityInventory>[1]
): readonly TeamTableBooking[] => {
  const inventory = getCapacityInventory(records, claims);
  const bookings: TeamTableBooking[] = [];
  for (const record of inventory.records) {
    if (
      !record._tableId ||
      (record.status !== "NEW" && record.status !== "CONFIRMED")
    )
      continue;
    const interval = Option.getOrUndefined(
      decodeBookedReservation(record).occupiedInterval
    );
    bookings.push({
      kind: "unknown",
      tableId: record._tableId,
      ...(interval && { interval }),
    });
  }
  return [
    ...bookings,
    ...inventory.unobservedBookings.map(projectBooking),
    ...inventory.exclusiveBookings.map(projectBooking),
  ];
};

const decodeCoworkDetails = Schema.decodeUnknownOption(
  storedCoworkReservationDetailsSchema
);

/** State shared with the live move journal's source validation. */
export const getOrdinaryOpenSpaceMoveStanding = (
  row: Pick<
    LocalHold,
    | "reservationDetails"
    | "reservationState"
    | "paymentState"
    | "fulfillmentState"
    | "reservationHoldExpiresAt"
  >,
  claim: EntryClaim | null | undefined,
  status: "NEW" | "CONFIRMED",
  serviceDate: string,
  now: Temporal.Instant
) => {
  const details = decodeCoworkDetails(row.reservationDetails);
  if (!Option.exists(details, ({ entryTier }) => entryTier === "open-space"))
    return undefined;

  if (status === "NEW") {
    const expiresAt = row.reservationHoldExpiresAt;
    return row.reservationState === "held" &&
      (row.paymentState === "not_started" || row.paymentState === "pending") &&
      row.fulfillmentState === "not_started" &&
      expiresAt &&
      Temporal.Instant.compare(expiresAt, now) > 0 &&
      (!claim || (claim.status === "reserved" && claim.date === serviceDate))
      ? { origin: "authorized-checkout" as const, status, expiresAt }
      : undefined;
  }

  if (
    row.reservationState !== "confirmed" ||
    row.fulfillmentState === "processing" ||
    (claim
      ? claim.status !== "consumed" || claim.date !== serviceDate
      : row.paymentState !== "paid")
  )
    return undefined;
  return {
    origin: claim ? ("entry-pack" as const) : ("paid-single-day" as const),
    status,
  };
};

const readKind = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literals(["cowork", "table"]) })
);

const makeInventory = Effect.gen(function* () {
  const { db } = yield* WorkspaceDatabase;
  return Effect.fn("TeamTableInventory.load")(function* (
    records: readonly ProviderRecord[],
    claims: Parameters<typeof getCapacityInventory>[1],
    now: Temporal.Instant
  ) {
    const occupancy = getCapacityInventory(records, claims);
    const providerIds = occupancy.records.map(({ id }) => id);
    const [holds, passDays] = providerIds.length
      ? yield* Effect.all([
          db
            .select({
              row: {
                id: workspaceReservations.id,
                dotyposReservationId:
                  workspaceReservations.dotyposReservationId,
                dotyposCustomerId: workspaceReservations.dotyposCustomerId,
                reservationDetails: workspaceReservations.reservationDetails,
                passId: workspaceReservations.passId,
                serviceDate: workspaceReservations.serviceDate,
                passDayTableId: workspaceReservations.passDayTableId,
                passDayHoldGeneration:
                  workspaceReservations.passDayHoldGeneration,
                reservationState: workspaceReservations.reservationState,
                paymentState: workspaceReservations.paymentState,
                fulfillmentState: workspaceReservations.fulfillmentState,
                reservationHoldExpiresAt:
                  workspaceReservations.reservationHoldExpiresAt,
              },
              claim: {
                status: passEntryClaims.status,
                date: passEntryClaims.date,
              },
              hasOrder: sql<boolean>`${orders.id} is not null`,
              moving: sql<boolean>`exists (
                  select 1 from ${openSpaceTableMoves}
                  where ${openSpaceTableMoves.reservationId} = ${workspaceReservations.id}
                  and ${openSpaceTableMoves.settledAt} is null
                )`,
            })
            .from(workspaceReservations)
            .leftJoin(
              passEntryClaims,
              eq(passEntryClaims.reservationId, workspaceReservations.id)
            )
            .leftJoin(
              orders,
              and(
                sql`${orders.id} = ${workspaceReservations.id}`,
                eq(orders.kind, "reservation")
              )
            )
            .where(
              inArray(workspaceReservations.dotyposReservationId, providerIds)
            ),
          db
            .select({ id: workspaceReservations.id })
            .from(workspaceReservations)
            .innerJoin(
              passPurchases,
              eq(passPurchases.id, workspaceReservations.passId)
            )
            .innerJoin(orders, eq(orders.id, passPurchases.id))
            .where(
              and(
                inArray(
                  workspaceReservations.dotyposReservationId,
                  providerIds
                ),
                movablePassDay,
                notExists(
                  db
                    .select({ id: unlimitedPassDayMoves.generation })
                    .from(unlimitedPassDayMoves)
                    .where(
                      and(
                        eq(
                          unlimitedPassDayMoves.reservationId,
                          workspaceReservations.id
                        ),
                        isNull(unlimitedPassDayMoves.settledAt)
                      )
                    )
                )
              )
            ),
        ])
      : [[], []];
    const local = Map.groupBy(holds, ({ row }) => row.dotyposReservationId);
    const movablePassIds = new Set(passDays.map(({ id }) => id));
    const bookings: TeamTableBooking[] = [];

    for (const record of occupancy.records) {
      const tableId = record._tableId;
      if (
        !tableId ||
        (record.status !== "NEW" && record.status !== "CONFIRMED")
      )
        continue;
      const decoded = decodeBookedReservation(record);
      const interval = Option.getOrUndefined(decoded.occupiedInterval);
      const seats = Option.getOrUndefined(decoded.seats);
      const matches = local.get(record.id);
      const hold = matches?.length === 1 ? matches[0] : undefined;
      const kind =
        hold &&
        Option.getOrUndefined(readKind(hold.row.reservationDetails))?.kind;

      if (kind === "table" && interval) {
        bookings.push({ kind: "team-table", tableId, interval });
        continue;
      }
      if (
        !interval ||
        !seats ||
        (kind !== "cowork" && !record.unlimitedPassDay)
      ) {
        bookings.push({
          kind: "unknown",
          tableId,
          ...(interval && { interval }),
        });
        continue;
      }

      let move: Move;
      // A NEW checkout hold can still be changed by payment or supersession
      // before those paths have taken a source-order section.
      if (hold && !hold.moving && record.status === "CONFIRMED") {
        const { row } = hold;
        const day = getWorkspaceDate(interval.startsAt);
        const serviceDate = plainDateStringSchema.make(day.toString());
        const providerOwnsHold =
          !("_customerId" in record) ||
          record._customerId === row.dotyposCustomerId;
        if (
          providerOwnsHold &&
          row.passId &&
          record.status === "CONFIRMED" &&
          row.serviceDate === serviceDate &&
          row.passDayTableId === tableId &&
          movablePassIds.has(row.id) &&
          ("note" in record
            ? record.note
                ?.split("\n")
                .includes(
                  formatPassDayMarker(
                    row.passId,
                    day,
                    row.passDayHoldGeneration
                  )
                )
            : record.unlimitedPassDay === true)
        ) {
          move = {
            reservationId: row.id,
            sourceReservationId: record.id,
            serviceDate,
            origin: "unlimited-pass",
            status: "CONFIRMED",
          };
        } else if (
          providerOwnsHold &&
          !row.passId &&
          hold.hasOrder &&
          (!("note" in record) ||
            record.note
              ?.split("\n")
              .some((line) => noteNamesPaymentOrder(line, row.id)))
        ) {
          const standing = getOrdinaryOpenSpaceMoveStanding(
            row,
            hold.claim,
            record.status,
            serviceDate,
            now
          );
          if (standing)
            move = {
              reservationId: row.id,
              sourceReservationId: record.id,
              serviceDate,
              ...standing,
            };
        }
      }
      bookings.push({
        kind: "shared",
        tableId,
        interval,
        seats,
        ...(move && { move }),
      });
    }

    return [
      ...bookings,
      ...occupancy.unobservedBookings.map(projectBooking),
      ...occupancy.exclusiveBookings.map(projectBooking),
    ];
  });
});

export class TeamTableInventory extends Context.Service<
  TeamTableInventory,
  Effect.Success<typeof makeInventory>
>()("TeamTableInventory") {
  static Default = Layer.effect(this, makeInventory);
}
