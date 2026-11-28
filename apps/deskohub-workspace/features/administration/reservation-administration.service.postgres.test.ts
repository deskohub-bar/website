import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DotyposReservationIdSchema,
  DotyposService,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { accountingSnapshotKeyIdSchema } from "@/features/accounting/accounting-document-snapshot";
import { AccountingSnapshotKeyError } from "@/features/accounting/backend/accounting-snapshot-key.service";
import { InvoiceRepository } from "@/features/accounting/backend/invoice.repository";
import { InvoiceCancellationService } from "@/features/accounting/backend/invoice-cancellation.service";
import { makeInvoiceCancellationTestKit } from "@/features/accounting/backend/invoice-cancellation.test-utils";
import { InvoiceCancellationNotices } from "@/features/accounting/backend/invoice-cancellation-notices";
import { InvoiceEmailDeliveryService } from "@/features/accounting/backend/invoice-email-delivery.service";
import { ReservationInvoiceService } from "@/features/accounting/backend/reservation-invoice.service";
import { CurrentAdministrationAction } from "@/features/admin-cli/administration-action";
import { PaidFulfillmentQueueService } from "@/features/checkout/backend/fulfillment/paid-fulfillment-queue.service";
import { WorkspaceReservationEmailService } from "@/features/checkout/backend/fulfillment/workspace-reservation-email.service";
import { FioPaymentSettlementRepository } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";
import { startReservationAudit } from "@/features/reservation/backend/reservation-audit";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceReservationService } from "@/features/reservation/backend/workspace-reservation.service";
import { workspaceReservationDetailsFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { waitForPostgresLockWaiter } from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  requireTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  ReservationAdministrationService,
  type ReservationCancellationInput,
} from "./reservation-administration.service";
import { ReservationRestorationService } from "./reservation-restoration.service";

const testDatabase = await createWorkspacePostgresSuiteDatabase(
  "reservation_invoice_cancellation"
);
afterAll(() => testDatabase?.close());

const testKit = testDatabase
  ? makeInvoiceCancellationTestKit(testDatabase)
  : null;
const requireKit = () => {
  if (!testKit) {
    throw new Error("No test database: set WORKSPACE_TEST_DATABASE_URL");
  }
  return testKit;
};
const runFioRepository = <A, E>(
  effect: Effect.Effect<A, E, FioPaymentSettlementRepository>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FioPaymentSettlementRepository.Default.pipe(
          Layer.provide(requireTestDatabase(testDatabase).layer)
        )
      )
    )
  );
const testKeyId = accountingSnapshotKeyIdSchema.make("K202611");
const missingKey = new AccountingSnapshotKeyError({
  keyId: testKeyId,
  message: "Synthetic key is unavailable.",
});
const readableKey = {
  id: testKeyId,
  secret: "synthetic corrective document secret!",
};

/**
 * Reservation cancellation over the suite database: the real reservation
 * and invoice repositories, with Dotypos, the reservation email, the
 * provider reservation read and the notice email faked.
 */
