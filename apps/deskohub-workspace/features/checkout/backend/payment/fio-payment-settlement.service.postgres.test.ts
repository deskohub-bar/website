import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import {
  paymentAttempts,
  reservationPaymentWindows,
  workspaceReservations,
} from "@/db/schema";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  requireTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { FioAccounts } from "../fio/fio-accounts.service";
import {
  PaidFulfillmentQueueError,
  PaidFulfillmentQueueService,
} from "../fulfillment/paid-fulfillment-queue.service";
import { FioPaymentSettlementRepository } from "../repositories/fio-payment-settlement.repository";
import { PaymentLifecycleRepository } from "../repositories/payment-lifecycle.repository";
import { QrPaymentRepository } from "../repositories/qr-payment.repository";
import {
  FioPaymentSettlementService,
  type VerifiedFioMovement,
} from "./fio-payment-settlement.service";
import { LatePaymentRecoveryQueueService } from "./late-payment-recovery-queue.service";

const database = await createWorkspacePostgresSuiteDatabase("fio_settlement");
afterAll(() => database?.close());

const accountKey = "settlement-test-account";
const account = { accountNumber: "1234567890", bankCode: "2010" };
const movement = {
  accountKey,
  movementId: "foreign-credit",
  constantSymbol: null,
  variableSymbol: null,
  referenceStatus: "invalid",
  amount: { _tag: "OtherCurrency", currency: "EUR", decimalAmount: "100.2500" },
  bookingDate: Temporal.PlainDate.from("2026-11-18"),
  observedAt: Temporal.Instant.from("2026-11-19T09:00:00Z"),
} satisfies VerifiedFioMovement;

const runSettlement = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FioPaymentSettlementService
    | QrPaymentRepository
    | FioPaymentSettlementRepository
  >,
  fulfillmentQueue: Partial<PaidFulfillmentQueueService["Service"]> = {}
) => {
  const databaseLayer = requireTestDatabase(database).layer;
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FioPaymentSettlementService.Default.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              databaseLayer,
              FioPaymentSettlementRepository.Default.pipe(
                Layer.provide(databaseLayer)
              ),
              Layer.mock(FioAccounts, {
                getReceivingAccount: (key) =>
                  key === accountKey
                    ? {
                        accountKey,
                        account,
                        readToken: Redacted.make("synthetic-fio-token"),
                      }
                    : undefined,
                getDefaultReceivingAccount: () => ({ accountKey, ...account }),
                getReceivingAccountDisplay: (key) =>
                  key === accountKey ? { accountKey, ...account } : undefined,
              }),
              QrPaymentRepository.Default.pipe(Layer.provide(databaseLayer)),
              PaymentLifecycleRepository.Default.pipe(
                Layer.provide(
                  Layer.merge(
                    databaseLayer,
                    Layer.mock(AccountingDocumentSnapshots, {})
                  )
                )
              ),
              Layer.mock(PaidFulfillmentQueueService, fulfillmentQueue),
              Layer.mock(LatePaymentRecoveryQueueService, {})
            )
          )
        )
      )
    )
  );
};

