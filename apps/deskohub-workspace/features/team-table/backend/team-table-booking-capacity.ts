import {
  type DotyposReservationId,
  DotyposService,
  type DotyposTableId,
} from "@deskohub/dotypos";
import { Data, Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  holdWorkspaceReservationOrders,
  WorkspaceLockSections,
} from "@/db/workspace-locks";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import {
  WorkspaceAvailabilityService,
  WorkspaceTableUnavailableError,
} from "@/features/reservation/backend/workspace-availability.service";
import {
  type WorkspaceReservation,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { getTouchedWorkspaceDateBounds } from "@/features/reservation/reservation-date";
import { getReservationDateBounds } from "@/features/reservation/reservation-interval";
import type { TableReservationDetails } from "@/features/reservation/table-reservation";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { getPlainDatesBetween } from "@/shared/utils/temporal";
import { OpenSpaceTableMoves } from "./open-space-table-moves";
import type { TeamTablePlan } from "./team-table-plan";

class TeamTableCapacityChanged extends Data.TaggedError(
  "TeamTableCapacityChanged"
) {}

type AssignmentError =
  | Effect.Error<
      ReturnType<
        WorkspaceAvailabilityService["Service"]["getLiveTeamTablePlan"]
      >
    >
  | WorkspaceTableUnavailableError;

type DisplacedOrder = Pick<WorkspaceReservation, "id" | "dotyposReservationId">;

/** A capacity assignment that can only run inside the enclosing booking section. */
export type TeamTableBookingCapacity = {
  readonly assignTableId: Effect.Effect<DotyposTableId, AssignmentError>;
  readonly assertCanDisplace?: (
    order: DisplacedOrder
  ) => Effect.Effect<void, WorkspaceTableUnavailableError>;
};

export const TeamTableBookingCapacityLive = Layer.mergeAll(
  WorkspaceAvailabilityService.Live,
  WorkspaceDatabaseAdvisoryLock.Default,
  OpenSpaceTableMoves.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceDatabase.Default,
        WorkspaceDatabaseAdvisoryLock.Default,
        WorkspaceReservationRepository.Live,
        WorkspaceDotyposLayer
      )
    )
  )
);

type DisplacedHold = DisplacedOrder & {
  readonly providerId?: DotyposReservationId;
  readonly dates: readonly Temporal.PlainDate[];
};

/** Only the current pending provider reservation belonging to this order may be omitted for lookahead. */
export const readDisplacedTeamTableHold = Effect.fnUntraced(function* (
  order: Pick<
    WorkspaceReservation,
    "id" | "dotyposReservationId" | "dotyposCustomerId"
  >
) {
  if (!order.dotyposReservationId) return undefined;
  const dotypos = yield* DotyposService;
  const record = yield* dotypos
    .getReservationWithoutCustomer(order.dotyposReservationId)
    .pipe(
      Effect.catchTag("DotyposRejected", (failure) =>
        failure.reason === "not-found"
          ? Effect.succeed(undefined)
          : Effect.fail(failure)
      )
    );
  const interval = record && decodeBookedReservation(record).occupiedInterval;
  const dates =
    interval && Option.isSome(interval)
      ? getTouchedWorkspaceDateBounds(interval.value)
      : null;
  return {
    id: order.id,
    dotyposReservationId: order.dotyposReservationId,
    providerId:
      record?.status === "NEW" &&
      record.id === order.dotyposReservationId &&
      record._customerId === order.dotyposCustomerId &&
      dates
        ? record.id
        : undefined,
    dates: dates ? getPlainDatesBetween(dates.first, dates.last) : [],
  } satisfies DisplacedHold;
});

const unavailableFor = (reservation: TableReservationDetails) =>
  new WorkspaceTableUnavailableError({
    date: getReservationDateBounds(reservation).first.toString(),
    reservation: { kind: reservation.kind },
  });