const makeCancellation = (
  options: {
    readonly encryptionKeyFails?: boolean;
    readonly decryptionKeyFails?: boolean;
    /** Runs in the claim's transaction, just before the reservation is claimed. */
    readonly beforeClaim?: Effect.Effect<void>;
    /** Runs in the claim's transaction, after the claim, before it commits. */
    readonly afterClaim?: Effect.Effect<void>;
    /** Runs while Dotypos cancels, after the claim committed. */
    readonly duringProviderCancel?: Effect.Effect<void>;
  } = {}
) => {
  const repositories = requireKit().layer({
    getActive: options.encryptionKeyFails
      ? Effect.fail(missingKey)
      : Effect.succeed(readableKey),
    getById: () =>
      options.decryptionKeyFails
        ? Effect.fail(missingKey)
        : Effect.succeed(readableKey),
  });
  const deliver = mock(
    (_input: Parameters<InvoiceCancellationNotices["Service"]["deliver"]>[0]) =>
      Effect.succeed({
        changed: true,
        notices: {
          customer: "not_owed" as const,
          internal: "accepted" as const,
          needsAttention: false,
        },
      })
  );
  const cancelReservation = mock(
    () => options.duringProviderCancel ?? Effect.void
  );
  const reservations = Layer.effect(
    WorkspaceReservationRepository,
    Effect.map(WorkspaceReservationRepository, (real) => ({
      ...real,
      claimAdministrationCancellation: (
        input: Parameters<typeof real.claimAdministrationCancellation>[0]
      ) =>
        (options.beforeClaim ?? Effect.void).pipe(
          Effect.andThen(real.claimAdministrationCancellation(input)),
          Effect.tap(() => options.afterClaim ?? Effect.void)
        ),
    }))
  ).pipe(
    Layer.provide(WorkspaceReservationRepository.Default),
    Layer.provide(repositories)
  );
  const invoiceCancellation = InvoiceCancellationService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        repositories,
        Layer.mock(InvoiceCancellationNotices, { deliver })
      )
    )
  );
  const layer = ReservationAdministrationService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        repositories,
        reservations,
        invoiceCancellation,
        Layer.mock(DotyposService, { cancelReservation }),
        Layer.mock(ReservationRestorationService, {}),
        Layer.mock(ReservationInvoiceService, {}),
        Layer.mock(PaidFulfillmentQueueService, {}),
        Layer.mock(WorkspaceReservationEmailService, {
          sendCancellationEmail: () => Effect.void,
        }),
        Layer.mock(WorkspaceReservationService, {
          getReservation: (id: WorkspaceReservationId) =>
            Effect.promise(async () => {
              const [row] = await requireKit().query<{
                dotypos_reservation_id: string;
              }>(
                "select dotypos_reservation_id from workspace_reservations where id = $1",
                [id]
              );
              if (!row) throw new Error("Expected a booked reservation");
              return workspaceReservationDetailsFixture({
                id,
                dotyposReservationId: DotyposReservationIdSchema.make(
                  row.dotypos_reservation_id
                ),
                providerStatus: "CONFIRMED",
              });
            }),
        })
      )
    )
  );
  const cancel = (
    input: ReservationCancellationInput,
    actionId = crypto.randomUUID()
  ) =>
    Effect.runPromise(
      ReservationAdministrationService.pipe(
        Effect.flatMap((service) => service.cancel(input)),
        Effect.provideService(CurrentAdministrationAction, {
          id: actionId,
          markReplayed: Effect.void,
        }),
        Effect.provide(layer)
      )
    );
  const cancelFailure = (input: ReservationCancellationInput) =>
    Effect.runPromise(
      ReservationAdministrationService.pipe(
        Effect.flatMap((service) => Effect.flip(service.cancel(input))),
        Effect.provide(layer)
      )
    );
  const readAudit = (
    input: Parameters<
      ReservationAdministrationService["Service"]["readAudit"]
    >[0]
  ) =>
    Effect.runPromise(
      ReservationAdministrationService.pipe(
        Effect.flatMap((service) => service.readAudit(input)),
        Effect.provide(layer)
      )
    );
  return { cancel, cancelFailure, cancelReservation, deliver, readAudit };
};

/**
 * Reservation restore over the suite database. The restore itself confirms
 * the reservation with the real repository write, as main's restore does in
 * its finalize transaction; the replacement issues through the real invoice
 * service and repositories, with Dotypos and the invoice email faked.
 */
const makeRestoration = (
  options: {
    readonly billingUpdateFails?: boolean;
    readonly decryptionKeyFails?: boolean;
  } = {}
) => {
  const repositories = requireKit().layer({
    getActive: Effect.succeed(readableKey),
    getById: () =>
      options.decryptionKeyFails
        ? Effect.fail(missingKey)
        : Effect.succeed(readableKey),
  });
  const delivered = mock((_input: { readonly paymentAttemptId: string }) => {});
  const billingUpdates = mock((_customerId: string) => {});
  const enqueue = mock(
    (
      _input: Parameters<PaidFulfillmentQueueService["Service"]["enqueue"]>[0]
    ) => Effect.void
  );
  const reservations = WorkspaceReservationRepository.Default.pipe(
    Layer.provide(repositories)
  );
  const restoration = Layer.effect(
    ReservationRestorationService,
    Effect.gen(function* () {
      const repository = yield* WorkspaceReservationRepository;
      const { transaction } = yield* WorkspaceDatabase;
      return ReservationRestorationService.of({
        restore: ({ actor, reservationId }) =>
          repository.findById(reservationId).pipe(
            Effect.flatMap((current) => {
              const cancelledAt =
                current?.reservationState === "cancelled"
                  ? current.reservationCancelledAt
                  : null;
              return cancelledAt
                ? transaction(
                    startReservationAudit(actor).pipe(
                      Effect.flatMap((audit) =>
                        repository.markAdministrationRestored({
                          audit,
                          id: reservationId,
                          cancelledAt,
                          restoredAt: Temporal.Now.instant(),
                        })
                      )
                    )
                  ).pipe(Effect.as("restored" as const))
                : Effect.succeed("already_confirmed" as const);
            }),
            Effect.map((outcome) => ({
              outcome,
              email: "not_requested" as const,
              access: "not_needed" as const,
            })),
            Effect.orDie
          ),
      });
    })
  ).pipe(Layer.provide(Layer.merge(reservations, repositories)));
  const reservationInvoices = ReservationInvoiceService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        repositories,
        reservations,
        Layer.mock(DotyposService, {
          updateCustomerBillingDetails: (customerId) =>
            options.billingUpdateFails
              ? // A typed failure, as Dotypos fails.
                Effect.fail(
                  new DotyposUnavailable({
                    operation: "updateCustomerBillingDetails",
                    reason: "server",
                  })
                )
              : Effect.sync(() => billingUpdates(customerId)),
        }),
        Layer.mock(InvoiceEmailDeliveryService, {
          deliverByPaymentAttemptId: (input) =>
            Effect.sync(() => delivered(input)).pipe(
              Effect.as({ status: "delivered" as const, changed: true })
            ),
        })
      )
    )
  );
  const services = Layer.mergeAll(
    repositories,
    reservations,
    restoration,
    reservationInvoices,
    Layer.mock(PaidFulfillmentQueueService, { enqueue }),
    Layer.mock(InvoiceCancellationService, {}),
    Layer.mock(DotyposService, {}),
    Layer.mock(WorkspaceReservationEmailService, {}),
    Layer.mock(WorkspaceReservationService, {})
  );
  const layer = Layer.merge(
    ReservationAdministrationService.Default.pipe(Layer.provide(services)),
    reservationInvoices
  );
  const restore = async (reservationId: WorkspaceReservationId) => {
    const actor = await requireKit().makeActor(
      `reservation-restore-${crypto.randomUUID()}`
    );
    return Effect.runPromise(
      ReservationAdministrationService.pipe(
        Effect.flatMap((service) =>
          service.restore({
            actor,
            reservationId,
            acknowledgeRefundedPayment: false,
            sendRestorationEmail: false,
          })
        ),
        Effect.provide(layer)
      )
    );
  };
  /** What the restore preview reads. */
  const plan = (reservationId: WorkspaceReservationId) =>
    Effect.runPromise(
      ReservationInvoiceService.pipe(
        Effect.flatMap((service) =>
          service.planRestoredInvoice({ reservationId })
        ),
        Effect.provide(layer)
      )
    );
  return { billingUpdates, delivered, enqueue, plan, restore };
};

