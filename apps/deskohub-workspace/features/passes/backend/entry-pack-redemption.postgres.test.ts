import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposReservationIdSchema } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Schema } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { makeAccountingDocumentSnapshot } from "@/features/accounting/accounting-document-snapshot";
import { AccountingSnapshotKeyService } from "@/features/accounting/backend/accounting-snapshot-key.service";
import { testAccountingStorage } from "@/features/accounting/backend/accounting-storage.test-utils";
import { quoteCoworkEntryPack } from "@/features/checkout/backend/checkout/cowork-checkout-pricing";
import { LatePaymentRecoveryRepository } from "@/features/checkout/backend/repositories/late-payment-recovery.repository";
import { PaymentLifecycleRepository } from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import { paymentAbandonedAfterProviderCutoffFailureCode } from "@/features/checkout/backend/repositories/payment-lifecycle-state";
import { makeDiscountCommitment } from "@/features/discounts/commitment";
import { orderIdSchema } from "@/features/order";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import {
  getStoredWorkspaceReservationDetails,
  reservationOrderId,
} from "@/features/reservation/persistence-contracts";
import { reservationOrderIssuanceSchema } from "@/features/reservation/reservation-order";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  holdPostgresTransaction,
  waitForPostgresLockWaiter,
} from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Entry pack claims on disposable PostgreSQL",
  () => {
    let database: WorkspacePostgresSuiteDatabase;
    const buyer = customerAccountIdSchema.make(crypto.randomUUID());
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    const date = Schema.decodeUnknownSync(plainDateStringSchema);
    const decodeReservation = Schema.decodeUnknownSync(
      reservationOrderIssuanceSchema("CZ")
    );
    const now = () => Temporal.Now.instant();

    beforeAll(async () => {
      database = (await createWorkspacePostgresSuiteDatabase(
        "entry_pack_claims"
      ))!;
      await database.pool.query(
        "insert into customer_accounts (id) values ($1), ($2)",
        [buyer, holder]
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    const seedPack = async () => {
      const passId = orderIdSchema.make(crypto.randomUUID());
      await database.pool.query(
        `insert into orders
          (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at, fulfilled_at)
          values ($1, 'pass-purchase', 'fixture-buyer', 'paid', 'fulfilled', now(), now())`,
        [passId]
      );
      await database.pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
          values ($1, $2, $3, 'entry-pack', 'open-space', 5, 'active', '2099-06-01', '2099-07-01', '{}', 'en-US', now())`,
        [passId, buyer, holder]
      );
      return passId;
    };

    const selection = (serviceDate: string, coffee = false) =>
      decodeReservation({
        kind: "cowork",
        entryTier: "open-space",
        date: serviceDate,
        coffee,
        name: "Synthetic Customer",
        email: testEmailAddress("entry-pack-claim"),
        phone: "+420 700 000 000",
        billing: { purpose: "personal", invoice: "none" },
      });

    const draft = (serviceDate: string, author = holder) =>
      Effect.runPromise(
        workspaceFixtures(database.db).reservation({
          stage: { reservation: "draft" },
          author,
          details: getStoredWorkspaceReservationDetails(selection(serviceDate)),
        })
      );
    const runReservations = (f) =>
      Effect.runPromise(
        WorkspaceReservationRepository.pipe(
          Effect.flatMap(f),
          Effect.provide(WorkspaceReservationRepository.Default),
          Effect.provide(database.layer)
        )
      );
    const claim = (
      reservation,
      passId,
      serviceDate,
      holderAccountId = holder,
      dotyposReservationId = DotyposReservationIdSchema.make(
        crypto.randomUUID()
      )
    ) =>
      runReservations((repository) =>
        repository.claimHoldCreation(reservation.id).pipe(
          Effect.andThen(
            repository.attachHold({
              id: reservation.id,
              dotyposReservationId,
              reservationCreatedAt: now(),
              reservationHoldExpiresAt: now().add({ minutes: 30 }),
              entryPack: {
                passId,
                holderAccountId,
                date: date(serviceDate),
                tier: "open-space",
              },
            })
          ),
          Effect.as(true)
        )
      );
    const status = (reservation) =>
      runReservations((repository) =>
        repository.findEntryPackClaim(reservation.id)
      ).then((entry) => entry?.status);
    const cancelHold = async (reservation) => {
      const cancellation = await runReservations((repository) =>
        repository.claimCancellation({
          id: reservation.id,
          cause: "hold_expired",
        })
      );
      await runReservations((repository) =>
        repository.markCancelled({
          id: reservation.id,
          claimedAt: cancellation!.updatedAt,
          cancelledAt: now(),
        })
      );
    };
    const runRecovery = (f) =>
      Effect.runPromise(
        LatePaymentRecoveryRepository.pipe(
          Effect.flatMap(f),
          Effect.provide(LatePaymentRecoveryRepository.Default),
          Effect.provide(database.layer)
        )
      );
    const startVerifiedRecovery = async (reservation, attempt) => {
      const input = {
        workspaceReservationId: reservation.id,
        paymentAttemptId: attempt.id,
      };
      await runRecovery((repository) =>
        repository.start({
          ...input,
          verifiedPaidAt: now(),
          providerStatus: "EXECUTED",
        })
      );
      await runRecovery((repository) =>
        repository.claim({
          paymentAttemptId: attempt.id,
          staleProcessingBefore: now(),
        })
      );
      return input;
    };

    test("rejects a buyer who is not the holder and the exclusive end date", async () => {
      const passId = await seedPack();
      const buyerDraft = await draft("2099-06-01", buyer);
      const endDateDraft = await draft("2099-07-01");
      await expect(
        claim(buyerDraft, passId, "2099-06-01", buyer)
      ).rejects.toMatchObject({
        _tag: "EntryPackUnavailableError",
      });
      await expect(
        claim(endDateDraft, passId, "2099-07-01")
      ).rejects.toMatchObject({
        _tag: "EntryPackUnavailableError",
      });
      expect(await status(buyerDraft)).toBeUndefined();
      expect(await status(endDateDraft)).toBeUndefined();
    });

    test("serializes the same Prague date across two packs", async () => {
      const serviceDate = "2099-06-03";
      const [first, second] = await Promise.all([
        draft(serviceDate),
        draft(serviceDate),
      ]);
      const [firstPack, secondPack] = await Promise.all([
        seedPack(),
        seedPack(),
      ]);
      const results = await Promise.allSettled([
        claim(first, firstPack, serviceDate),
        claim(second, secondPack, serviceDate),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toEqual([
        { status: "fulfilled", value: true },
      ]);
      const reserved = results[0].status === "fulfilled" ? first : second;
      const rejected = reserved === first ? second : first;
      expect(await status(reserved)).toBe("reserved");
      expect(await status(rejected)).toBeUndefined();
      expect(
        await runReservations((repository) => repository.findById(rejected.id))
      ).toMatchObject({
        reservationState: "creating_hold",
        dotyposReservationId: null,
      });
    });

    test("serializes the last entry of one pack across dates", async () => {
      const passId = await seedPack();
      for (const day of [10, 11, 12, 13]) {
        const serviceDate = `2099-06-${day}`;
        expect(await claim(await draft(serviceDate), passId, serviceDate)).toBe(
          true
        );
      }
      const first = await draft("2099-06-14");
      const second = await draft("2099-06-15");
      const results = await Promise.allSettled([
        claim(first, passId, "2099-06-14"),
        claim(second, passId, "2099-06-15"),
      ]);
      expect(
        results.filter(({ status }) => status === "fulfilled")
      ).toHaveLength(1);
    });

    test("a reservation interrupted before attachment holds no entry", async () => {
      const serviceDate = "2099-06-16";
      const reservation = await draft(serviceDate);
      await runReservations((repository) =>
        repository.claimHoldCreation(reservation.id)
      );
      expect(await status(reservation)).toBeUndefined();
      const second = await draft(serviceDate);
      expect(await claim(second, await seedPack(), serviceDate)).toBe(true);
    });

    test("releases an expired unpaid hold so a replacement can use its entry", async () => {
      const serviceDate = "2099-06-19";
      const reservation = await draft(serviceDate);
      const passId = await seedPack();
      await claim(reservation, passId, serviceDate);
      await cancelHold(reservation);
      expect(await status(reservation)).toBe("released");
      expect(await claim(await draft(serviceDate), passId, serviceDate)).toBe(
        true
      );
    });

    test("returns a reserved entry when an operator cancels its unpaid hold", async () => {
      const serviceDate = "2099-06-18";
      const reservation = await draft(serviceDate);
      await claim(reservation, await seedPack(), serviceDate);
      const cancellation = await runReservations((repository) =>
        repository.claimAdministrationCancellation({
          id: reservation.id,
          staleCancellingBefore: now().subtract({ minutes: 10 }),
        })
      );
      await runReservations((repository) =>
        repository.markAdministrationCancelled({
          id: reservation.id,
          claimedAt: cancellation!.updatedAt,
          cancelledAt: now(),
          failureCode: null,
        })
      );
      expect(await status(reservation)).toBe("released");
    });

    const exercisePayment = async ({ serviceDate, coffee, outcome }) => {
      const passId = await seedPack();
      const reservation = await draft(serviceDate);
      const dotyposReservationId = DotyposReservationIdSchema.make(
        crypto.randomUUID()
      );
      await claim(
        reservation,
        passId,
        serviceDate,
        holder,
        dotyposReservationId
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* PaymentLifecycleRepository;
          const prepared = yield* quoteCoworkEntryPack({
            reservation: selection(serviceDate, coffee),
            entryPack: { passId, tier: "open-space" },
          });
          const orderId = reservationOrderId(reservation.id);
          const payment = {
            orderId,
            amount: prepared.quote.payment.expectedPrice,
            commitment: makeDiscountCommitment({
              firstServiceDate: date(serviceDate),
              product: { kind: "cowork", tier: "open-space" },
              applications: [],
            }),
            locale: "en-US" as const,
            accountingSnapshot: makeAccountingDocumentSnapshot({
              workspaceReservationId: reservation.id,
              dotyposReservationId,
              dotyposCustomerId: reservation.dotyposCustomerId,
              locale: "en-US",
              prepared,
            }),
          };
          if (!coffee)
            return (yield* lifecycle.completeInternalPayment(payment)).attempt;
          const attempt = yield* lifecycle.createPendingProviderAttempt({
            ...payment,
            provider: "nexi",
            providerOrderId: `synthetic-${crypto.randomUUID()}`,
          });
          expect(yield* Effect.promise(() => status(reservation))).toBe(
            "reserved"
          );
          const pending = yield* lifecycle.attachProviderSession({
            id: attempt.id,
            securityToken: "synthetic",
            providerRedirectUrl: "https://payment.example.invalid/",
          });
          if (outcome === "pending") return pending;
          if (outcome === "failed" || outcome === "abandoned") {
            return (yield* lifecycle.markTerminal({
              id: attempt.id,
              orderId,
              state: outcome === "failed" ? "failed" : "expired",
              failureCode:
                outcome === "failed"
                  ? "nexi_payment_failed"
                  : paymentAbandonedAfterProviderCutoffFailureCode,
            })).attempt;
          }
          return (yield* lifecycle.markPaid({
            id: attempt.id,
            orderId,
            paidAt: now(),
          })).attempt;
        }).pipe(
          Effect.provide(
            PaymentLifecycleRepository.Default.pipe(
              Layer.provide(
                Layer.merge(
                  database.layer,
                  testAccountingStorage(
                    database.layer,
                    AccountingSnapshotKeyService.Default
                  )
                )
              )
            )
          )
        )
      );
      return { reservation, result };
    };

    test("spends the entry in the internal zero-total payment", async () => {
      const { reservation, result } = await exercisePayment({
        serviceDate: "2099-06-20",
        coffee: false,
        outcome: "paid",
      });
      expect(result).toMatchObject({ provider: "internal", state: "paid" });
      expect(await status(reservation)).toBe("consumed");
    });

    test("keeps an entry held until paid and only charges the coffee through Nexi", async () => {
      const { reservation, result } = await exercisePayment({
        serviceDate: "2099-06-21",
        coffee: true,
        outcome: "paid",
      });
      expect(result).toMatchObject({
        provider: "nexi",
        state: "paid",
        amount: { value: 5_000 },
      });
      expect(await status(reservation)).toBe("consumed");
    });

    test("releases an entry once Nexi confirms a failed attempt", async () => {
      const { reservation, result } = await exercisePayment({
        serviceDate: "2099-06-22",
        coffee: true,
        outcome: "failed",
      });
      expect(result).toMatchObject({ provider: "nexi", state: "failed" });
      expect(await status(reservation)).toBe("released");
    });

    test("keeps the entry after an empty Nexi order expires until Dotypos cancellation", async () => {
      const { reservation, result } = await exercisePayment({
        serviceDate: "2099-06-25",
        coffee: true,
        outcome: "abandoned",
      });
      expect(result).toMatchObject({ provider: "nexi", state: "expired" });
      expect(await status(reservation)).toBe("reserved");

      await cancelHold(reservation);
      expect(await status(reservation)).toBe("released");
    });

    test("keeps an unresolved Nexi entry through a date replacement request", async () => {
      const serviceDate = "2099-06-23";
      const { reservation, result } = await exercisePayment({
        serviceDate,
        coffee: true,
        outcome: "pending",
      });
      expect(result).toMatchObject({ provider: "nexi", state: "pending" });
      expect(
        await runReservations((repository) =>
          repository.claimSupersessionCancellation(reservation.id)
        )
      ).toBeNull();
      expect(
        await runReservations((repository) =>
          repository.claimCancellation({
            id: reservation.id,
            cause: "hold_expired",
          })
        )
      ).toBeNull();
      const second = await draft(serviceDate);
      await expect(
        claim(second, await seedPack(), serviceDate)
      ).rejects.toMatchObject({
        _tag: "EntryPackUnavailableError",
      });
      expect(await status(reservation)).toBe("reserved");
    });

    test("refunds late money when another pack has already booked the date", async () => {
      const serviceDate = "2099-06-24";
      const { reservation, result } = await exercisePayment({
        serviceDate,
        coffee: true,
        outcome: "failed",
      });
      const second = await draft(serviceDate);
      expect(await claim(second, await seedPack(), serviceDate)).toBe(true);
      const input = await startVerifiedRecovery(reservation, result);
      await expect(
        runRecovery((repository) =>
          repository.completeUsingOriginalReservation({
            ...input,
            completedAt: now(),
            reservationState: "held",
          })
        )
      ).rejects.toMatchObject({ _tag: "EntryPackUnavailableError" });
      await runRecovery((repository) =>
        repository.requireRefund({
          ...input,
          completedAt: now(),
          failureCode: "late_payment_entry_pack_unavailable",
        })
      );
      expect(
        await runRecovery((repository) =>
          repository.findByPaymentAttemptId(result.id)
        )
      ).toMatchObject({ state: "refund_required" });
      expect(await status(reservation)).toBe("released");
      expect(await status(second)).toBe("reserved");
    });

    test("settles a late payment without deadlocking a retry in the same checkout session", async () => {
      const older = await exercisePayment({
        serviceDate: "2099-06-26",
        coffee: true,
        outcome: "failed",
      });
      await cancelHold(older.reservation);
      const newer = await exercisePayment({
        serviceDate: "2099-06-27",
        coffee: true,
        outcome: "failed",
      });
      await cancelHold(newer.reservation);
      await database.pool.query(
        "update workspace_reservations set checkout_session_key = $1 where id = $2",
        [older.reservation.checkoutSessionKey, newer.reservation.id]
      );
      const input = await startVerifiedRecovery(
        older.reservation,
        older.result
      );
      const oldClaim = await runReservations((repository) =>
        repository.findEntryPackClaim(older.reservation.id)
      );
      const blocker = await holdPostgresTransaction(
        database.pool,
        "select id from pass_purchases where id = $1 for no key update",
        [oldClaim!.passId]
      );
      const recovery = runRecovery((repository) =>
        repository.completeWithReplacement({
          ...input,
          recoveredDotyposReservationId: DotyposReservationIdSchema.make(
            crypto.randomUUID()
          ),
          reservationState: "held",
          completedAt: now(),
        })
      ).then(
        () => "recovered",
        (failure) => failure
      );
      let retry: Promise<unknown> | undefined;
      try {
        const blockedBy = "$1 = any(pg_blocking_pids(pid))";
        await waitForPostgresLockWaiter(database.pool, {
          condition: blockedBy,
          values: [blocker.pid],
          description: "late settlement to wait on the pass row",
        });
        const {
          rows: [waiting],
        } = await database.pool.query(
          `select pid from pg_locks where not granted and ${blockedBy}`,
          [blocker.pid]
        );
        retry = runReservations((repository) =>
          repository.attachRetryHold({
            id: newer.reservation.id,
            retriedAttemptId: newer.result.id,
            dotyposReservationId: DotyposReservationIdSchema.make(
              crypto.randomUUID()
            ),
            reservationHoldExpiresAt: now().add({ minutes: 30 }),
          })
        ).then(
          (attached) => attached,
          (failure) => failure
        );
        await waitForPostgresLockWaiter(database.pool, {
          condition: blockedBy,
          values: [waiting!.pid],
          description: "the checkout retry to wait on the late settlement",
        });
      } finally {
        await blocker.commit();
      }
      expect(await recovery).toBe("recovered");
      expect(await retry).toMatchObject({
        _tag: "WorkspaceReservationSessionTakenError",
      });
      expect(await status(older.reservation)).toBe("consumed");
      expect(await status(newer.reservation)).toBe("released");

      const losingRecovery = await startVerifiedRecovery(
        newer.reservation,
        newer.result
      );
      await expect(
        runRecovery((repository) =>
          repository.completeWithReplacement({
            ...losingRecovery,
            recoveredDotyposReservationId: DotyposReservationIdSchema.make(
              crypto.randomUUID()
            ),
            reservationState: "confirmed",
            completedAt: now(),
          })
        )
      ).rejects.toMatchObject({ _tag: "LatePaymentRecoverySessionTakenError" });
      expect(await status(newer.reservation)).toBe("released");
    });
  }
);
