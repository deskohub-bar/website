import {
  type DotyposReservation,
  type DotyposReservationId,
  DotyposService,
  type DotyposTableId,
} from "@deskohub/dotypos";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { Context, Effect, Layer, Option, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { teamTableHoldClaims, workspaceReservations } from "@/db/schema";
import {
  formatPaymentOrderLine,
  noteNamesPaymentOrder,
} from "@/features/checkout/backend/reservation/order-reservation-note";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { TableReservationDetails } from "@/features/reservation/table-reservation";
import { currentInstant, temporalInstantToDate } from "@/shared/utils/temporal";

export type TeamTableHoldClaim = typeof teamTableHoldClaims.$inferSelect;
type HoldClaim = TeamTableHoldClaim;
type ClaimKey = Pick<HoldClaim, "reservationId" | "generation">;
type TeamTableClaimOwner =
  | { readonly purpose: "checkout" }
  | {
      readonly purpose: "payment_retry";
      readonly paymentAttemptId: PaymentAttemptId;
      readonly retryExpiresAt: Temporal.Instant;
    }
  | {
      readonly purpose: "late_payment";
      readonly paymentAttemptId: PaymentAttemptId;
    };

/** Older unattached retry claims without a deadline are due for verification. */
export const isExpiredUnattachedPaymentRetry = (
  claim: HoldClaim,
  now: Temporal.Instant
) =>
  claim.purpose === "payment_retry" &&
  claim.attachedAt === null &&
  claim.retiredAt === null &&
  (claim.retryExpiresAt === null ||
    Temporal.Instant.compare(claim.retryExpiresAt, now) <= 0);

const marker = (generation: string) => `Team Table hold: ${generation}`;

const claimNote = (claim: ClaimKey) =>
  claim.generation
    ? marker(claim.generation)
    : formatPaymentOrderLine(claim.reservationId);

const matchesClaimNote = (note: string | undefined | null, claim: ClaimKey) =>
  noteNamesPaymentOrder(note, claim.reservationId) &&
  (!claim.generation ||
    note?.split("\n").includes(marker(claim.generation)) === true);

const claimKey = (claim: ClaimKey) =>
  and(
    eq(teamTableHoldClaims.reservationId, claim.reservationId),
    claim.generation
      ? eq(teamTableHoldClaims.generation, claim.generation)
      : isNull(teamTableHoldClaims.generation)
  );

const matchesTeamTableBooking = (
  record: DotyposReservation,
  expected: Pick<
    HoldClaim,
    "reservationId" | "tableId" | "seats" | "startsAt" | "endsAt" | "generation"
  >,
  customerId: DotyposCustomerId
) => {
  const { interval, seats } = decodeBookedReservation(record);
  return (
    record._customerId === customerId &&
    record._tableId === expected.tableId &&
    matchesClaimNote(record.note, expected) &&
    Option.contains(seats, expected.seats) &&
    Option.exists(
      interval,
      ({ startsAt, endsAt }) =>
        startsAt.equals(expected.startsAt) && endsAt.equals(expected.endsAt)
    )
  );
};

export const expiredTeamTableCreationCode = "team_table_creation_expired";

const getTeamTableHoldClaim = (
  reservationId: WorkspaceReservationId,
  tableId: DotyposTableId,
  { startsAt, endsAt, seats }: TableReservationDetails,
  owner: TeamTableClaimOwner
) => ({
  ...owner,
  generation: crypto.randomUUID(),
  reservationId,
  tableId,
  startsAt: Temporal.Instant.from(startsAt),
  endsAt: Temporal.Instant.from(endsAt),
  seats,
});

const makeTeamTableHoldClaims = Effect.gen(function* () {
  const { db, transaction } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;

  const find = (id: WorkspaceReservationId) =>
    db
      .select()
      .from(teamTableHoldClaims)
      .where(eq(teamTableHoldClaims.reservationId, id))
      .pipe(Effect.map(([claim]) => claim));

  const start = (claim: ReturnType<typeof getTeamTableHoldClaim>) =>
    db
      .insert(teamTableHoldClaims)
      .values(claim)
      .onConflictDoNothing()
      .returning({
        id: teamTableHoldClaims.reservationId,
      })
      .pipe(Effect.map((inserted) => inserted.length === 1));

  const remember = (
    claim: ClaimKey,
    providerIds: readonly DotyposReservationId[]
  ) =>
    db
      .update(teamTableHoldClaims)
      .set({
        providerReservationIds: [...new Set(providerIds)],
      })
      .where(claimKey(claim));

  const clear = (claim: ClaimKey) =>
    db.delete(teamTableHoldClaims).where(claimKey(claim));

  const retire = (claim: ClaimKey, now: Temporal.Instant) =>
    db
      .update(teamTableHoldClaims)
      .set({
        retiredAt: now,
        cancelRequestedAt: null,
      })
      .where(claimKey(claim));

  const attached = (
    claim: ClaimKey,
    providerId: DotyposReservationId,
    now: Temporal.Instant
  ) =>
    db
      .update(teamTableHoldClaims)
      .set({
        providerReservationIds: [providerId],
        attachedAt: now,
        cancelRequestedAt: null,
      })
      .where(claimKey(claim));

  /**
   * Find one active hold uniquely linked to the order and matching its entire
   * claim. An incomplete reply can hide a provider write, so absence preserves
   * the local claim and does not authorize another POST.
   */
  const inspect = Effect.fn("TeamTableHoldClaims.inspect")(function* (
    claim: HoldClaim,
    customerId: DotyposCustomerId
  ) {
    if ((claim.providerReservationIds?.length ?? 0) > 1)
      return { kind: "unresolved" } as const;
    const records = yield* dotypos.listActiveReservationsOverlapping({
      startDate: temporalInstantToDate(claim.startsAt),
      endDate: temporalInstantToDate(claim.endsAt),
    });
    const observedIds = records
      .filter(({ note }) => matchesClaimNote(note, claim))
      .map(({ id: providerId }) => providerId);
    const ids = new Set([
      ...(claim.providerReservationIds ?? []),
      ...observedIds,
    ]);
    if (ids.size !== 1) return { kind: "unresolved" } as const;
    const providerId = ids.values().next().value;
    if (!providerId) return { kind: "unresolved" } as const;
    const record = yield* dotypos
      .getReservationWithoutCustomer(providerId)
      .pipe(
        Effect.catchTag("DotyposRejected", (error) =>
          error.reason === "not-found"
            ? Effect.succeed(undefined)
            : Effect.fail(error)
        )
      );
    if (!record) return { kind: "absent" } as const;
    if (!matchesTeamTableBooking(record, claim, customerId))
      return { kind: "unresolved" } as const;
    if (record.status === "CANCELLED")
      return { kind: "cancelled", record } as const;
    if (record.status === "NEW" || record.status === "CONFIRMED")
      return { kind: "active", record } as const;
    return { kind: "unresolved" } as const;
  });

  const cancel = Effect.fn("TeamTableHoldClaims.cancel")(function* (
    claim: HoldClaim,
    customerId: DotyposCustomerId,
    record: DotyposReservation
  ) {
    if (
      (record.status !== "NEW" && record.status !== "CONFIRMED") ||
      !matchesTeamTableBooking(record, claim, customerId)
    )
      return false;
    yield* dotypos.setReservationStatusIfMatches({
      reservationId: record.id,
      expectedBooking: {
        customerId,
        tableId: claim.tableId,
        seats: claim.seats,
        startDate: temporalInstantToDate(claim.startsAt),
        endDate: temporalInstantToDate(claim.endsAt),
      },
      expectedNoteLine: claimNote(claim),
      expectedCurrentStatus: record.status,
      status: "CANCELLED",
    });
    return true;
  });

  const requestCancellation = (claim: ClaimKey, now: Temporal.Instant) =>
    db
      .update(teamTableHoldClaims)
      .set({ cancelRequestedAt: now })
      .where(claimKey(claim));

  const compensateReplacement = Effect.fn(
    "TeamTableHoldClaims.compensateReplacement"
  )(function* (
    claim: HoldClaim,
    customerId: DotyposCustomerId,
    record: DotyposReservation,
    now: Temporal.Instant
  ) {
    yield* requestCancellation(claim, now);
    if (!(yield* cancel(claim, customerId, record))) return false;
    yield* retire(claim, now);
    return true;
  });

  const expireCheckout = (
    id: WorkspaceReservationId,
    now: Temporal.Instant,
    cancelledId?: DotyposReservationId
  ) =>
    db
      .update(workspaceReservations)
      .set({
        reservationState: cancelledId ? "cancelled" : "hold_expired",
        ...(cancelledId && {
          dotyposReservationId: cancelledId,
          reservationCancelledAt: now,
          cancellationCause: "hold_expired" as const,
        }),
        failureCode: expiredTeamTableCreationCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceReservations.id, id),
          or(
            and(
              inArray(workspaceReservations.reservationState, [
                "creating_hold",
                "hold_expired",
              ]),
              isNull(workspaceReservations.dotyposReservationId)
            ),
            cancelledId &&
              and(
                eq(
                  workspaceReservations.reservationState,
                  "cancellation_failed"
                ),
                eq(workspaceReservations.dotyposReservationId, cancelledId)
              )
          )
        )
      );

  const finishCheckout = (
    claim: ClaimKey,
    now: Temporal.Instant,
    cancelledId?: DotyposReservationId
  ) =>
    transaction(
      expireCheckout(claim.reservationId, now, cancelledId).pipe(
        Effect.andThen(clear(claim))
      )
    );

  const create = <AssignError>(input: {
    readonly reservationId: WorkspaceReservationId;
    readonly customerId: DotyposCustomerId;
    readonly reservation: TableReservationDetails;
    readonly owner: TeamTableClaimOwner;
    readonly releasedReservationId?: DotyposReservationId;
    readonly assign: Effect.Effect<DotyposTableId, AssignError>;
    readonly note: string;
  }) =>
    Effect.gen(function* () {
      const status =
        input.owner.purpose === "late_payment" ? "CONFIRMED" : "NEW";
      const existing = yield* find(input.reservationId);
      if (existing) {
        const ownerMatches =
          existing.purpose === input.owner.purpose &&
          existing.paymentAttemptId ===
            ("paymentAttemptId" in input.owner
              ? input.owner.paymentAttemptId
              : null);
        if (ownerMatches && existing.retiredAt)
          return { kind: "released", claim: existing } as const;
        if (ownerMatches && !existing.cancelRequestedAt) {
          if (
            existing.purpose === "payment_retry" &&
            isExpiredUnattachedPaymentRetry(existing, yield* currentInstant)
          )
            return { kind: "pending" } as const;
          const receipt = yield* inspect(existing, input.customerId);
          if (receipt.kind === "active" && receipt.record.status === status) {
            yield* remember(existing, [receipt.record.id]);
            return {
              kind: "active",
              claim: existing,
              record: receipt.record,
              resumed: true,
            } as const;
          }
          if (receipt.kind === "absent" || receipt.kind === "cancelled") {
            if (existing.purpose !== "checkout")
              yield* retire(existing, Temporal.Now.instant());
            return { kind: "released", claim: existing } as const;
          }
          return { kind: "pending" } as const;
        }
        // A replacement starts only after the caller confirmed retirement of
        // the last attached provider reservation under the same order lock.
        if (
          !existing.retiredAt &&
          (!input.releasedReservationId ||
            existing.cancelRequestedAt ||
            !(existing.attachedAt || !existing.generation) ||
            !existing.providerReservationIds?.includes(
              input.releasedReservationId
            ))
        )
          return { kind: "pending" } as const;
        yield* clear(existing);
      }
      const tableId = yield* input.assign;
      if (
        input.owner.purpose === "payment_retry" &&
        Temporal.Instant.compare(
          input.owner.retryExpiresAt,
          yield* currentInstant
        ) <= 0
      )
        return { kind: "pending" } as const;
      const claim = getTeamTableHoldClaim(
        input.reservationId,
        tableId,
        input.reservation,
        input.owner
      );
      if (!(yield* start(claim))) return { kind: "pending" } as const;
      const posted = yield* Effect.result(
        dotypos.createReservation({
          customerId: input.customerId,
          tableId,
          startDate: temporalInstantToDate(claim.startsAt),
          endDate: temporalInstantToDate(claim.endsAt),
          seats: claim.seats,
          status,
          singleAttempt: true,
          note: `${input.note}\n${marker(claim.generation)}`,
        })
      );
      const staged = yield* find(input.reservationId);
      if (!staged || staged.generation !== claim.generation)
        return { kind: "pending" } as const;
      if (Result.isFailure(posted)) {
        // The provider adapters classify a potentially applied write separately.
        // Keep a claim on unknown application errors too.
        if (posted.failure._tag !== "DotyposUncertain") yield* clear(staged);
        else if (posted.failure.createdReservationIds)
          yield* remember(staged, posted.failure.createdReservationIds);
        return yield* posted.failure;
      }
      yield* remember(staged, [posted.success.id]);
      if (
        posted.success.status === status &&
        matchesTeamTableBooking(posted.success, staged, input.customerId)
      )
        return {
          kind: "active",
          claim: staged,
          record: posted.success,
          resumed: false,
        } as const;
      const receipt = yield* inspect(
        { ...staged, providerReservationIds: [posted.success.id] },
        input.customerId
      );
      return receipt.kind === "active" && receipt.record.status === status
        ? ({
            kind: "active",
            claim: staged,
            record: receipt.record,
            resumed: false,
          } as const)
        : ({ kind: "pending" } as const);
    });

  return {
    find,
    remember,
    attached,
    clear,
    retire,
    inspect,
    cancel,
    requestCancellation,
    compensateReplacement,
    expireCheckout,
    finishCheckout,
    create,
  };
});

export class TeamTableHoldClaims extends Context.Service<
  TeamTableHoldClaims,
  Effect.Success<typeof makeTeamTableHoldClaims>
>()("TeamTableHoldClaims") {
  static Default = Layer.effect(this, makeTeamTableHoldClaims);
}