const readLatestInvoice = (reservationId: WorkspaceReservationId) =>
  requireKit().run(
    Effect.flatMap(InvoiceRepository, (invoices) =>
      invoices.findLatestByReservationId(reservationId)
    )
  );

const readInvoiceChain = (reservationId: string) =>
  requireKit().query<{
    id: string;
    invoice_number: string;
    replaces_invoice_id: string | null;
  }>(
    "select id, invoice_number, replaces_invoice_id from invoices where workspace_reservation_id = $1 order by issued_at, invoice_number",
    [reservationId]
  );

const readCreditNotes = (invoiceId: string) =>
  requireKit().query(
    "select * from corrective_documents where cancelled_invoice_id = $1",
    [invoiceId]
  );

const readState = async (reservationId: string, invoiceId?: string) => {
  const [reservation] = await requireKit().query<{ reservation_state: string }>(
    "select reservation_state from workspace_reservations where id = $1",
    [reservationId]
  );
  const cancellations = invoiceId
    ? await requireKit().query<{ cause: string; source: string }>(
        "select cause, source from invoice_cancellations where invoice_id = $1",
        [invoiceId]
      )
    : [];
  return {
    reservation: reservation?.reservation_state,
    cancellations,
  };
};

const cancellationInput = async (
  reservationId: WorkspaceReservationId,
  confirmedConsequences?: ReservationCancellationInput["confirmedConsequences"]
): Promise<ReservationCancellationInput> => ({
  actor: await requireKit().makeActor(`reservation-cancel-${reservationId}`),
  ...(confirmedConsequences && { confirmedConsequences }),
  reservationId,
  sendCancellationEmail: false,
});

