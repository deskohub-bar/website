import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, mock, test } from "bun:test";
import {
  DotyposReservationIdSchema,
  DotyposService,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { NexiOrderIdSchema } from "@deskohub/nexi";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  latePaymentRecoveries,
  paymentAttempts,
  teamTableHoldClaims,
  workspaceReservations,
} from "@/db/schema";
import { tableAccountingDocumentSnapshotSchema } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { makeCoworkInvoiceDocument } from "@/features/accounting/invoice.test-utils";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { buildTableReservationQuote } from "@/features/checkout/reservation-quote-table";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { dotyposCreatedReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import { OpenSpaceTableMoves } from "@/features/team-table/backend/open-space-table-moves";
import { TeamTableHoldClaims } from "@/features/team-table/backend/team-table-hold-claims";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  holdPostgresTransaction,
  waitForAdvisoryLockWaiter,
} from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import { connectWorkspacePostgresTestDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { instantStringSchema } from "@/shared/utils/temporal";
import { ReservationFulfillment } from "../fulfillment/reservation-fulfillment.service";
import { UnpaidHoldRelease } from "../holds/unpaid-hold-release.service";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import { WorkspaceTableAssignmentService } from "../reservation/workspace-table-assignment.service";
import { LatePaymentRecoveryService } from "./late-payment-recovery.service";

const testDatabase = await connectWorkspacePostgresTestDatabase();

/** A collaborator the superseded-payment path must never reach. */
const unreachable = (name: string) =>
  mock(() => Effect.die(`${name} must not be called`));

describe.skipIf(!testDatabase)(
  "LatePaymentRecoveryService.recover on disposable Postgres",
  () => {
    if (!testDatabase) return;
    const reservationIds: WorkspaceReservationId[] = [];

    afterAll(async () => {
      await testDatabase.pool.query(
        "delete from late_payment_recoveries where workspace_reservation_id = any($1)",
        [reservationIds]
      );
      await testDatabase.pool.query(
        "update workspace_reservations set active_payment_attempt_id = null where id = any($1)",
        [reservationIds]
      );
      await testDatabase.pool.query(
        "delete from payment_attempts where workspace_reservation_id = any($1)",
        [reservationIds]
      );
      await testDatabase.pool.query(
        "delete from workspace_reservations where id = any($1)",
        [reservationIds]
      );
    });

    const dotypos = {
      getReservationStatus: unreachable("getReservationStatus"),
      cancelReservation: unreachable("cancelReservation"),
      createReservation: unreachable("createReservation"),
      listActiveReservationsOverlapping: unreachable(
        "listActiveReservationsOverlapping"
      ),
    };

    const repositories = Layer.mergeAll(
      LatePaymentRecoveryRepository.Default,
      WorkspaceReservationRepository.Default
    ).pipe(Layer.provide(testDatabase.layer));

    const recoveryLayer = LatePaymentRecoveryService.Default.pipe(
      Layer.provide(UnpaidHoldRelease.Default),
      Layer.provideMerge(
        Layer.mergeAll(
          repositories,
          WorkspaceDatabaseAdvisoryLock.makeLayer(testDatabase.databasePool),
          Layer.mock(DotyposService, dotypos),
          Layer.mock(AccountingDocumentSnapshots, {
            find: unreachable("snapshots.find"),
          }),
          Layer.mock(WorkspaceAvailabilityService, {
            ensureAvailable: unreachable("ensureAvailable"),
          }),
          Layer.mock(WorkspaceTableAssignmentService, {
            assignTableId: unreachable("assignTableId"),
          }),
          Layer.mock(ReservationFulfillment, {
            run: unreachable("fulfillment.run"),
          })
        )
      )
    );

    const recover = (paymentAttemptId: string) =>
      LatePaymentRecoveryService.pipe(
        Effect.flatMap((service) =>
          service.recover({
            paymentAttemptId: paymentAttemptIdSchema.make(paymentAttemptId),
          })
        ),
        Effect.provide(recoveryLayer),
        Effect.runPromise
      );

    /**
     * An order whose first payment page (attempt A) expired and a newer
     * attempt (B) now holds the live hold and a pending payment, as after a
     * retry. A's payment arrives late and its recovery has started.
     */
    const insertRetriedOrderWithLatePayment = async () => {
      const id = crypto.randomUUID();
      const reservation = await Effect.runPromise(
        workspaceFixtures(testDatabase.db).reservation({
          stage: { reservation: "held", payment: "pending" },
          overrides: {
            reservationHoldExpiresAt: Temporal.Now.instant().add({
              minutes: 30,
            }),
          },
        })
      );
      reservationIds.push(reservation.id);
      const earlier = paymentAttemptIdSchema.make(`earlier-${id}`);
      const newer = paymentAttemptIdSchema.make(`newer-${id}`);
      await Effect.runPromise(
        testDatabase.db.insert(paymentAttempts).values([
          {
            id: earlier,
            orderId: standaloneReservationOrderId(reservation.id),
            workspaceReservationId: reservation.id,
            provider: "nexi",
            providerOrderId: NexiOrderIdSchema.make(`order-earlier-${id}`),
            state: "expired",
            failureCode: "payment_abandoned_after_provider_cutoff",
            amountValue: 29_000,
            amountExponent: 2,
            currency: "CZK",
          },
          {
            id: newer,
            orderId: standaloneReservationOrderId(reservation.id),
            workspaceReservationId: reservation.id,
            provider: "nexi",
            providerOrderId: NexiOrderIdSchema.make(`order-newer-${id}`),
            state: "pending",
            amountValue: 29_000,
            amountExponent: 2,
            currency: "CZK",
          },
        ])
      );
      await Effect.runPromise(
        testDatabase.db
          .update(workspaceReservations)
          .set({ activePaymentAttemptId: newer })
          .where(eq(workspaceReservations.id, reservation.id))
      );
      await Effect.runPromise(
        LatePaymentRecoveryRepository.pipe(
          Effect.flatMap((recoveries) =>
            recoveries.start({
              paymentAttemptId: earlier,
              workspaceReservationId: reservation.id,
              providerStatus: "EXECUTED",
              verifiedPaidAt: Temporal.Now.instant(),
            })
          ),
          Effect.provide(repositories)
        )
      );
      const [before] = await Effect.runPromise(
        testDatabase.db
          .select()
          .from(workspaceReservations)
          .where(eq(workspaceReservations.id, reservation.id))
      );
      return {
        reservationId: reservation.id,
        earlier,
        newer,
        before: requireValue(before, "held reservation"),
      };
    };

    const readOrder = async (input: {
      readonly reservationId: WorkspaceReservationId;
      readonly earlier: string;
      readonly newer: string;
    }) => {
      const read = <T>(query: Effect.Effect<T, unknown>) =>
        Effect.runPromise(query);
      const [reservation] = await read(
        testDatabase.db
          .select()
          .from(workspaceReservations)
          .where(eq(workspaceReservations.id, input.reservationId))
      );
      const attempts = await read(
        testDatabase.db
          .select()
          .from(paymentAttempts)
          .where(
            eq(paymentAttempts.workspaceReservationId, input.reservationId)
          )
      );
      const [recovery] = await read(
        testDatabase.db
          .select()
          .from(latePaymentRecoveries)
          .where(
            eq(
              latePaymentRecoveries.workspaceReservationId,
              input.reservationId
            )
          )
      );
      return {
        reservation: requireValue(reservation, "reservation"),
        earlier: requireValue(
          attempts.find(({ id }) => id === input.earlier),
          "earlier payment attempt"
        ),
        newer: requireValue(
          attempts.find(({ id }) => id === input.newer),
          "newer payment attempt"
        ),
        recovery: requireValue(recovery, "late-payment recovery"),
      };
    };

    test("refunds a payment on an earlier page without touching the newer attempt or its hold", async () => {
      const order = await insertRetriedOrderWithLatePayment();

      expect(await recover(order.earlier)).toBe("refund_required");

      const after = await readOrder(order);
      expect(after.earlier).toMatchObject({
        state: "paid",
        refundState: "required",
      });
      expect(after.newer).toMatchObject({ state: "pending" });
      expect(after.recovery).toMatchObject({
        state: "refund_required",
        failureCode: "late_payment_superseded_attempt",
      });
      expect(after.reservation).toMatchObject({
        reservationState: "held",
        paymentState: "pending",
        activePaymentAttemptId: order.newer,
        dotyposReservationId: order.before.dotyposReservationId,
      });
      expect(
        after.reservation.reservationHoldExpiresAt?.equals(
          requireValue(
            order.before.reservationHoldExpiresAt,
            "original hold expiry"
          )
        )
      ).toBe(true);
      for (const call of Object.values(dotypos)) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    test("claims a confirmed Team Table replacement before POST and settles it after releasing date locks", async () => {
      const row = await Effect.runPromise(
        workspaceFixtures(testDatabase.db).reservation({
          stage: { reservation: "cancelled" },
          overrides: {
            reservationDetails: {
              kind: "table",
              seats: 4,
              durationMinutes: 15,
            },
            cancellationCause: "hold_expired",
          },
        })
      );
      reservationIds.push(row.id);
      const paymentAttemptId = paymentAttemptIdSchema.make(
        `late-team-${crypto.randomUUID()}`
      );
      await Effect.runPromise(
        testDatabase.db.insert(paymentAttempts).values({
          id: paymentAttemptId,
          orderId: standaloneReservationOrderId(row.id),
          workspaceReservationId: row.id,
          provider: "nexi",
          providerOrderId: NexiOrderIdSchema.make(`order-${paymentAttemptId}`),
          state: "expired",
          failureCode: "payment_abandoned_after_provider_cutoff",
          amountValue: 26_000,
          amountExponent: 2,
          currency: "CZK",
        })
      );
      await Effect.runPromise(
        testDatabase.db
          .update(workspaceReservations)
          .set({
            activePaymentAttemptId: paymentAttemptId,
            paymentState: "expired",
          })
          .where(eq(workspaceReservations.id, row.id))
      );
      await Effect.runPromise(
        LatePaymentRecoveryRepository.pipe(
          Effect.flatMap((repo) =>
            repo.start({
              paymentAttemptId,
              workspaceReservationId: row.id,
              providerStatus: "EXECUTED",
              verifiedPaidAt: Temporal.Now.instant(),
            })
          ),
          Effect.provide(repositories)
        )
      );
      const reservation = {
        kind: "table",
        seats: 4,
        startsAt: instantStringSchema.make("2030-01-03T09:00:00Z"),
        endsAt: instantStringSchema.make("2030-01-03T09:15:00Z"),
      } as const;
      const quote = await Effect.runPromise(
        buildTableReservationQuote(reservation)
      );
      const snapshot = Schema.decodeUnknownSync(
        tableAccountingDocumentSnapshotSchema
      )({
        ...makeCoworkInvoiceDocument("en-US"),
        workspaceReservationId: row.id,
        dotyposCustomerId: row.dotyposCustomerId,
        dotyposReservationId: requireValue(
          row.dotyposReservationId,
          "original hold ID"
        ),
        reservation,
        quote,
      });
      const providerId = DotyposReservationIdSchema.make("late-team-confirmed");
      const create = mock(
        (
          input: Parameters<DotyposService["Service"]["createReservation"]>[0]
        ) =>
          Effect.gen(function* () {
            const [staged] = yield* testDatabase.db
              .select()
              .from(teamTableHoldClaims)
              .where(eq(teamTableHoldClaims.reservationId, row.id))
              .pipe(Effect.orDie);
            expect(staged).toMatchObject({
              purpose: "late_payment",
              paymentAttemptId,
              providerReservationIds: null,
              seats: 4,
            });
            expect(input).toMatchObject({
              status: "CONFIRMED",
              tableId: "late-team",
              singleAttempt: true,
              seats: 4,
            });
            expect(input.note).toContain(
              `Team Table hold: ${staged?.generation}`
            );
            return dotyposCreatedReservationFixture(providerId, input);
          })
      );
      const provider = Layer.mock(DotyposService, {
        createReservation: create,
      });
      const fulfill = mock(() => Effect.void);
      const layer = LatePaymentRecoveryService.Default.pipe(
        Layer.provide(UnpaidHoldRelease.Default),
        Layer.provide(
          Layer.mergeAll(
            repositories,
            WorkspaceDatabaseAdvisoryLock.makeLayer(testDatabase.databasePool),
            provider,
            TeamTableHoldClaims.Default.pipe(
              Layer.provide(Layer.merge(testDatabase.layer, provider))
            ),
            Layer.mock(OpenSpaceTableMoves, {
              repackInCapacitySection: () => Effect.succeed(true),
            }),
            Layer.mock(WorkspaceAvailabilityService, {
              getLiveTeamTablePlan: () =>
                Effect.succeed({
                  tableId: DotyposTableIdSchema.make("late-team"),
                  moves: [],
                }),
            }),
            Layer.mock(AccountingDocumentSnapshots, {
              find: () => Effect.succeed(snapshot),
            }),
            Layer.mock(WorkspaceTableAssignmentService, {}),
            Layer.mock(ReservationFulfillment, { run: fulfill })
          )
        )
      );
      const run = () =>
        Effect.runPromise(
          LatePaymentRecoveryService.pipe(
            Effect.flatMap((service) => service.recover({ paymentAttemptId })),
            Effect.provide(layer)
          )
        );
      expect(await run()).toBe("recovered");
      expect(await run()).toBe("recovered");
      expect(create).toHaveBeenCalledTimes(1);
      const [confirmed] = await Effect.runPromise(
        testDatabase.db
          .select()
          .from(workspaceReservations)
          .where(eq(workspaceReservations.id, row.id))
      );
      expect(confirmed).toMatchObject({
        reservationState: "confirmed",
        dotyposReservationId: providerId,
      });
    });

    test("waits for the order's lock section before it claims the recovery", async () => {
      const order = await insertRetriedOrderWithLatePayment();
      const orderLock = ["reservation-order", order.reservationId] as const;
      // Another workflow, such as hold cleanup, holds the order's section.
      const holder = await holdPostgresTransaction(
        testDatabase.pool,
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        orderLock
      );
      let recovering: Promise<unknown> | undefined;
      try {
        recovering = recover(order.earlier);
        await waitForAdvisoryLockWaiter(testDatabase.pool, orderLock);
        expect((await readOrder(order)).recovery.state).toBe("pending");
      } finally {
        await holder.commit();
      }

      expect(await recovering).toBe("refund_required");
      expect((await readOrder(order)).recovery.state).toBe("refund_required");
    });
  }
);
