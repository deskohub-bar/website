import "server-only";

import {
  type DotyposReservation,
  type DotyposReservationId,
  DotyposService,
} from "@deskohub/dotypos";
import type {
  AutomationTrigger,
  ReservationPayment,
  ReservationStay,
} from "@deskohub/workspace-admin-api";
import { and, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { workspaceReservations } from "@/db/schema";
import {
  type WorkspaceCoworkProductTier,
  workspaceCoworkTiers,
} from "@/features/checkout/product-catalog";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import type { ReservationVisit } from "@/features/reservation/backend/reservation-visits.service";
import { StoredReservationDetails } from "@/features/reservation/backend/stored-reservation-details.server";
import { overnightCoworkStayTier } from "@/features/reservation/cowork-stay";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { reservationPaymentCondition } from "../../backend/reservation-payment-condition";
import { isBookedStay, loadCoworkTiers } from "../../backend/reservation-stay";
import { readsTriggeringVisit } from "../automation-trigger-verification";
import { automationTriggerKind } from "../automation-triggers";
import { AutomationUnitFetchFailure } from "./automation-unit-handler";

/** The stay a reservation trigger's visit must be of; none when unset (D1). */
export const triggerStay = (
  trigger: AutomationTrigger
): Option.Option<ReservationStay> =>
  Option.fromUndefinedOr("stay" in trigger ? trigger.stay : undefined);

/** How a reservation trigger's reservation must be paid; none when unset (D1). */
export const triggerPayment = (
  trigger: AutomationTrigger
): Option.Option<ReservationPayment> =>
  Option.fromUndefinedOr("payment" in trigger ? trigger.payment : undefined);

/**
 * Whether taking in an event of the trigger reads its reservation's visit
 * from Dotypos: for the re-check (D35), or for the stay (D1).
 */
export const readsTriggerVisit = (trigger: AutomationTrigger): boolean =>
  readsTriggeringVisit(automationTriggerKind(trigger)) ||
  Option.isSome(triggerStay(trigger));

/**
 * A stay trigger's visit (D1), the one read both its stay and its re-check
 * (D35) judge, so both see the same version of it.
 */
export type StayVisit = {
  readonly visit: ReservationVisit;
  /** The stored cowork tier; none for another family. */
  readonly tier: WorkspaceCoworkProductTier | undefined;
};

const databaseFailure = (cause: unknown) =>
  new AutomationUnitFetchFailure({ code: "database", cause });

type LinkedReservation = {
  readonly workspaceReservationId: WorkspaceReservationId;
  readonly dotyposReservationId: DotyposReservationId;
  readonly dotyposCustomerId: ReservationVisit["dotyposCustomerId"];
  readonly reservationDetails: unknown;
};

/** The reservations with a Dotypos reservation, whatever their Workspace state. */
const linkedReservations = (input: {
  readonly reservationIds: readonly WorkspaceReservationId[];
}) =>
  Effect.flatMap(WorkspaceDatabase, ({ db }) =>
    db
      .select({
        workspaceReservationId: workspaceReservations.id,
        dotyposReservationId: workspaceReservations.dotyposReservationId,
        dotyposCustomerId: workspaceReservations.dotyposCustomerId,
        reservationDetails: workspaceReservations.reservationDetails,
      })
      .from(workspaceReservations)
      .where(
        and(
          inArray(workspaceReservations.id, [...input.reservationIds]),
          isNotNull(workspaceReservations.dotyposReservationId)
        )
      )
  ).pipe(
    Effect.map((rows) =>
      rows.flatMap(({ dotyposReservationId, ...row }): LinkedReservation[] =>
        dotyposReservationId === null ? [] : [{ ...row, dotyposReservationId }]
      )
    ),
    Effect.mapError(databaseFailure)
  );

/** The visit Dotypos returns for a linked reservation, if its interval decodes. */
const visitOf = (
  linked: LinkedReservation,
  reservation: DotyposReservation
): Option.Option<ReservationVisit> =>
  Option.map(
    decodeBookedReservation(
      reservation,
      Option.getOrUndefined(
        StoredReservationDetails.project(linked.reservationDetails)
      )
    ).interval,
    (interval): ReservationVisit => ({
      workspaceReservationId: linked.workspaceReservationId,
      dotyposReservationId: linked.dotyposReservationId,
      dotyposCustomerId: linked.dotyposCustomerId,
      startsAt: interval.startsAt,
      endsAt: interval.endsAt,
      status: reservation.status === "CANCELLED" ? "cancelled" : "active",
    })
  );

/**
 * The visits of stay triggers' reservations (D1), at most one Dotypos
 * request per 100. Unlike the re-check's usual visits, these include
 * reservations Workspace cancelled: a cancellation trigger fires on one,
 * and cancelling doesn't change a visit's stay. A reservation without a
 * Dotypos reservation, one Dotypos doesn't return, or one whose interval
 * doesn't decode is absent, so of no stay.
 */
export const loadStayVisits = (
  reservationIds: readonly WorkspaceReservationId[]
): Effect.Effect<
  ReadonlyMap<WorkspaceReservationId, StayVisit>,
  AutomationUnitFetchFailure,
  WorkspaceDatabase | DotyposService
> =>
  reservationIds.length === 0
    ? Effect.succeed(new Map<WorkspaceReservationId, StayVisit>())
    : Effect.Do.pipe(
        Effect.bind("linked", () => linkedReservations({ reservationIds })),
        Effect.let("dotyposIds", ({ linked }) =>
          linked.map(({ dotyposReservationId }) => dotyposReservationId)
        ),
        Effect.bind("tiers", ({ dotyposIds }) =>
          Effect.flatMap(WorkspaceDatabase, ({ db }) =>
            loadCoworkTiers(db, dotyposIds)
          ).pipe(Effect.mapError(databaseFailure))
        ),
        Effect.bind("reservations", ({ dotyposIds }) =>
          Effect.flatMap(DotyposService, (dotypos) =>
            dotypos.getReservationsByIds(dotyposIds, { concurrency: 1 })
          ).pipe(Effect.mapError(AutomationUnitFetchFailure.fromDotypos))
        ),
        Effect.map(
          ({ linked, tiers, reservations }) =>
            new Map(
              linked.flatMap((reservation) =>
                Option.match(
                  Option.flatMap(
                    Option.fromUndefinedOr(
                      reservations.get(reservation.dotyposReservationId)
                    ),
                    (found) => visitOf(reservation, found)
                  ),
                  {
                    onNone: () => [],
                    onSome: (visit) => [
                      [
                        reservation.workspaceReservationId,
                        {
                          visit,
                          tier: tiers.get(reservation.dotyposReservationId),
                        },
                      ] as const,
                    ],
                  }
                )
              )
            )
        )
      );

/**
 * The stored cowork tier of each of these reservations with a Dotypos
 * reservation, whatever their Workspace state; another family's is absent.
 */
export const loadStayTiers = (
  reservationIds: readonly WorkspaceReservationId[]
): Effect.Effect<
  ReadonlyMap<WorkspaceReservationId, WorkspaceCoworkProductTier>,
  AutomationUnitFetchFailure,
  WorkspaceDatabase
> =>
  reservationIds.length === 0
    ? Effect.succeed(
        new Map<WorkspaceReservationId, WorkspaceCoworkProductTier>()
      )
    : Effect.Do.pipe(
        Effect.bind("linked", () => linkedReservations({ reservationIds })),
        Effect.bind("tiers", ({ linked }) =>
          Effect.flatMap(WorkspaceDatabase, ({ db }) =>
            loadCoworkTiers(
              db,
              linked.map(({ dotyposReservationId }) => dotyposReservationId)
            )
          ).pipe(Effect.mapError(databaseFailure))
        ),
        Effect.map(
          ({ linked, tiers }) =>
            new Map(
              linked.flatMap(
                ({ workspaceReservationId, dotyposReservationId }) =>
                  Option.match(
                    Option.fromUndefinedOr(tiers.get(dotyposReservationId)),
                    {
                      onNone: () => [],
                      onSome: (tier) => [
                        [workspaceReservationId, tier] as const,
                      ],
                    }
                  )
              )
            )
        )
      );

/**
 * Selects `workspace_reservations` rows whose stored tier can give the
 * stay, as `mayBeOfTriggerStay` judges a tier: cowork reservations, and
 * for an overnight stay only Reserved Desk ones.
 */
export const stayTierCondition = (stay: ReservationStay): SQL => {
  const tiers =
    stay === "overnight" ? [overnightCoworkStayTier] : workspaceCoworkTiers;
  return (
    and(
      sql`${StoredReservationDetails.kind} = 'cowork'`,
      sql`${StoredReservationDetails.property("cowork", "tier")} in (${sql.join(
        tiers.map((tier) => sql`${tier}`),
        sql`, `
      )})`
    ) ?? sql`false`
  );
};

/**
 * Whether a visit of this stored tier can be of the trigger's stay without
 * reading its interval (D1): a reservation without a cowork tier has no
 * stay, and only Reserved Desk can be overnight, so another tier is a day
 * stay. Only a Reserved Desk visit needs its interval to tell.
 */
export const mayBeOfTriggerStay = (
  stay: Option.Option<ReservationStay>,
  tier: WorkspaceCoworkProductTier | undefined
): boolean =>
  Option.match(stay, {
    onNone: () => true,
    onSome: (stay) =>
      tier !== undefined &&
      (tier === overnightCoworkStayTier || stay === "day"),
  });

/**
 * Whether the triggering visit is of the trigger's stay (D1): always
 * without one. Otherwise its booked interval and stored cowork tier must
 * give that stay. Intake judges it once, from the visit it reads when it
 * takes the event in. The pre-submit re-check (D35) reads the visit again
 * only to withdraw or defer the send, never to judge its stay again.
 */
export const isOfTriggerStay = (
  stay: Option.Option<ReservationStay>,
  visit: Option.Option<StayVisit>
): boolean =>
  Option.match(stay, {
    onNone: () => true,
    onSome: (stay) =>
      Option.exists(visit, ({ visit, tier }) =>
        isBookedStay(stay, { tier, interval: visit })
      ),
  });

/**
 * The reservations among these paid the way `payment` names, as they are
 * now (D1). Without a payment, all of them.
 */
export const loadPaidReservations = (
  payment: Option.Option<ReservationPayment>,
  reservationIds: readonly WorkspaceReservationId[]
): Effect.Effect<
  Option.Option<ReadonlySet<WorkspaceReservationId>>,
  AutomationUnitFetchFailure,
  WorkspaceDatabase
> =>
  Option.match(payment, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (payment) =>
      reservationIds.length === 0
        ? Effect.succeed(Option.some(new Set<WorkspaceReservationId>()))
        : Effect.flatMap(WorkspaceDatabase, ({ db }) =>
            db
              .select({ id: workspaceReservations.id })
              .from(workspaceReservations)
              .where(
                and(
                  inArray(workspaceReservations.id, [...reservationIds]),
                  reservationPaymentCondition(payment)
                )
              )
          ).pipe(
            Effect.map((rows) =>
              Option.some(new Set(rows.map(({ id }) => id)))
            ),
            Effect.mapError(databaseFailure)
          ),
  });

/**
 * Whether the event's reservation is paid as its trigger requires, by
 * `loadPaidReservations`' answer. A Dotypos-only reservation never is.
 */
export const isPaidAsTriggerRequires = (
  paid: Option.Option<ReadonlySet<WorkspaceReservationId>>,
  reservationId: WorkspaceReservationId | null
): boolean =>
  Option.match(paid, {
    onNone: () => true,
    onSome: (ids) => reservationId !== null && ids.has(reservationId),
  });