describe.skipIf(!testDatabase)(
  "Reservation cancellation with its invoice on disposable Postgres",
  () => {
    test("cancels the reservation and its live invoice together, then sends the notices", async () => {
      const { invoice, reservation } =
        await requireKit().issueReservationInvoice();
      const { cancel, deliver } = makeCancellation();

      const result = await cancel(
        await cancellationInput(reservation.id, {
          invoice: true,
          customerNotice: false,
        })
      );

      expect(result).toMatchObject({
        outcome: "cancelled",
        invoice: {
          outcome: "cancelled",
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          correctiveDocumentNumber: expect.stringMatching(/^WS-OD-/),
        },
      });
      expect(await readState(reservation.id, invoice.id)).toEqual({
        reservation: "cancelled",
        cancellations: [
          { cause: "reservation_cancellation", source: "dhw-cli" },
        ],
      });
      // The reservation keeps its own record of why it was cancelled beside
      // the invoice's cancellation cause.
      const [reservationCause] = await requireKit().query<{
        cancellation_cause: string | null;
      }>(
        "select cancellation_cause from workspace_reservations where id = $1",
        [reservation.id]
      );
      expect(reservationCause?.cancellation_cause).toBe("operator");
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]?.[0].invoiceId).toBe(invoice.id);
    });

    test("tracks and preserves a manually refunded Fio winner independently of its duplicate", async () => {
      const { reservation, paymentAttemptId } =
        await requireKit().issueReservationInvoice();
      await requireKit().query(
        "update payment_attempts set provider = 'fio', provider_order_id = '9000000000', last_provider_operation_id = 'manual-fio-winner' where id = $1",
        [paymentAttemptId]
      );
      await requireKit().query(
        `insert into fio_payment_settlements
          (order_id, payment_attempt_id, account_key, movement_id, variable_symbol, amount_value, currency, booking_date, observed_at, disposition)
          select order_id, id, 'synthetic-account', evidence.movement_id, '9000000000', amount_value, currency, current_date, now(), evidence.disposition
          from payment_attempts cross join (values ('manual-fio-winner', 'winner'), ('manual-fio-duplicate', 'refund_required')) as evidence(movement_id, disposition)
          where id = $1`,
        [paymentAttemptId]
      );
      const listEvidence = () =>
        runFioRepository(
          Effect.flatMap(FioPaymentSettlementRepository, (repo) =>
            repo.listForOrder(reservation.id)
          )
        );
      const before = await listEvidence();
      const winner = before.find(
        ({ movementId }) => movementId === "manual-fio-winner"
      );
      const duplicate = before.find(
        ({ movementId }) => movementId === "manual-fio-duplicate"
      );
      assert(winner, "Expected manual-fio-winner settlement");
      assert(duplicate, "Expected manual-fio-duplicate settlement");

      const { cancel } = makeCancellation();
      expect(
        await cancel(await cancellationInput(reservation.id))
      ).toMatchObject({
        outcome: "cancelled",
      });
      const cancelled = await listEvidence();
      expect(cancelled.find(({ id }) => id === winner.id)?.disposition).toBe(
        "refund_required"
      );
      expect(cancelled.find(({ id }) => id === duplicate.id)).toEqual(
        duplicate
      );

      const refundedAt = Temporal.Now.instant().round({
        smallestUnit: "millisecond",
      });
      const recordRefund = (id: string, at: Temporal.Instant) =>
        runFioRepository(
          Effect.flatMap(FioPaymentSettlementRepository, (repo) =>
            repo.markManualRefunded(id, at)
          )
        );
      expect(await recordRefund(winner.id, refundedAt)).toMatchObject({
        disposition: "refunded",
      });
      expect(
        (
          await recordRefund(winner.id, refundedAt.add({ seconds: 1 }))
        )?.refundedAt?.equals(refundedAt)
      ).toBe(true);

      const { restore } = makeRestoration();
      expect(await restore(reservation.id)).toMatchObject({
        outcome: "restored",
      });
      const restored = await listEvidence();
      expect(restored.find(({ id }) => id === winner.id)?.disposition).toBe(
        "refunded"
      );
      expect(restored.find(({ id }) => id === duplicate.id)).toEqual(duplicate);
      expect(
        await requireKit().query(
          "select refund_state from payment_attempts where id = $1",
          [paymentAttemptId]
        )
      ).toEqual([{ refund_state: "refunded" }]);
    });

    test("a failed invoice cancellation rolls the reservation's completion back with it", async () => {
      const { invoice, reservation } =
        await requireKit().issueReservationInvoice();
      const { cancelFailure, cancelReservation, deliver } = makeCancellation({
        encryptionKeyFails: true,
      });

      const failure = await cancelFailure(
        await cancellationInput(reservation.id)
      );

      expect(failure.reason).toBe("record_failed");
      expect(cancelReservation).toHaveBeenCalledTimes(1);
      // Neither is cancelled; the claim is released for a retry.
      expect(await readState(reservation.id, invoice.id)).toEqual({
        reservation: "cancellation_failed",
        cancellations: [],
      });
      expect(deliver).not.toHaveBeenCalled();
    });

    test("records a failed cancellation and its retry once per guarded commit", async () => {
      const { reservation } = await requireKit().issueReservationInvoice();
      const input = await cancellationInput(reservation.id);
      const first = makeCancellation({ encryptionKeyFails: true });
      expect((await first.cancelFailure(input)).reason).toBe("record_failed");

      const replay = makeCancellation();
      const actionId = crypto.randomUUID();
      expect((await replay.cancel(input, actionId)).outcome).toBe("cancelled");
      expect((await replay.cancel(input)).outcome).toBe("already_cancelled");
      expect(replay.cancelReservation).toHaveBeenCalledTimes(1);

      const page = await replay.readAudit({
        actor: input.actor,
        reservationId: reservation.id,
      });
      expect(
        page?.events.map(({ beforeState, afterState, reason }) => [
          beforeState,
          afterState,
          reason,
        ])
      ).toEqual([
        ["cancelling", "cancelled", "cancellation_completed"],
        ["cancellation_failed", "cancelling", "cancellation_reclaimed"],
        ["cancelling", "cancellation_failed", "local_cancellation_failed"],
        ["confirmed", "cancelling", "operator_cancellation"],
      ]);
      assert(page, "Expected audit page");
      const [completed, reclaimed, failed, claimed] = page.events;
      assert(completed, "Expected completed audit event");
      assert(reclaimed, "Expected reclaimed audit event");
      assert(failed, "Expected failed audit event");
      assert(claimed, "Expected claimed audit event");
      expect(completed).toMatchObject({
        causedByEventId: reclaimed.id,
        correlationId: reclaimed.correlationId,
        administrationActionId: actionId,
        actorAccountId: input.actor.administrator.accountId,
        source: "dhw-cli",
        schemaVersion: 1,
      });
      expect(failed).toMatchObject({
        causedByEventId: claimed.id,
        correlationId: claimed.correlationId,
      });
      expect(reclaimed.correlationId).not.toBe(claimed.correlationId);
      expect(JSON.stringify(page)).not.toContain(
        input.actor.administrator.email
      );
      const older = await replay.readAudit({
        actor: input.actor,
        reservationId: reservation.id,
        before: reclaimed.id,
      });
      expect(older?.events.map(({ id }) => id)).toEqual([
        failed.id,
        claimed.id,
      ]);
      expect(
        await requireKit().query(
          "select actor_account_id, source, before_event_id, returned_count from reservation_audit_accesses where reservation_id = $1 order by occurred_at",
          [reservation.id]
        )
      ).toEqual([
        {
          actor_account_id: input.actor.administrator.accountId,
          source: "dhw-cli",
          before_event_id: null,
          returned_count: 4,
        },
        {
          actor_account_id: input.actor.administrator.accountId,
          source: "dhw-cli",
          before_event_id: reclaimed.id,
          returned_count: 2,
        },
      ]);
    });

    test("rolls back a claim when audit append fails and refuses reads when access logging fails", async () => {
      const { reservation, invoice } =
        await requireKit().issueReservationInvoice();
      const input = await cancellationInput(reservation.id);
      const { cancelFailure, cancelReservation, readAudit } =
        makeCancellation();
      await requireKit().query(
        "alter table reservation_audit_events add constraint reject_test_claim check (false) not valid"
      );
      try {
        expect((await cancelFailure(input)).reason).toBe("claim_failed");
        expect(cancelReservation).not.toHaveBeenCalled();
        expect(await readState(reservation.id, invoice.id)).toEqual({
          reservation: "confirmed",
          cancellations: [],
        });
      } finally {
        await requireKit().query(
          "alter table reservation_audit_events drop constraint reject_test_claim"
        );
      }

      await requireKit().query(
        "alter table reservation_audit_accesses add constraint reject_test_access check (false) not valid"
      );
      try {
        await expect(
          readAudit({ actor: input.actor, reservationId: reservation.id })
        ).rejects.toThrow();
      } finally {
        await requireKit().query(
          "alter table reservation_audit_accesses drop constraint reject_test_access"
        );
      }
    });

    test("rolls back the completed cancellation and its invoice when the completion event cannot append", async () => {
      const { reservation, invoice } =
        await requireKit().issueReservationInvoice();
      const input = await cancellationInput(reservation.id);
      const { cancelFailure, readAudit } = makeCancellation();
      await requireKit().query(
        "alter table reservation_audit_events add constraint reject_test_completion check (reason <> 'cancellation_completed') not valid"
      );
      try {
        expect((await cancelFailure(input)).reason).toBe("record_failed");
        expect(await readState(reservation.id, invoice.id)).toEqual({
          reservation: "cancellation_failed",
          cancellations: [],
        });
        const page = await readAudit({
          actor: input.actor,
          reservationId: reservation.id,
        });
        expect(page?.events.map(({ reason }) => reason)).toEqual([
          "local_cancellation_failed",
          "operator_cancellation",
        ]);
      } finally {
        await requireKit().query(
          "alter table reservation_audit_events drop constraint reject_test_completion"
        );
      }
    });

    test("PostgreSQL rejects updates, deletions, and truncation of both audit records", async () => {
      for (const table of [
        "reservation_audit_events",
        "reservation_audit_accesses",
      ]) {
        for (const statement of [
          `update ${table} set source = 'admin-ui' where false`,
          `delete from ${table} where false`,
          `truncate ${table} cascade`,
        ]) {
          await expect(requireKit().query(statement)).rejects.toMatchObject({
            code: "23514",
          });
        }
      }
    });

    test("bounds reads to 100 events and continues with the next event", async () => {
      const { reservation } = await requireKit().createPaidReservation();
      const { actor } = await cancellationInput(reservation.id);
      await requireKit().query(
        `insert into reservation_audit_events (
          id, reservation_id, actor_account_id, source, before_state, after_state,
          reason, occurred_at, correlation_id
        )
        select gen_random_uuid(), $1, $2, 'dhw-cli', 'cancelled', 'confirmed',
          'operator_restoration', now() - sequence * interval '1 second', gen_random_uuid()
        from generate_series(1, 101) as sequence`,
        [reservation.id, actor.administrator.accountId]
      );
      const { readAudit } = makeCancellation();
      const first = await readAudit({ actor, reservationId: reservation.id });
      assert(first, "Expected first audit page");
      expect(first.events).toHaveLength(100);
      const last = first.events.at(-1);
      assert(last, "Expected last audit event");
      expect(first.nextBefore).toBe(last.id);
      assert(first.nextBefore, "Expected nextBefore cursor");
      const next = await readAudit({
        actor,
        reservationId: reservation.id,
        before: first.nextBefore,
      });
      assert(next, "Expected second audit page");
      expect(next.events).toHaveLength(1);
      expect(next.nextBefore).toBeNull();
      expect(
        new Set([...first.events, ...next.events].map(({ id }) => id)).size
      ).toBe(101);

      const other = await requireKit().createPaidReservation();
      expect(
        await readAudit({
          actor,
          reservationId: other.reservation.id,
          before: first.nextBefore,
        })
      ).toBeNull();
      expect(
        await requireKit().query(
          "select id from reservation_audit_accesses where reservation_id = $1",
          [other.reservation.id]
        )
      ).toEqual([]);
    });

    test("an unreadable invoice stops the cancellation before the provider call", async () => {
      const { invoice, reservation } =
        await requireKit().issueReservationInvoice();
      const { cancelFailure, cancelReservation } = makeCancellation({
        decryptionKeyFails: true,
      });

      const failure = await cancelFailure(
        await cancellationInput(reservation.id)
      );

      expect(failure.reason).toBe("invoice_unavailable");
      expect(cancelReservation).not.toHaveBeenCalled();
      expect(await readState(reservation.id, invoice.id)).toEqual({
        reservation: "confirmed",
        cancellations: [],
      });
    });

    test("refuses consequences the operator did not confirm, before the provider call", async () => {
      const { invoice, reservation } =
        await requireKit().issueReservationInvoice();
      const { cancelFailure, cancelReservation } = makeCancellation();

      const failure = await cancelFailure(
        await cancellationInput(reservation.id, {
          invoice: false,
          customerNotice: false,
        })
      );

      expect(failure).toMatchObject({
        code: "not_cancellable",
        reason: "confirmation_stale",
      });
      expect(cancelReservation).not.toHaveBeenCalled();
      expect((await readState(reservation.id, invoice.id)).reservation).toBe(
        "confirmed"
      );
    });

    test("an invoice issued just before the claim refuses a cancellation confirmed without it", async () => {
      const paid = await requireKit().createPaidReservation();
      let issuedId: string | undefined;
      const { cancelFailure, cancelReservation } = makeCancellation({
        // Issued and committed on its own connection once the operator's
        // reservation read is done, as a concurrent fulfillment would.
        beforeClaim: Effect.promise(() =>
          Effect.runPromise(paid.issueInvoice())
        ).pipe(
          Effect.flatMap(({ invoice }) =>
            Effect.sync(() => {
              issuedId = invoice.id;
            })
          )
        ),
      });

      const failure = await cancelFailure(
        await cancellationInput(paid.reservation.id, {
          invoice: false,
          customerNotice: false,
        })
      );

      expect(failure).toMatchObject({
        code: "not_cancellable",
        reason: "confirmation_stale",
      });
      expect(cancelReservation).not.toHaveBeenCalled();
      expect(await readState(paid.reservation.id, issuedId)).toEqual({
        reservation: "confirmed",
        cancellations: [],
      });
    });

    test("an invoice issued while the claim is being checked waits for it and is refused", async () => {
      const paid = await requireKit().createPaidReservation();
      let issuance: Promise<unknown> | undefined;
      const { cancel } = makeCancellation({
        afterClaim: Effect.promise(async () => {
          issuance = Effect.runPromise(Effect.flip(paid.issueInvoice()));
          await waitForPostgresLockWaiter(
            requireTestDatabase(testDatabase).pool,
            {
              condition: "locktype = 'transactionid'",
              description: "the invoice issuance waiting for the claim",
            }
          );
        }),
      });

      const result = await cancel(
        await cancellationInput(paid.reservation.id, {
          invoice: false,
          customerNotice: false,
        })
      );

      expect(result).toMatchObject({ outcome: "cancelled", invoice: null });
      expect(await issuance).toMatchObject({
        _tag: "InvoiceEligibilityError",
        reason: "reservation_cancelled",
      });
      expect(
        await requireKit().query(
          "select id from invoices where workspace_reservation_id = $1",
          [paid.reservation.id]
        )
      ).toEqual([]);
    });

    test("issuance refuses once the reservation's cancellation is claimed", async () => {
      const paid = await requireKit().createPaidReservation();
      let refusal: unknown;
      const { cancel } = makeCancellation({
        duringProviderCancel: Effect.flip(paid.issueInvoice()).pipe(
          Effect.flatMap((error) =>
            Effect.sync(() => {
              refusal = error;
            })
          ),
          Effect.orDie
        ),
      });

      const result = await cancel(await cancellationInput(paid.reservation.id));

      expect(refusal).toMatchObject({
        _tag: "InvoiceEligibilityError",
        reason: "reservation_cancelled",
      });
      expect(result).toMatchObject({ outcome: "cancelled", invoice: null });
    });

    test("an already cancelled reservation answers already_cancelled without touching its invoice", async () => {
      const { invoice, reservation } =
        await requireKit().issueReservationInvoice();
      const first = makeCancellation();
      await first.cancel(await cancellationInput(reservation.id));
      const replay = makeCancellation();

      const result = await replay.cancel(
        await cancellationInput(reservation.id)
      );

      expect(result).toEqual({
        outcome: "already_cancelled",
        email: "not_requested",
        invoice: null,
      });
      expect(replay.cancelReservation).not.toHaveBeenCalled();
      expect(
        (await readState(reservation.id, invoice.id)).cancellations
      ).toHaveLength(1);
    });
  }
);