const discoverCapacity = Effect.fnUntraced(function* <E, R>(input: {
  readonly reservation: TableReservationDetails;
  readonly lookupDisplacedHolds?: Effect.Effect<readonly DisplacedHold[], E, R>;
  readonly forExistingOrder?: true;
}) {
  const { reservation, forExistingOrder } = input;
  const availability = yield* WorkspaceAvailabilityService;
  const moves = yield* OpenSpaceTableMoves;
  const getPlan = (
    displaced: readonly DisplacedHold[] = [],
    exactId?: DotyposTableId
  ) =>
    availability.getLiveTeamTablePlan(reservation, exactId, {
      forExistingOrder,
      displacedHoldIds: displaced.flatMap(({ providerId }) =>
        providerId ? [providerId] : []
      ),
    });
  const lookup = input.lookupDisplacedHolds ?? Effect.succeed([]);
  const prior = yield* lookup;
  const discovered = yield* getPlan(prior);
  const getSourceAccounts = Effect.fnUntraced(function* (
    plan: TeamTablePlan | undefined
  ) {
    const sources = plan?.moves.filter(({ status }) => status === "NEW") ?? [];
    if (sources.length === 0) return [];
    const repository = yield* Effect.serviceOption(
      WorkspaceReservationRepository
    );
    if (Option.isNone(repository)) return yield* unavailableFor(reservation);
    return yield* Effect.forEach(
      sources,
      Effect.fnUntraced(function* ({ reservationId }) {
        const source = yield* repository.value
          .findById(reservationId)
          .pipe(
            Effect.catchTag("WorkspaceReservationDetailsMalformedError", () =>
              Effect.fail(unavailableFor(reservation))
            )
          );
        if (!source) return yield* unavailableFor(reservation);
        return source.authorAccountId;
      })
    );
  });
  const sourceAccountIds = yield* getSourceAccounts(discovered);
  const { first, last } = getReservationDateBounds(reservation);
  const dates = [
    ...getPlainDatesBetween(first, last),
    ...prior.flatMap(({ dates }) => dates),
    ...(discovered?.moves.map(({ serviceDate }) =>
      Temporal.PlainDate.from(serviceDate)
    ) ?? []),
  ];
  const orderIds = [
    ...prior.map(({ id }) => id),
    ...(discovered?.moves.map(({ reservationId }) => reservationId) ?? []),
  ];
  const lockedDates = new Set(dates.map(String));
  const lockedOrders = new Set(orderIds);
  const lockedAccounts = new Set(sourceAccountIds);
  const needsMoreLocks = (plan: TeamTablePlan | undefined) =>
    plan?.moves.some(
      ({ reservationId, serviceDate }) =>
        !lockedOrders.has(reservationId) || !lockedDates.has(serviceDate)
    ) ?? false;

  const validate = Effect.gen(function* () {
    const current = yield* lookup;
    if (
      current.length !== prior.length ||
      current.some(
        (hold) =>
          !prior.some(
            (first) =>
              first.id === hold.id &&
              first.dotyposReservationId === hold.dotyposReservationId &&
              first.providerId === hold.providerId
          ) || hold.dates.some((date) => !lockedDates.has(date.toString()))
      )
    )
      return yield* new TeamTableCapacityChanged();
    const fresh = yield* getPlan(current);
    if (
      needsMoreLocks(fresh) ||
      (yield* getSourceAccounts(fresh)).some((id) => !lockedAccounts.has(id))
    )
      return yield* new TeamTableCapacityChanged();
    if (current.length > 0 && !fresh && !forExistingOrder)
      return yield* unavailableFor(reservation);
  });

  // The displaced hold is counted again here. The caller must have retired
  // it before assignment, while holding its order key and service dates.
  const assignTableId = Effect.gen(function* () {
    const fresh = yield* getPlan();
    if (
      !fresh ||
      needsMoreLocks(fresh) ||
      (yield* getSourceAccounts(fresh)).some((id) => !lockedAccounts.has(id))
    )
      return yield* unavailableFor(reservation);
    const moved = yield* moves
      .repackInCapacitySection({
        ...fresh,
        interval: reservation,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Team Table repacking needs reconciliation", {
            cause,
          }).pipe(Effect.as(false))
        )
      );
    if (!moved) return yield* unavailableFor(reservation);
    const final = yield* getPlan(undefined, fresh.tableId);
    if (final?.tableId !== fresh.tableId || final.moves.length !== 0)
      return yield* unavailableFor(reservation);
    return fresh.tableId;
  });

  // Draft preparation can retry or rotate again after validation. It may
  // only cancel a hold that the locked plan already accounted for.
  const assertCanDisplace = (order: DisplacedOrder) =>
    prior.some(
      ({ id, dotyposReservationId }) =>
        id === order.id && dotyposReservationId === order.dotyposReservationId
    )
      ? Effect.void
      : Effect.fail(unavailableFor(reservation));

  return {
    dates,
    orderIds,
    sourceAccountIds,
    validate,
    assignTableId,
    assertCanDisplace,
  };
});

