import {
  type DotyposReservation,
  type DotyposReservationId,
  DotyposService,
  type DotyposTableId,
} from "@deskohub/dotypos";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Option, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  openSpaceTableMoveBatches,
  openSpaceTableMoves,
  orders,
  passEntryClaims,
  passPurchases,
  unlimitedPassDayMoves,
  workspaceReservations,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { noteNamesPaymentOrder } from "@/features/checkout/backend/reservation/order-reservation-note";
import {
  getOccupancyWindow,
  getOccupancyWindowDates,
  workspaceBookingSeatCount,
} from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import {
  decodeTableSeatCapacity,
  isWorkspaceCoworkTableCandidate,
} from "@/features/checkout/backend/reservation/workspace-table-selection";
import { movablePassDay } from "@/features/passes/backend/movable-pass-day";
import { getCapacityInventory } from "@/features/passes/backend/pass-day-capacity-bookings";
import { formatPassDayMarker } from "@/features/passes/pass-day-marker";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import {
  formatOpenSpaceMoveMarker,
  withoutOpenSpaceMoveMarkers,
} from "@/features/reservation/backend/open-space-move-marker";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { findReservationOrderId } from "@/features/reservation/persistence-contracts";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import {
  getReservationDateBounds,
  type ReservationInterval,
} from "@/features/reservation/reservation-interval";
import {
  currentInstant,
  getPlainDatesBetween,
  plainDateStringSchema,
  temporalInstantToDate,
} from "@/shared/utils/temporal";
import { getOrdinaryOpenSpaceMoveStanding } from "./team-table-inventory";

type Move = typeof openSpaceTableMoves.$inferSelect;
type Batch = typeof openSpaceTableMoveBatches.$inferSelect;
type MoveRequest = Pick<
  Move,
  | "reservationId"
  | "sourceReservationId"
  | "targetTableId"
  | "serviceDate"
  | "status"
  | "startsAt"
  | "endsAt"
>;

type RepackRequest = {
  readonly tableId: DotyposTableId;
  readonly interval: ReservationInterval;
  readonly moves: readonly MoveRequest[];
  readonly authorAccountId?: CustomerAccountId;
};

const pending = (move: Pick<Move, "generation">) =>
  and(
    eq(openSpaceTableMoves.generation, move.generation),
    isNull(openSpaceTableMoves.settledAt)
  );

const moveMarker = ({ generation }: Pick<Move, "generation">) =>
  formatOpenSpaceMoveMarker(generation);

const booking = (move: Move, tableId: DotyposTableId) => ({
  customerId: move.customerId,
  tableId,
  seats: workspaceBookingSeatCount,
  startDate: temporalInstantToDate(move.startsAt),
  endDate: temporalInstantToDate(move.endsAt),
});

const matchesBooking = (record: DotyposReservation, move: Move) => {
  const { interval, seats } = decodeBookedReservation(record);
  return (
    record._customerId === move.customerId &&
    Option.contains(seats, workspaceBookingSeatCount) &&
    Option.exists(
      interval,
      ({ startsAt, endsAt }) =>
        startsAt.equals(move.startsAt) && endsAt.equals(move.endsAt)
    )
  );
};

const matchesHold = (
  record: DotyposReservation,
  move: Move,
  tableId: DotyposTableId,
  noteLine: string
) =>
  record._tableId === tableId &&
  record.note?.split("\n").includes(noteLine) === true &&
  matchesBooking(record, move);

const datesForBatch = (batch: Batch, moves: readonly MoveRequest[]) => [
  ...getPlainDatesBetween(
    Temporal.PlainDate.from(batch.firstDate),
    Temporal.PlainDate.from(batch.lastDate)
  ),
  ...moves.map(({ serviceDate }) => Temporal.PlainDate.from(serviceDate)),
];