describe.skipIf(!database)("verified Fio movement ingress", () => {
  test("retains the original decimal and records an invalid reference at account scope", async () => {
    const rows = await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* settlements.recordMovement(movement);
        return yield* settlements.listForAccount({ accountKey });
      })
    );

    expect(rows).toMatchObject([
      {
        movementId: "foreign-credit",
        orderId: null,
        paymentAttemptId: null,
        variableSymbol: null,
        currency: "EUR",
        amountValue: null,
        decimalAmount: "100.2500",
        bookingDate: "2026-11-18",
        disposition: "discrepancy",
        discrepancyReason: "reference_invalid",
      },
    ]);
  });

  test("keeps unmatched card payouts out of settlement evidence and the staff queue", async () => {
    const ignoredPayouts = [
      { movementId: "payout-unmatched", variableSymbol: "966220031" },
      { movementId: "payout-absent", variableSymbol: null },
      { movementId: "payout-invalid", variableSymbol: "invalid" },
    ];
    const otherTransfer = {
      ...movement,
      movementId: "unmatched-other-constant-symbol",
      constantSymbol: "0308",
      variableSymbol: "966220032",
    };
    const { accountRows, staffRows } = await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* settlements.recordMovement(otherTransfer);
        for (const payout of ignoredPayouts) {
          yield* settlements.recordMovement({
            accountKey,
            ...payout,
            constantSymbol: "0558",
            amount: { _tag: "CZK", minorUnits: 10_000 },
            bookingDate: movement.bookingDate,
            observedAt: movement.observedAt,
          });
        }
        const staffRepository = yield* FioPaymentSettlementRepository;
        return {
          accountRows: yield* settlements.listForAccount({ accountKey }),
          staffRows: yield* staffRepository.listForStaff({ kind: "unmatched" }),
        };
      })
    );

    const recordedTransfer = expect.objectContaining({
      movementId: otherTransfer.movementId,
      discrepancyReason: "reference_unmatched",
    });
    for (const rows of [accountRows, staffRows]) {
      expect(rows).toContainEqual(recordedTransfer);
      for (const { movementId } of ignoredPayouts) {
        expect(rows).not.toContainEqual(
          expect.objectContaining({ movementId })
        );
      }
    }
  });

  test("ignores movements from an unconfigured receiving account", async () => {
    const unconfiguredAccount = "other-settlement-test-account";
    const rows = await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* settlements.recordMovement({
          ...movement,
          accountKey: unconfiguredAccount,
        });
        return yield* settlements.listForAccount({
          accountKey: unconfiguredAccount,
        });
      })
    );

    expect(rows).toEqual([]);
  });

  test("keeps a single immutable evidence row when an overlapping poll repeats a movement", async () => {
    const replayed = { ...movement, movementId: "overlapping-credit" };
    const rows = await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* Effect.all(
          [
            settlements.recordMovement(replayed),
            settlements.recordMovement(replayed),
          ],
          { concurrency: 2 }
        );
        yield* settlements.recordMovement({
          ...replayed,
          amount: { _tag: "CZK", minorUnits: 75 },
          observedAt: movement.observedAt.add({ hours: 4 }),
        });
        const evidence = yield* settlements.listForAccount({ accountKey });
        return evidence.filter((row) => row.movementId === replayed.movementId);
      })
    );

    expect(rows).toMatchObject([
      {
        currency: "EUR",
        decimalAmount: "100.2500",
        observedAt: movement.observedAt,
      },
    ]);
  });

  test("retries a failed fulfillment publication after the final payable attempt settles", async () => {
    const { orderId, variableSymbol } = await createQrReservation();
    const credit = {
      accountKey,
      movementId: "winner-credit",
      constantSymbol: "0558",
      variableSymbol,
      amount: { _tag: "CZK", minorUnits: 14_500 },
      bookingDate: movement.bookingDate,
      observedAt: movement.observedAt,
    } satisfies VerifiedFioMovement;
    const publications: string[] = [];
    const fulfillmentQueue: Partial<PaidFulfillmentQueueService["Service"]> = {
      enqueue: ({ orderId: reservationId }) => {
        publications.push(reservationId);
        return publications.length === 1
          ? Effect.fail(
              new PaidFulfillmentQueueError({ message: "Queue offline" })
            )
          : Effect.void;
      },
    };
    const publishCredit = Effect.flatMap(
      FioPaymentSettlementService,
      (settlements) => settlements.recordMovement(credit)
    );

    const firstPublication = await runSettlement(
      Effect.exit(publishCredit),
      fulfillmentQueue
    );
    expect(firstPublication._tag).toBe("Failure");
    const recorded = await runSettlement(
      Effect.flatMap(FioPaymentSettlementService, (settlements) =>
        settlements.listForOrder(orderId)
      )
    );
    expect(recorded).toMatchObject([
      {
        movementId: "winner-credit",
        disposition: "winner",
        amountValue: 14_500,
      },
    ]);

    const hasPayable = await runSettlement(
      Effect.flatMap(QrPaymentRepository, (qr) =>
        qr.hasPayableAttempts(accountKey)
      )
    );
    expect(hasPayable).toBe(false);
    await runSettlement(
      Effect.flatMap(FioPaymentSettlementService, (settlements) =>
        settlements.retryPendingDispatch(accountKey)
      ),
      fulfillmentQueue
    );
    expect(publications).toEqual([orderId, orderId]);

    await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* settlements.recordMovement({
          ...credit,
          movementId: "duplicate-credit",
        });
        yield* settlements.recordMovement({
          ...credit,
          movementId: "short-credit",
          amount: { _tag: "CZK", minorUnits: 500 },
        });
        yield* settlements.recordMovement({
          ...credit,
          movementId: "unknown-reference",
          constantSymbol: null,
          variableSymbol: "1111111111",
        });
        const linked = yield* settlements.listForOrder(orderId);
        expect(linked).toMatchObject([
          {
            movementId: "short-credit",
            disposition: "discrepancy",
            discrepancyReason: "amount_mismatch",
          },
          { movementId: "duplicate-credit", disposition: "refund_required" },
          { movementId: "winner-credit", disposition: "winner" },
        ]);
        const staffRepository = yield* FioPaymentSettlementRepository;
        const staffRefunds = yield* staffRepository.listForStaff({
          kind: "refund_required",
        });
        expect(
          staffRefunds.some(
            (row) =>
              row.orderId === orderId && row.movementId === "duplicate-credit"
          )
        ).toBe(true);
        const staffUnmatched = yield* staffRepository.listForStaff({
          kind: "unmatched",
        });
        expect(staffUnmatched.length).toBeGreaterThan(0);
        expect(
          staffUnmatched.every(
            (row) => row.orderId === null && row.disposition === "discrepancy"
          )
        ).toBe(true);

        const unlinked = yield* settlements.listForAccount({
          accountKey,
          unlinkedOnly: true,
        });
        expect(unlinked).toContainEqual(
          expect.objectContaining({
            movementId: "unknown-reference",
            discrepancyReason: "reference_unmatched",
          })
        );
        expect(
          unlinked.every(
            (row) => row.orderId === null && row.disposition === "discrepancy"
          )
        ).toBe(true);

        const refund = requireValue(
          linked.find((row) => row.movementId === "duplicate-credit"),
          "duplicate credit"
        );
        const refundedAt = credit.observedAt.add({ hours: 1 });
        yield* settlements.markManualRefunded(refund.id, refundedAt);
        const recordedRefund = yield* settlements.markManualRefunded(
          refund.id,
          refundedAt.add({ hours: 1 })
        );
        expect(recordedRefund).toMatchObject({
          disposition: "refunded",
          refundedAt,
        });
      })
    );
  });
});

const createQrReservation = () => {
  const db = requireTestDatabase(database).db;
  return Effect.runPromise(
    Effect.gen(function* () {
      const reservation = yield* workspaceFixtures(db).reservation({
        stage: { reservation: "held", payment: "pending" },
        at: movement.observedAt,
      });
      const orderId = standaloneReservationOrderId(reservation.id);
      const variableSymbol = "1234567890";
      const [insertedAttempt] = yield* db
        .insert(paymentAttempts)
        .values({
          orderId,
          workspaceReservationId: reservation.id,
          provider: "fio",
          providerOrderId: variableSymbol,
          state: "pending",
          currency: "CZK",
          amountValue: 14_500,
          amountExponent: 2,
        })
        .returning();
      const attempt = requireValue(insertedAttempt, "inserted Fio attempt");
      yield* db
        .update(workspaceReservations)
        .set({ activePaymentAttemptId: attempt.id })
        .where(eq(workspaceReservations.id, reservation.id));
      yield* db.insert(reservationPaymentWindows).values({
        orderId,
        accountKey,
        qrAttemptId: attempt.id,
        expiresAt: movement.observedAt.add({ minutes: 30 }),
      });
      return { orderId, variableSymbol };
    })
  );
};