describe.skipIf(!testDatabase)(
  "Reservation restore with its cancelled invoice on disposable Postgres",
  () => {
    const requestedInvoice = {
      purpose: "personal",
      invoice: "requested",
      address: {
        line1: "Synthetic 1",
        city: "Praha",
        postalCode: "100 00",
        country: "CZ",
      },
    } as const;

    const cancelWithInvoice = async (
      options: Parameters<
        ReturnType<typeof requireKit>["issueReservationInvoice"]
      >[0] = {}
    ) => {
      const issued = await requireKit().issueReservationInvoice(options);
      await makeCancellation().cancel(
        await cancellationInput(issued.reservation.id)
      );
      return issued;
    };

    const expectReplacement = async (
      reservationId: WorkspaceReservationId,
      cancelled: { readonly id: string; readonly invoiceNumber: string }
    ) => {
      const chain = await readInvoiceChain(reservationId);
      expect(chain).toHaveLength(2);
      const replacement = chain.find(({ id }) => id !== cancelled.id);
      assert(replacement, "Expected replacement invoice in chain");
      expect(replacement.replaces_invoice_id).toBe(cancelled.id);
      expect(replacement.invoice_number).not.toBe(cancelled.invoiceNumber);
      return replacement;
    };

    test("reissues an invoice whose buyer was frozen at payment through paid fulfillment's issuance; its credit note stays", async () => {
      const { invoice, reservation } = await cancelWithInvoice({
        billing: requestedInvoice,
      });
      const creditNotes = await readCreditNotes(invoice.id);
      const { billingUpdates, delivered, enqueue, plan, restore } =
        makeRestoration();

      expect(await plan(reservation.id)).toMatchObject({
        kind: "reissue",
        origin: "payment",
      });
      const result = await restore(reservation.id);

      const replacement = await expectReplacement(reservation.id, invoice);
      expect(result).toEqual({
        outcome: "restored",
        email: "not_requested",
        access: "not_needed",
        invoice: {
          outcome: "issued",
          invoiceId: replacement.id,
          invoiceNumber: replacement.invoice_number,
        },
      });
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(billingUpdates).toHaveBeenCalledTimes(1);
      expect(enqueue).not.toHaveBeenCalled();
      expect(await readCreditNotes(invoice.id)).toEqual(creditNotes);
      expect(
        (await readState(reservation.id, invoice.id)).cancellations
      ).toEqual([{ cause: "reservation_cancellation", source: "dhw-cli" }]);

      // A rerun finds the replacement live and issues nothing more.
      expect(await restore(reservation.id)).toMatchObject({
        outcome: "already_confirmed",
        invoice: null,
      });
      expect(await readInvoiceChain(reservation.id)).toHaveLength(2);
      expect(await plan(reservation.id)).toEqual({ kind: "not_owed" });
    });

    test("reissues a post-order invoice to the cancelled invoice's buyer and sends it once", async () => {
      // No invoice was asked for at payment: the cancelled one was requested
      // after the order.
      const { invoice, reservation } = await cancelWithInvoice();
      const cancelled = await readLatestInvoice(reservation.id);
      const { billingUpdates, delivered, enqueue, plan, restore } =
        makeRestoration();

      expect(await plan(reservation.id)).toMatchObject({
        kind: "reissue",
        origin: "post_order",
      });
      const result = await restore(reservation.id);

      const replacement = await expectReplacement(reservation.id, invoice);
      expect(result).toMatchObject({
        outcome: "restored",
        invoice: {
          outcome: "issued",
          invoiceId: replacement.id,
          invoiceNumber: replacement.invoice_number,
        },
      });
      const reissued = await readLatestInvoice(reservation.id);
      assert(cancelled, "Expected cancelled invoice");
      expect(reissued?.id).toBe(replacement.id);
      expect(reissued?.document.buyer).toEqual(cancelled.document.buyer);
      expect(delivered).toHaveBeenCalledTimes(1);
      // Dotypos takes the buyer before the invoice commits it.
      expect(billingUpdates).toHaveBeenCalledTimes(1);
      expect(enqueue).not.toHaveBeenCalled();
    });

    test("an unreadable cancelled invoice makes the preview promise none and the restore report not_issued", async () => {
      const { reservation } = await cancelWithInvoice();
      const { delivered, plan, restore } = makeRestoration({
        decryptionKeyFails: true,
      });

      expect(await plan(reservation.id)).toEqual({ kind: "unreadable" });
      expect(await restore(reservation.id)).toMatchObject({
        outcome: "restored",
        invoice: {
          outcome: "not_issued",
          invoiceId: null,
          invoiceNumber: null,
        },
      });
      expect((await readState(reservation.id)).reservation).toBe("confirmed");
      expect(delivered).not.toHaveBeenCalled();
      expect(await readInvoiceChain(reservation.id)).toHaveLength(1);
    });

    test("issues nothing for a reservation without an invoice, or whose invoice is still live", async () => {
      const unbilled = await requireKit().createPaidReservation();
      await makeCancellation().cancel(
        await cancellationInput(unbilled.reservation.id)
      );
      // Cancelled before invoices were cancelled with reservations: the
      // reservation is cancelled while its invoice stays live.
      const { invoice, reservation } =
        await requireKit().issueReservationInvoice();
      await requireKit().query(
        "update workspace_reservations set reservation_state = 'cancelled', reservation_cancelled_at = now(), cancellation_cause = 'operator' where id = $1",
        [reservation.id]
      );
      const { delivered, restore } = makeRestoration();

      expect(await restore(unbilled.reservation.id)).toMatchObject({
        outcome: "restored",
        invoice: null,
      });
      expect(await restore(reservation.id)).toMatchObject({
        outcome: "restored",
        invoice: null,
      });
      expect(delivered).not.toHaveBeenCalled();
      expect(await readInvoiceChain(unbilled.reservation.id)).toEqual([]);
      expect(
        (await readInvoiceChain(reservation.id)).map(({ id }) => id)
      ).toEqual([invoice.id]);
    });

    test("issues nothing for an invoice an administrator cancelled on its own", async () => {
      const { invoice, reservation } =
        await requireKit().issueReservationInvoice();
      await requireKit().run(
        requireKit().cancel({
          invoiceId: invoice.id,
          actor: await requireKit().makeActor(`invoice-cancel-${invoice.id}`),
        })
      );
      await makeCancellation().cancel(await cancellationInput(reservation.id));
      const { delivered, plan, restore } = makeRestoration();

      expect(await plan(reservation.id)).toEqual({ kind: "not_owed" });
      expect(await restore(reservation.id)).toMatchObject({
        outcome: "restored",
        invoice: null,
      });
      expect(delivered).not.toHaveBeenCalled();
      expect(await readInvoiceChain(reservation.id)).toHaveLength(1);
    });

    test("a failed reissue of a payment invoice keeps the restore and queues it for the paid-fulfillment retry", async () => {
      const { invoice, reservation } = await cancelWithInvoice({
        billing: requestedInvoice,
      });
      const failing = makeRestoration({ billingUpdateFails: true });

      const result = await failing.restore(reservation.id);

      expect(result).toEqual({
        outcome: "restored",
        email: "not_requested",
        access: "not_needed",
        invoice: { outcome: "retrying", invoiceId: null, invoiceNumber: null },
      });
      expect((await readState(reservation.id)).reservation).toBe("confirmed");
      expect(failing.enqueue.mock.calls).toEqual([
        [{ orderId: reservation.id, replacesInvoiceId: invoice.id }],
      ]);
      expect(await readInvoiceChain(reservation.id)).toHaveLength(1);

      // The replacement is still owed, so a rerun of the restore issues it.
      const retry = makeRestoration();
      expect(await retry.restore(reservation.id)).toMatchObject({
        outcome: "already_confirmed",
        invoice: { outcome: "issued" },
      });
      expect(retry.delivered).toHaveBeenCalledTimes(1);
      await expectReplacement(reservation.id, invoice);
    });

    test("a failed reissue of a post-order invoice keeps the restore, isn't queued, and a rerun issues it", async () => {
      const { invoice, reservation } = await cancelWithInvoice();
      const failing = makeRestoration({ billingUpdateFails: true });

      expect(await failing.restore(reservation.id)).toMatchObject({
        outcome: "restored",
        invoice: { outcome: "failed", invoiceId: null, invoiceNumber: null },
      });
      expect((await readState(reservation.id)).reservation).toBe("confirmed");
      // The paid-fulfillment queue issues only from billing frozen at payment.
      expect(failing.enqueue).not.toHaveBeenCalled();

      const retry = makeRestoration();
      expect(await retry.restore(reservation.id)).toMatchObject({
        outcome: "already_confirmed",
        invoice: { outcome: "issued" },
      });
      expect(retry.delivered).toHaveBeenCalledTimes(1);
      await expectReplacement(reservation.id, invoice);
    });
  }
);