const makeOpenSpaceTableMoves = Effect.gen(function* () {
  const { db, transaction } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;
  const advisoryLock = yield* WorkspaceDatabaseAdvisoryLock;
  const reservations = yield* WorkspaceReservationRepository;

  const readHold = (id: DotyposReservationId) =>
    dotypos
      .getReservationWithoutCustomer(id)
      .pipe(
        Effect.catchTag("DotyposRejected", (error) =>
          error.reason === "not-found"
            ? Effect.succeed(undefined)
            : Effect.fail(error)
        )
      );

  const updateMove = (move: Move, values: Partial<Move>) =>
    db.update(openSpaceTableMoves).set(values).where(pending(move));

  const settle = Effect.fnUntraced(function* (move: Move) {
    yield* updateMove(move, { settledAt: yield* currentInstant });
  });

  const ambiguous = Effect.fnUntraced(function* (
    move: Move,
    ids?: readonly DotyposReservationId[]
  ) {
    yield* updateMove(move, {
      ambiguousAt: yield* currentInstant,
      ...(ids && { ambiguousReservationIds: [...ids] }),
    });
    yield* Effect.logWarning("Open Space move provider ownership is uncertain");
  });

  const readLocal = (move: MoveRequest) =>
    db
      .select()
      .from(workspaceReservations)
      .where(eq(workspaceReservations.id, move.reservationId));

  const eligibleSource = Effect.fnUntraced(function* (
    request: MoveRequest,
    row: typeof workspaceReservations.$inferSelect,
    source: DotyposReservation
  ) {
    const now = yield* currentInstant;
    if (
      row.dotyposReservationId !== request.sourceReservationId ||
      source._customerId !== row.dotyposCustomerId ||
      source.status !== request.status ||
      request.serviceDate <= getWorkspaceDate(now).toString()
    )
      return undefined;

    if (row.passId) {
      if (
        request.status !== "CONFIRMED" ||
        row.serviceDate !== request.serviceDate ||
        row.passDayTableId !== source._tableId
      )
        return undefined;
      const [passDay] = yield* db
        .select({ id: workspaceReservations.id })
        .from(workspaceReservations)
        .innerJoin(
          passPurchases,
          eq(passPurchases.id, workspaceReservations.passId)
        )
        .innerJoin(orders, eq(orders.id, passPurchases.id))
        .where(and(eq(workspaceReservations.id, row.id), movablePassDay));
      const [legacyMove] = yield* db
        .select({ generation: unlimitedPassDayMoves.generation })
        .from(unlimitedPassDayMoves)
        .where(
          and(
            eq(unlimitedPassDayMoves.reservationId, row.id),
            isNull(unlimitedPassDayMoves.settledAt)
          )
        );
      return passDay && !legacyMove
        ? formatPassDayMarker(
            row.passId,
            Temporal.PlainDate.from(request.serviceDate),
            row.passDayHoldGeneration
          )
        : undefined;
    }

    const orderId = findReservationOrderId(row.id);
    if (Option.isNone(orderId)) return undefined;
    const [order] = yield* db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId.value), eq(orders.kind, "reservation")));
    if (!order) return undefined;

    const [claim] = yield* db
      .select({ status: passEntryClaims.status, date: passEntryClaims.date })
      .from(passEntryClaims)
      .where(eq(passEntryClaims.reservationId, row.id));
    const eligible = getOrdinaryOpenSpaceMoveStanding(
      row,
      claim,
      request.status,
      request.serviceDate,
      now
    );
    return eligible
      ? source.note
          ?.split("\n")
          .find((line) => noteNamesPaymentOrder(line, row.id))
      : undefined;
  });

  const makeMove = Effect.fnUntraced(function* (
    batch: Batch,
    sourceTableId: DotyposTableId,
    window: ReturnType<typeof getOccupancyWindow>,
    request: MoveRequest
  ) {
    if (request.targetTableId === sourceTableId) return undefined;
    const [row] = yield* readLocal(request);
    const source = yield* readHold(request.sourceReservationId);
    if (!row || source?._tableId !== sourceTableId) return undefined;
    const note = yield* eligibleSource(request, row, source);
    const { interval, seats } = decodeBookedReservation(source);
    if (
      !note ||
      !source.note?.split("\n").includes(note) ||
      !Option.contains(seats, workspaceBookingSeatCount) ||
      Option.isNone(interval) ||
      !interval.value.startsAt.equals(request.startsAt) ||
      !interval.value.endsAt.equals(request.endsAt) ||
      interval.value.startsAt.epochMilliseconds >= window.endsAt ||
      interval.value.endsAt.epochMilliseconds <= window.startsAt ||
      interval.value.startsAt.epochNanoseconds % 1_000_000n !== 0n ||
      interval.value.endsAt.epochNanoseconds % 1_000_000n !== 0n ||
      getWorkspaceDate(interval.value.startsAt).toString() !==
        request.serviceDate ||
      getWorkspaceDate(
        interval.value.endsAt.subtract({ nanoseconds: 1 })
      ).toString() !== request.serviceDate
    )
      return undefined;
    return {
      ...request,
      batchId: batch.id,
      generation: crypto.randomUUID(),
      customerId: row.dotyposCustomerId,
      sourceTableId,
      sourceNoteLine: note,
      checkedAt: batch.requestedAt,
      attemptedAt: null,
      attachedAt: null,
      settledAt: null,
      targetReservationId: null,
      ambiguousAt: null,
      ambiguousReservationIds: null,
    } satisfies Move;
  });

  const withPassOrder = <A, E, R>(move: Move, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const [row] = yield* readLocal(move);
      return yield* row?.passId
        ? WorkspaceLockSections.passPurchaseFulfillment(row.passId)(
            effect
          ).pipe(
            Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock)
          )
        : effect;
    });

  const retire = Effect.fnUntraced(function* (
    move: Move,
    side: "source" | "target"
  ) {
    const target = side === "target";
    const id = target ? move.targetReservationId : move.sourceReservationId;
    if (!id) return false;
    const record = yield* readHold(id);
    if (!record || record.status === "CANCELLED") {
      yield* settle(move);
      return true;
    }
    const tableId = target ? move.targetTableId : move.sourceTableId;
    const noteLine = target ? moveMarker(move) : move.sourceNoteLine;
    if (
      !matchesHold(record, move, tableId, noteLine) ||
      (record.status !== move.status && !(target && record.status === "NEW"))
    ) {
      yield* ambiguous(move);
      return false;
    }
    yield* dotypos.setReservationStatusIfMatches({
      reservationId: id,
      expectedBooking: booking(move, tableId),
      expectedNoteLine: noteLine,
      expectedCurrentStatus: record.status,
      status: "CANCELLED",
    });
    const reread = yield* readHold(id);
    if (reread && reread.status !== "CANCELLED") return false;
    yield* settle(move);
    return true;
  });

  const retireSource = Effect.fnUntraced(function* (move: Move) {
    if (!move.targetReservationId) return false;
    const [row] = yield* readLocal(move);
    if (row?.dotyposReservationId !== move.targetReservationId) {
      yield* ambiguous(move);
      return false;
    }
    const record = yield* readHold(move.targetReservationId);
    if (row.reservationState !== "cancelled") {
      if (
        !record ||
        !matchesHold(record, move, move.targetTableId, moveMarker(move)) ||
        (record.status !== "CONFIRMED" &&
          !(move.status === "NEW" && record.status === "NEW"))
      )
        return false;
    }
    return yield* retire(move, "source");
  });

  const retireTarget = Effect.fnUntraced(function* (move: Move) {
    const [row] = yield* readLocal(move);
    if (!row || row.dotyposReservationId === move.targetReservationId) {
      yield* ambiguous(move);
      return;
    }
    if (
      row.reservationState !== "cancelled" &&
      row.reservationState !== "hold_expired"
    ) {
      const current = row.dotyposReservationId
        ? yield* readHold(row.dotyposReservationId)
        : undefined;
      const ownsLiveHold =
        row.dotyposCustomerId === move.customerId &&
        current &&
        (current.status === "NEW" || current.status === "CONFIRMED") &&
        (current.id === move.sourceReservationId
          ? matchesHold(current, move, move.sourceTableId, move.sourceNoteLine)
          : !row.passId &&
            current._tableId !== undefined &&
            noteNamesPaymentOrder(current.note, row.id) &&
            matchesBooking(current, move));
      if (!ownsLiveHold) {
        yield* ambiguous(move);
        return;
      }
    }
    yield* retire(move, "target");
  });

  const findTarget = Effect.fnUntraced(function* (move: Move) {
    if (move.targetReservationId)
      return yield* readHold(move.targetReservationId);
    const { startDate, endDate } = getOccupancyWindowDates(
      getOccupancyWindow(Temporal.PlainDate.from(move.serviceDate))
    );
    const records = yield* dotypos.listReservations({
      customerId: move.customerId,
      startsAtOrAfter: startDate.toISOString(),
      startsBefore: endDate.toISOString(),
    });
    const ids = new Set(
      records
        .filter(({ note }) => note?.split("\n").includes(moveMarker(move)))
        .map(({ id }) => id)
    );
    if (ids.size > 1) {
      yield* ambiguous(move, [...ids]);
      return undefined;
    }
    const id = ids.values().next().value;
    return id ? yield* readHold(id) : undefined;
  });

  const hasTargetCapacity = Effect.fnUntraced(function* (move: Move) {
    const window = {
      startsAt: move.startsAt.epochMilliseconds,
      endsAt: move.endsAt.epochMilliseconds,
    };
    const date = Temporal.PlainDate.from(move.serviceDate);
    const { tables, records, expired, claims, pendingTargets } =
      yield* Effect.all({
        tables: dotypos.getTables(),
        records: dotypos.listActiveReservationsOverlapping(
          getOccupancyWindowDates(window)
        ),
        expired: reservations.selectExpiredHoldDotyposReservationIds({
          now: yield* currentInstant,
        }),
        claims: reservations.selectPendingPassDayCapacity({
          first: date,
          last: date,
        }),
        pendingTargets: reservations.selectLocalTableCapacity({
          first: date,
          last: date,
        }),
      });
    const table = tables.find(({ id }) => id === move.targetTableId);
    if (
      table?.enabled !== true ||
      table.display !== true ||
      !isWorkspaceCoworkTableCandidate(new Set(table.tags), {
        entryTier: "open-space",
      })
    )
      return false;
    const capacity = decodeTableSeatCapacity(table);
    if (Result.isFailure(capacity)) return false;

    const ignored = new Set([...expired, move.targetReservationId]);
    const observed = records.filter(({ id }) => !ignored.has(id));
    const startsAndEnds: Array<{ time: bigint; seats: number }> = [];
    const first = move.startsAt.epochNanoseconds;
    const last = move.endsAt.epochNanoseconds;
    const addOccupancy = (startsAt: bigint, endsAt: bigint, seats: number) => {
      if (startsAt < last && endsAt > first) {
        startsAndEnds.push(
          { time: startsAt < first ? first : startsAt, seats },
          { time: endsAt > last ? last : endsAt, seats: -seats }
        );
      }
    };
    const inventory = getCapacityInventory(observed, {
      passDayIntents: claims,
      localTableClaims: pendingTargets.filter(
        ({ generation }) => generation !== move.generation
      ),
    });
    if (
      inventory.exclusiveBookings.some(
        (booking) =>
          booking.tableId === move.targetTableId &&
          booking.startsAt < window.endsAt &&
          booking.endsAt > window.startsAt
      )
    )
      return false;
    for (const record of inventory.records) {
      if (record._tableId !== move.targetTableId) continue;
      const { interval, seats } = decodeBookedReservation(record);
      if (Option.isNone(interval)) return false;
      addOccupancy(
        interval.value.startsAt.epochNanoseconds,
        interval.value.endsAt.epochNanoseconds,
        Option.getOrElse(seats, () => workspaceBookingSeatCount)
      );
    }
    for (const booked of inventory.unobservedBookings) {
      if (booked.tableId === move.targetTableId)
        addOccupancy(
          BigInt(booked.startsAt) * 1_000_000n,
          BigInt(booked.endsAt) * 1_000_000n,
          booked.seats
        );
    }
    startsAndEnds.sort((a, b) => {
      if (a.time === b.time) return a.seats - b.seats;
      return a.time < b.time ? -1 : 1;
    });
    let occupied = workspaceBookingSeatCount;
    return (
      startsAndEnds.every(({ seats }) => {
        occupied += seats;
        return occupied <= capacity.success;
      }) && workspaceBookingSeatCount <= capacity.success
    );
  });

  const attach = Effect.fnUntraced(function* (
    move: Move,
    source: DotyposReservation,
    targetReservationId: DotyposReservationId
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const [row] = yield* readLocal(move).for("no key update");
        if (
          !row ||
          (yield* eligibleSource(move, row, source)) !== move.sourceNoteLine
        )
          return false;
        const now = yield* currentInstant;
        yield* db
          .update(workspaceReservations)
          .set({
            dotyposReservationId: targetReservationId,
            updatedAt: now,
            ...(row.passId && {
              passDayTableId: move.targetTableId,
              passDayHoldGeneration: move.generation,
              passDayHoldRequestedAt: move.attemptedAt,
            }),
          })
          .where(eq(workspaceReservations.id, row.id));
        yield* updateMove(move, { attachedAt: now });
        return true;
      })
    );
  });

  const bindTarget = Effect.fnUntraced(function* (move: Move) {
    const target = yield* findTarget(move);
    if (!target) return undefined;
    if (
      target.id === move.sourceReservationId ||
      !matchesHold(target, move, move.targetTableId, moveMarker(move))
    ) {
      yield* ambiguous(move);
      return undefined;
    }
    yield* updateMove(move, { targetReservationId: target.id });
    const bound = { ...move, targetReservationId: target.id };
    if (target.status === "CANCELLED") {
      yield* settle(bound);
      return undefined;
    }
    return { bound, target };
  });

  const continueMove = Effect.fnUntraced(function* (move: Move) {
    const replacement = yield* bindTarget(move);
    if (!replacement) return false;
    const { target, bound } = replacement;
    const [row] = yield* readLocal(move);
    const source = yield* readHold(move.sourceReservationId);
    if (
      !row ||
      !source ||
      !matchesHold(source, move, move.sourceTableId, move.sourceNoteLine) ||
      (yield* eligibleSource(move, row, source)) !== move.sourceNoteLine ||
      !(yield* hasTargetCapacity(bound))
    ) {
      yield* retireTarget(bound);
      return false;
    }

    if (move.status === "CONFIRMED" && target.status === "NEW") {
      yield* dotypos.setReservationStatusIfMatches({
        reservationId: target.id,
        expectedBooking: booking(move, move.targetTableId),
        expectedNoteLine: moveMarker(move),
        expectedCurrentStatus: "NEW",
        status: "CONFIRMED",
      });
    }
    const verified = yield* readHold(target.id);
    if (
      !verified ||
      verified.status !== move.status ||
      !matchesHold(verified, bound, move.targetTableId, moveMarker(move))
    ) {
      if (verified && verified.status !== "NEW") yield* ambiguous(bound);
      return false;
    }
    const freshSource = yield* readHold(move.sourceReservationId);
    if (
      !freshSource ||
      !matchesHold(
        freshSource,
        move,
        move.sourceTableId,
        move.sourceNoteLine
      ) ||
      !(yield* attach(bound, freshSource, target.id))
    ) {
      yield* retireTarget(bound);
      return false;
    }
    return yield* retireSource(bound);
  });

  const reconcileMove = Effect.fnUntraced(function* (move: Move) {
    if (move.attachedAt) {
      yield* retireSource(move);
      return;
    }
    // Checkout has ended. Its original hold still owns the booking until
    // attachment, so reconciliation only retires the staged replacement.
    const replacement = yield* bindTarget(move);
    if (replacement) yield* retireTarget(replacement.bound);
  });

  const startMove = Effect.fnUntraced(function* (move: Move) {
    const [row] = yield* readLocal(move);
    const source = yield* readHold(move.sourceReservationId);
    if (
      !row ||
      !source ||
      !matchesHold(source, move, move.sourceTableId, move.sourceNoteLine) ||
      (yield* eligibleSource(move, row, source)) !== move.sourceNoteLine ||
      !(yield* hasTargetCapacity(move))
    ) {
      yield* settle(move);
      return false;
    }

    const lines = withoutOpenSpaceMoveMarkers(source.note);
    const passId = row.passId;
    const targetNote = passId
      ? lines.map((line) =>
          line === move.sourceNoteLine
            ? formatPassDayMarker(
                passId,
                Temporal.PlainDate.from(move.serviceDate),
                move.generation
              )
            : line
        )
      : lines;

    const attemptedAt = yield* currentInstant;
    const attempted = { ...move, attemptedAt };
    const created = yield* Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        yield* updateMove(move, { attemptedAt, checkedAt: attemptedAt });
        const record = yield* restore(
          dotypos.createReservation({
            ...booking(move, move.targetTableId),
            status: "NEW",
            note: [...targetNote, moveMarker(move)].join("\n"),
            singleAttempt: true,
          })
        ).pipe(
          Effect.tapError((error) => {
            if (error._tag !== "DotyposUncertain") return settle(move);
            return error.createdReservationIds
              ? ambiguous(move, error.createdReservationIds)
              : Effect.void;
          })
        );
        if (record.id === move.sourceReservationId) {
          yield* ambiguous(move);
          return undefined;
        }
        yield* updateMove(move, { targetReservationId: record.id });
        return record;
      })
    );
    return created
      ? yield* continueMove({ ...attempted, targetReservationId: created.id })
      : false;
  });

  const abandonUnstarted = (batchId: string) =>
    Effect.flatMap(currentInstant, (settledAt) =>
      db
        .update(openSpaceTableMoves)
        .set({ settledAt })
        .where(
          and(
            eq(openSpaceTableMoves.batchId, batchId),
            isNull(openSpaceTableMoves.attemptedAt),
            isNull(openSpaceTableMoves.settledAt)
          )
        )
    );

  /** Execute a freshly validated plan under its source and capacity locks. */
  const repackInCapacitySection = Effect.fn(
    "OpenSpaceTableMoves.repackInCapacitySection"
  )(function* (input: RepackRequest) {
    if (input.moves.length === 0) return true;
    const { first, last } = getReservationDateBounds(input.interval);
    const batch = {
      id: crypto.randomUUID(),
      firstDate: plainDateStringSchema.make(first.toString()),
      lastDate: plainDateStringSchema.make(last.toString()),
      requestedAt: yield* currentInstant,
    };
    const window = getOccupancyWindow(input.interval);
    const moves = yield* Effect.forEach(input.moves, (move) =>
      makeMove(batch, input.tableId, window, move)
    );
    if (moves.some((move) => move === undefined)) return false;
    const ready = moves.filter((move) => move !== undefined);
    if (
      new Set(ready.map(({ reservationId }) => reservationId)).size !==
        ready.length ||
      new Set(ready.map(({ sourceReservationId }) => sourceReservationId))
        .size !== ready.length
    )
      return false;
    const journaled = yield* transaction(
      Effect.gen(function* () {
        yield* db.insert(openSpaceTableMoveBatches).values(batch);
        return yield* db
          .insert(openSpaceTableMoves)
          .values(ready)
          .onConflictDoNothing()
          .returning({ generation: openSpaceTableMoves.generation });
      })
    );
    if (journaled.length !== ready.length) {
      yield* abandonUnstarted(batch.id);
      return false;
    }

    return yield* Effect.gen(function* () {
      for (const move of ready) {
        if (!(yield* withPassOrder(move, startMove(move)))) return false;
      }
      return true;
    }).pipe(
      Effect.ensuring(
        abandonUnstarted(batch.id).pipe(
          Effect.catch(() =>
            Effect.logWarning("Open Space move batch needs reconciliation")
          )
        )
      )
    );
  });

  /**
   * Enter before the account and capacity sections. The caller supplies
   * the author if booking under its account lock. Plan validation and
   * final assignment both run under the source, account, and date locks.
   */
  const repack = <A, E, R, CheckError = never, CheckServices = never>(
    input: RepackRequest,
    assign: Effect.Effect<A, E, R>,
    validatePlan: Effect.Effect<
      boolean,
      CheckError,
      CheckServices
    > = Effect.succeed(true)
  ) =>
    Effect.gen(function* () {
      const { first, last } = getReservationDateBounds(input.interval);
      const work = Effect.gen(function* () {
        if (!(yield* validatePlan) || !(yield* repackInCapacitySection(input)))
          return Option.none<A>();
        return Option.some(yield* assign);
      });
      return yield* WorkspaceLockSections.reservationCapacity(
        [
          ...getPlainDatesBetween(first, last),
          ...input.moves.map(({ serviceDate }) =>
            Temporal.PlainDate.from(serviceDate)
          ),
        ],
        {
          movedReservations: input.moves.map(
            ({ reservationId }) => reservationId
          ),
          ...(input.authorAccountId && {
            authorAccountId: input.authorAccountId,
          }),
        }
      )(work).pipe(
        Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock)
      );
    });

  const reconcile = Effect.fn("OpenSpaceTableMoves.reconcile")(function* (
    limit: number
  ) {
    const batches = yield* db
      .select({
        batch: openSpaceTableMoveBatches,
        checkedAt: openSpaceTableMoves.checkedAt,
      })
      .from(openSpaceTableMoves)
      .innerJoin(
        openSpaceTableMoveBatches,
        eq(openSpaceTableMoveBatches.id, openSpaceTableMoves.batchId)
      )
      .where(
        and(
          isNull(openSpaceTableMoves.settledAt),
          isNull(openSpaceTableMoves.ambiguousAt)
        )
      )
      .orderBy(
        asc(openSpaceTableMoves.checkedAt),
        asc(openSpaceTableMoveBatches.id)
      )
      .limit(limit);
    const uniqueBatches = new Map(
      batches.map(({ batch }) => [batch.id, batch])
    );
    for (const batch of uniqueBatches.values()) {
      const rows = yield* db
        .select()
        .from(openSpaceTableMoves)
        .where(eq(openSpaceTableMoves.batchId, batch.id));
      const work = Effect.gen(function* () {
        yield* abandonUnstarted(batch.id);
        const moves = yield* db
          .select()
          .from(openSpaceTableMoves)
          .where(
            and(
              eq(openSpaceTableMoves.batchId, batch.id),
              isNull(openSpaceTableMoves.settledAt),
              isNull(openSpaceTableMoves.ambiguousAt)
            )
          );
        for (const move of moves) {
          yield* Effect.gen(function* () {
            yield* updateMove(move, { checkedAt: yield* currentInstant });
            yield* withPassOrder(move, reconcileMove(move));
          }).pipe(
            Effect.catch(() =>
              Effect.logWarning("Open Space move needs reconciliation")
            )
          );
        }
      });
      yield* WorkspaceLockSections.reservationCapacity(
        datesForBatch(batch, rows),
        { movedReservations: rows.map(({ reservationId }) => reservationId) }
      )(work).pipe(
        Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock),
        Effect.timeout("30 seconds"),
        Effect.catch(() =>
          Effect.logWarning("Open Space move batch needs reconciliation")
        )
      );
    }
    return uniqueBatches.size;
  });

  return { repack, repackInCapacitySection, reconcile };
});

export class OpenSpaceTableMoves extends Context.Service<
  OpenSpaceTableMoves,
  Effect.Success<typeof makeOpenSpaceTableMoves>
>()("OpenSpaceTableMoves") {
  static Default = Layer.effect(this, makeOpenSpaceTableMoves);
}