const retryDiscovery = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  reservation: TableReservationDetails
) =>
  work.pipe(
    Effect.retry({
      times: 3,
      while: (error) => error instanceof TeamTableCapacityChanged,
    }),
    Effect.mapError((error) =>
      error instanceof TeamTableCapacityChanged
        ? unavailableFor(reservation)
        : error
    )
  );

/** Holds the order/account/date union across checkout's provider mutation. */
export const withTeamTableBookingCapacity = <
  A,
  E,
  R,
  LookupError = never,
  LookupServices = never,
>(
  input: {
    readonly reservation: TableReservationDetails;
    readonly authorAccountId: CustomerAccountId;
    readonly lookupDisplacedHolds?: Effect.Effect<
      readonly DisplacedHold[],
      LookupError,
      LookupServices
    >;
  },
  section: (capacity: TeamTableBookingCapacity) => Effect.Effect<A, E, R>
) =>
  retryDiscovery(
    Effect.gen(function* () {
      const plan = yield* discoverCapacity(input);
      return yield* WorkspaceLockSections.reservationCapacity(plan.dates, {
        authorAccountId: input.authorAccountId,
        movedReservations: plan.orderIds,
        sourceAccountIds: plan.sourceAccountIds,
      })(
        plan.validate.pipe(Effect.andThen(Effect.suspend(() => section(plan))))
      );
    }),
    input.reservation
  );

export type TeamTablePaymentCapacity = {
  readonly withCapacity: <A, E, R>(
    section: (capacity: TeamTableBookingCapacity) => Effect.Effect<A, E, R>
  ) => Effect.Effect<
    A,
    E | import("effect/sql").SqlError.SqlError,
    R | WorkspaceDatabaseAdvisoryLock
  >;
};

/** Keeps order serialization while releasing the date keys before payment settlement. */
export const withTeamTablePaymentCapacity = <
  A,
  E,
  R,
  LookupError,
  LookupServices,
>(
  input: {
    readonly reservation: TableReservationDetails;
    readonly orderId: WorkspaceReservationId;
    readonly lookupDisplacedHold: Effect.Effect<
      DisplacedHold | undefined,
      LookupError,
      LookupServices
    >;
  },
  section: (capacity: TeamTablePaymentCapacity) => Effect.Effect<A, E, R>
) =>
  retryDiscovery(
    Effect.gen(function* () {
      const plan = yield* discoverCapacity({
        ...input,
        forExistingOrder: true,
        lookupDisplacedHolds: input.lookupDisplacedHold.pipe(
          Effect.map((hold) => (hold ? [hold] : []))
        ),
      });
      const withCapacity: TeamTablePaymentCapacity["withCapacity"] = (work) =>
        WorkspaceLockSections.reservationCapacity(plan.dates, {
          sourceAccountIds: plan.sourceAccountIds,
        })(Effect.suspend(() => work(plan)));
      return yield* holdWorkspaceReservationOrders(
        input.orderId,
        plan.orderIds
      )(
        plan.validate.pipe(
          Effect.andThen(Effect.suspend(() => section({ withCapacity })))
        )
      );
    }),
    input.reservation
  );
