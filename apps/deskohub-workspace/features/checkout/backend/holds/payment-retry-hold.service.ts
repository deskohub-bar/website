import "@/shared/polyfills/temporal";

import { DotyposService } from "@deskohub/dotypos";
import { Context, Effect, Layer, Option, Predicate, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import {
  CoworkPassesReleaseGate,
  CoworkPassesReleaseGateForRun,
} from "@/features/passes/backend/cowork-passes-release-gate";
import { enqueueReservationHoldCleanup } from "@/features/reservation/backend/reservation-holds.service";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import {
  retryReacquirableCancellationCauses,
  type WorkspaceReservation,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { getReservationHoldExpiresAt } from "@/features/reservation/reservation-hold-deadline";
import { hasReservationIntervalEnded } from "@/features/reservation/reservation-interval";
import { OpenSpaceTableMoves } from "@/features/team-table/backend/open-space-table-moves";
import {
  readDisplacedTeamTableHold,
  type TeamTableBookingCapacity,
  TeamTableBookingCapacityLive,
  type TeamTablePaymentCapacity,
  withTeamTablePaymentCapacity,
} from "@/features/team-table/backend/team-table-booking-capacity";
import { TeamTableHoldClaims } from "@/features/team-table/backend/team-table-hold-claims";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { VercelQueuePublisher } from "@/shared/backend/queue/vercel-queue-publisher";
import { currentInstant } from "@/shared/utils/temporal";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import { PaymentAttemptRepository } from "../repositories/payment-attempt.repository";
import {
  formatWorkspaceReservationNote,
  withWorkspaceReservationCapacity,
} from "../reservation/dotypos-reservation.adapter";
import {
  findOrderDotyposReservations,
  type RecreatedReservation,
  resumeOrCreateOrderDotyposReservation,
} from "../reservation/order-dotypos-reservation";
import {
  getWorkspaceReservationInterval,
  WorkspaceTableAssignmentService,
} from "../reservation/workspace-table-assignment.service";
import { ReservationHoldCleanupScheduleService } from "./reservation-hold-cleanup-queue.service";
import {
  HoldCancellationInProgress,
  UnpaidHoldRelease,
} from "./unpaid-hold-release.service";

/**
 * How long a hold a retry keeps must still last: one about to expire is
 * released and booked again instead, so the retry's payment doesn't start on
 * a hold that lapses under it.
 */
const keptHoldMinimumRemaining = Temporal.Duration.from({ minutes: 1 });

/**
 * Why the order's hold can't be secured for its payment retry:
 * - `not_retryable`: the order isn't an unpaid order whose retried attempt
 *   ended, its reservation has ended, a late payment is being recovered for
 *   it, or its cancellation wasn't its own expired or retried hold;
 * - `release_refused`: Dotypos keeps the expired hold (it isn't NEW), so it
 *   is left for an operator;
 * - `release_in_progress`: another run is releasing the hold right now;
 * - `changed`: the order changed while the retry worked on it, or Dotypos
 *   holds more than one reservation for it.
 */
type PaymentRetryHoldRefusal =
  | "not_retryable"
  | "release_refused"
  | "release_in_progress"
  | "changed";

type PaymentRetryHold =
  /** The order's hold, kept (`kept`) or booked again (`reacquired`). */
  | {
      readonly kind: "kept" | "reacquired";
      readonly reservation: WorkspaceReservation;
    }
  /** The space or a table is no longer free for the reservation. */
  | { readonly kind: "spot_unavailable" }
  | { readonly kind: "refused"; readonly reason: PaymentRetryHoldRefusal };

type PaymentRetryHoldRequest = {
  readonly orderId: WorkspaceReservationId;
  /** The order's active attempt whose payment failed, was cancelled or expired. */
  readonly retriedAttemptId: PaymentAttemptId;
  /** The reservation exactly as its last attempt accepted it. */
  readonly recreated: RecreatedReservation;
};

const refused = (reason: PaymentRetryHoldRefusal): PaymentRetryHold => ({
  kind: "refused",
  reason,
});

const retryablePaymentStates: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Whether the order still awaits the retry of `retriedAttemptId`: its
 * payment ended unpaid on that attempt, which is its newest, and nothing
 * else is active (a retry prepared before clears it).
 */
const isRetriedOrder = (
  order: WorkspaceReservation,
  retriedAttemptId: PaymentAttemptId,
  newestAttemptId: PaymentAttemptId | undefined
) =>
  newestAttemptId === retriedAttemptId &&
  (order.activePaymentAttemptId === retriedAttemptId ||
    order.activePaymentAttemptId === null) &&
  retryablePaymentStates.has(order.paymentState);

/** Local states whose own unpaid hold a retry releases before booking again. */
const releasableHoldStates: ReadonlySet<string> = new Set([
  "held",
  "hold_expired",
  "cancellation_failed",
]);

const isReacquirable = (order: WorkspaceReservation) =>
  order.reservationState === "cancelled" &&
  retryReacquirableCancellationCauses.some(
    (cause) => cause === order.cancellationCause
  );

const keepLiveHold = Effect.fnUntraced(function* (input: {
  readonly order: WorkspaceReservation;
  readonly retriedAttemptId: PaymentAttemptId;
  readonly now: Temporal.Instant;
}) {
  const { order } = input;
  const heldUntilAfter = input.now.add(keptHoldMinimumRemaining);
  if (
    order.reservationState !== "held" ||
    !order.dotyposReservationId ||
    !order.reservationHoldExpiresAt ||
    Temporal.Instant.compare(order.reservationHoldExpiresAt, heldUntilAfter) <=
      0
  ) {
    return undefined;
  }
  const dotypos = yield* DotyposService;
  const status = yield* dotypos.getReservationStatus(
    order.dotyposReservationId
  );
  if (status !== "NEW") return undefined;
  const reservations = yield* WorkspaceReservationRepository;
  const kept = yield* reservations
    .releaseRetriedAttempt({
      id: order.id,
      retriedAttemptId: input.retriedAttemptId,
      heldUntilAfter,
    })
    .pipe(
      Effect.catchTag("EntryPackUnavailableError", () =>
        Effect.succeed("entry_pack_unavailable" as const)
      )
    );
  if (kept === "entry_pack_unavailable")
    return { kind: "spot_unavailable" } as const;
  return kept
    ? ({ kind: "kept", reservation: kept } satisfies PaymentRetryHold)
    : refused("changed");
});

/** Releases the order's own expired hold; a refusal when it can't. */
const releaseOwnHold = Effect.fnUntraced(function* (
  order: WorkspaceReservation
) {
  if (!releasableHoldStates.has(order.reservationState)) return undefined;
  if (!order.dotyposReservationId || !order.reservationHoldExpiresAt) {
    return refused("not_retryable");
  }
  const holdRelease = yield* UnpaidHoldRelease;
  const outcome = yield* holdRelease.release({
    reason: "payment_retry",
    reservationId: order.id,
    expectedHold: {
      dotyposReservationId: order.dotyposReservationId,
      reservationHoldExpiresAt: order.reservationHoldExpiresAt,
    },
  });
  if (Predicate.isString(outcome)) {
    return outcome === "already_released" ? undefined : refused("changed");
  }
  if (outcome instanceof HoldCancellationInProgress) {
    return refused("release_in_progress");
  }
  if ("refused" in outcome) return refused("release_refused");
  return undefined;
});

const bookAgain = Effect.fnUntraced(function* (input: {
  readonly order: WorkspaceReservation;
  readonly request: PaymentRetryHoldRequest;
  readonly now: Temporal.Instant;
  readonly teamCapacity?: TeamTablePaymentCapacity;
}) {
  const { order, request } = input;
  const interval = yield* getWorkspaceReservationInterval(
    request.recreated.reservation
  );
  if (hasReservationIntervalEnded(interval, input.now)) {
    return refused("not_retryable");
  }
  const proposedHoldExpiresAt = getReservationHoldExpiresAt(input.now);
  const book = Effect.fnUntraced(function* (
    capacity?: TeamTableBookingCapacity
  ) {
    if (hasReservationIntervalEnded(interval, yield* currentInstant)) {
      return refused("not_retryable");
    }

    const reservation = request.recreated.reservation;
    const claims = yield* Effect.serviceOption(TeamTableHoldClaims);
    const team = yield* Effect.gen(function* () {
      if (reservation.kind !== "table" || !capacity || Option.isNone(claims))
        return undefined;
      return yield* claims.value.create({
        reservationId: order.id,
        customerId: order.dotyposCustomerId,
        reservation,
        owner: {
          purpose: "payment_retry",
          paymentAttemptId: request.retriedAttemptId,
          retryExpiresAt: proposedHoldExpiresAt,
        },
        releasedReservationId: order.dotyposReservationId ?? undefined,
        assign: capacity.assignTableId,
        note: formatWorkspaceReservationNote({
          paymentOrderId: order.id,
          checkoutDetails: request.recreated.checkoutDetails,
          reservation,
        }),
      });
    });
    if (reservation.kind === "table" && (!team || team.kind === "pending"))
      return refused("release_in_progress");

    const settled = yield* Effect.gen(function* () {
      if (team?.kind === "released") return null;
      if (team?.kind === "active")
        return { id: team.record.id, resumed: team.resumed };
      // Only a NEW reservation an interrupted retry created is taken over.
      const found = yield* findOrderDotyposReservations({
        orderId: order.id,
        interval,
      });
      if (found.length > 1 || found.some(({ status }) => status !== "NEW"))
        return "changed" as const;
      return yield* resumeOrCreateOrderDotyposReservation({
        order,
        recreated: request.recreated,
        found,
        status: "NEW",
      });
    });
    if (settled === "changed") return refused("changed");
    if (!settled) return { kind: "spot_unavailable" } as const;

    const compensate = () =>
      team?.kind === "active" && Option.isSome(claims)
        ? claims.value.compensateReplacement(
            team.claim,
            order.dotyposCustomerId,
            team.record,
            input.now
          )
        : Effect.succeed(false);
    const reservationHoldExpiresAt =
      (team?.kind === "active" ? team.claim.retryExpiresAt : null) ??
      proposedHoldExpiresAt;
    if (
      team?.kind === "active" &&
      Temporal.Instant.compare(
        reservationHoldExpiresAt,
        yield* currentInstant
      ) <= 0
    ) {
      yield* compensate();
      return { kind: "spot_unavailable" } as const;
    }

    const reservations = yield* WorkspaceReservationRepository;
    const attachResult = yield* reservations
      .attachRetryHold({
        id: order.id,
        retriedAttemptId: request.retriedAttemptId,
        dotyposReservationId: settled.id,
        reservationHoldExpiresAt,
      })
      .pipe(
        Effect.catchTags({
          EntryPackUnavailableError: () =>
            Effect.succeed("entry_pack_unavailable" as const),
          WorkspaceReservationSessionTakenError: () =>
            Effect.succeed("session_taken" as const),
        }),
        Effect.result
      );
    if (Result.isFailure(attachResult)) {
      if (team?.kind === "active" && Option.isSome(claims)) {
        const persisted = yield* reservations.findById(order.id);
        if (
          persisted?.dotyposReservationId === settled.id &&
          persisted.reservationState === "held"
        ) {
          yield* claims.value.attached(team.claim, settled.id, input.now);
          return {
            kind: "reacquired",
            reservation: persisted,
          } satisfies PaymentRetryHold;
        }
        yield* compensate();
      }
      return yield* attachResult.failure;
    }
    const attached = attachResult.success;
    if (
      !attached ||
      attached === "entry_pack_unavailable" ||
      attached === "session_taken"
    ) {
      // The order lock gives this run ownership of an earlier NEW hold when
      // the Entry pack can no longer attach it. Other races retain the
      // existing behavior for resumed holds.
      if (team?.kind === "active") {
        yield* compensate();
      } else if (!settled.resumed || attached) {
        const dotypos = yield* DotyposService;
        yield* dotypos.cancelReservation(settled.id);
      }
      return attached === "entry_pack_unavailable"
        ? ({ kind: "spot_unavailable" } as const)
        : refused("changed");
    }
    if (team?.kind === "active" && Option.isSome(claims))
      yield* claims.value.attached(team.claim, settled.id, input.now);
    return {
      kind: "reacquired",
      reservation: attached,
    } satisfies PaymentRetryHold;
  });
  const result = yield* input.teamCapacity
    ? input.teamCapacity.withCapacity(book)
    : withWorkspaceReservationCapacity(interval, book());
  if (
    result.kind === "reacquired" &&
    result.reservation.reservationHoldExpiresAt
  ) {
    // The periodic recovery finds an expired hold if its job was not scheduled.
    yield* enqueueReservationHoldCleanup({
      orderId: order.id,
      reservationHoldExpiresAt: result.reservation.reservationHoldExpiresAt,
    });
  }
  return result;
});

const secureOrder = Effect.fnUntraced(function* (
  request: PaymentRetryHoldRequest,
  teamCapacity?: TeamTablePaymentCapacity
) {
  const reservations = yield* WorkspaceReservationRepository;
  const recoveries = yield* LatePaymentRecoveryRepository;
  const attempts = yield* PaymentAttemptRepository;
  const now = yield* currentInstant;
  const order = yield* reservations.findById(request.orderId);
  const newestAttemptId = (yield* attempts.findNewestForReservation(
    request.orderId
  ))?.id;
  if (
    !order ||
    !isRetriedOrder(order, request.retriedAttemptId, newestAttemptId)
  ) {
    return refused("not_retryable");
  }
  const recovery = yield* recoveries.findLatestByWorkspaceReservationId(
    order.id
  );
  if (recovery) return refused("not_retryable");

  const entryClaim = yield* reservations.findEntryPackClaim(order.id);
  if (entryClaim && !(yield* CoworkPassesReleaseGate.isOpen)) {
    return { kind: "spot_unavailable" } as const;
  }

  const kept = yield* keepLiveHold({
    order,
    retriedAttemptId: request.retriedAttemptId,
    now,
  });
  if (kept) return kept;
  if (yield* reservations.hasAttachedOpenSpaceMove(order.id)) {
    return refused("release_in_progress");
  }

  const releaseRefusal = yield* releaseOwnHold(order);
  if (releaseRefusal) return releaseRefusal;

  const released = yield* reservations.findById(order.id);
  if (
    !released ||
    !isRetriedOrder(released, request.retriedAttemptId, newestAttemptId) ||
    !isReacquirable(released)
  ) {
    return refused("not_retryable");
  }
  return yield* bookAgain({ order: released, request, now, teamCapacity });
});

const secure = Effect.fn("PaymentRetryHoldService.secure")(
  function* (request: PaymentRetryHoldRequest) {
    const reservation = request.recreated.reservation;
    if (reservation.kind !== "table") {
      return yield* WorkspaceLockSections.reservationOrder(request.orderId)(
        secureOrder(request)
      );
    }
    const moves = yield* Effect.serviceOption(OpenSpaceTableMoves);
    if (Option.isNone(moves)) return { kind: "spot_unavailable" } as const;
    const reservations = yield* WorkspaceReservationRepository;
    return yield* withTeamTablePaymentCapacity(
      {
        reservation,
        orderId: request.orderId,
        lookupDisplacedHold: reservations
          .findById(request.orderId)
          .pipe(
            Effect.flatMap((order) =>
              !order || !releasableHoldStates.has(order.reservationState)
                ? Effect.succeed(undefined)
                : readDisplacedTeamTableHold(order)
            )
          ),
      },
      (scope) => secureOrder(request, scope)
    ).pipe(
      Effect.provideService(OpenSpaceTableMoves, moves.value),
      Effect.catchTag("WorkspaceTableUnavailableError", () =>
        Effect.succeed({ kind: "spot_unavailable" } as const)
      )
    );
  },
  (effect, request) =>
    effect.pipe(
      Effect.scoped,
      Effect.tap((result) =>
        Effect.logInfo("Payment retry hold decided", {
          kind: result.kind,
          ...(result.kind === "refused" && { reason: result.reason }),
        })
      ),
      Effect.annotateLogs({
        orderId: request.orderId,
        retriedAttemptId: request.retriedAttemptId,
      })
    )
);

/** What securing a retry's hold reads and writes. */
const retryHoldCapabilities = [
  WorkspaceReservationRepository,
  LatePaymentRecoveryRepository,
  PaymentAttemptRepository,
  UnpaidHoldRelease,
  DotyposService,
  WorkspaceAvailabilityService,
  CoworkPassesReleaseGate,
  WorkspaceTableAssignmentService,
  ReservationHoldCleanupScheduleService,
  WorkspaceDatabaseAdvisoryLock,
] as const;

type RetryHoldCapabilities =
  | WorkspaceReservationRepository
  | LatePaymentRecoveryRepository
  | PaymentAttemptRepository
  | UnpaidHoldRelease
  | DotyposService
  | WorkspaceAvailabilityService
  | CoworkPassesReleaseGate
  | WorkspaceTableAssignmentService
  | ReservationHoldCleanupScheduleService
  | WorkspaceDatabaseAdvisoryLock;

export interface IPaymentRetryHoldService {
  /**
   * Secures the hold of an order whose payment failed, was cancelled or
   * expired, for the customer to pay it again: keeps the order's live hold,
   * or releases its expired one and books the same reservation again for the
   * same order, through the ordinary availability check and table
   * assignment. Either way the retried attempt stops being the order's
   * active one, so a late payment on its page settles as a refund and never
   * touches this hold. Runs in the order's lock section; Dotypos calls run
   * outside any transaction.
   */
  readonly secure: (
    request: PaymentRetryHoldRequest
  ) => Effect.Effect<PaymentRetryHold, Effect.Error<ReturnType<typeof secure>>>;
}

export class PaymentRetryHoldService extends Context.Service<
  PaymentRetryHoldService,
  IPaymentRetryHoldService
>()("@deskohub-workspace/checkout/PaymentRetryHoldService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const context = Context.pick(...retryHoldCapabilities)(
        yield* Effect.context<RetryHoldCapabilities>()
      );
      const optional = yield* Effect.all({
        moves: Effect.serviceOption(OpenSpaceTableMoves),
        claims: Effect.serviceOption(TeamTableHoldClaims),
      });
      const provider = Option.isSome(optional.moves)
        ? Context.add(context, OpenSpaceTableMoves, optional.moves.value)
        : context;
      const services = Option.isSome(optional.claims)
        ? Context.add(provider, TeamTableHoldClaims, optional.claims.value)
        : provider;
      return PaymentRetryHoldService.of({
        secure: (request) =>
          secure(request).pipe(Effect.provideContext(services)),
      });
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(TeamTableBookingCapacityLive),
    Layer.provide(
      TeamTableHoldClaims.Default.pipe(
        Layer.provide(
          Layer.merge(WorkspaceDatabase.Default, WorkspaceDotyposLayer)
        )
      )
    ),
    Layer.provide(CoworkPassesReleaseGateForRun),
    Layer.provide(UnpaidHoldRelease.Default),
    Layer.provide(
      Layer.mergeAll(
        WorkspaceReservationRepository.Default,
        LatePaymentRecoveryRepository.Default,
        PaymentAttemptRepository.Default
      ).pipe(Layer.provide(WorkspaceDatabase.Default))
    ),
    Layer.provide(WorkspaceAvailabilityService.Live),
    Layer.provide(
      WorkspaceTableAssignmentService.Default.pipe(
        Layer.provide(WorkspaceReservationRepository.Live),
        Layer.provide(WorkspaceDotyposLayer)
      )
    ),
    Layer.provide(
      ReservationHoldCleanupScheduleService.Default.pipe(
        Layer.provide(VercelQueuePublisher)
      )
    ),
    Layer.provide(WorkspaceDatabaseAdvisoryLock.Default),
    Layer.provide(WorkspaceDotyposLayer)
  );
}
