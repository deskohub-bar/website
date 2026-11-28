import { afterAll, describe, expect, test } from "bun:test";
import { type DotyposReservationId, DotyposService } from "@deskohub/dotypos";
import {
  EmailConfigTag,
  EmailServiceTag,
} from "@deskohub/email/backend/service";
import type { EmailMessage } from "@deskohub/email/types/email.types";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { attachPaymentProviderSession } from "@/features/checkout/backend/repositories/payment-attempt-writes";
import { PaymentRefundRepository } from "@/features/checkout/backend/repositories/payment-refund.repository";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { m } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import { ReservationCancellation } from "@/features/reservation/backend/reservation-cancellation.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceReservationService } from "@/features/reservation/backend/workspace-reservation.service";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { WithdrawalRepository } from "@/features/withdrawal/backend/withdrawal.repository";
import { WithdrawalEmails } from "@/features/withdrawal/backend/withdrawal-emails.service";
import { staffLocale } from "@/shared/backend/staff-locale";
import { currencyCZK } from "@/shared/money/currencies";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { waitForPostgresLockWaiter } from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { applyPackAdjustment } from "../admin/apply-pass-adjustment";
import { consumeEntryPackClaim } from "./entry-pack-redemption";
import { EntryPackWithdrawals } from "./entry-pack-withdrawals";

const database = await createWorkspacePostgresSuiteDatabase(
  "entry_pack_withdrawals"
);
afterAll(() => database?.close());

const delivered = "2027-03-25T08:00:00Z";
// 23:20 UTC is already March 28 in Prague.
const submittedAt = Temporal.Instant.from("2027-03-27T23:20:00Z");
const instant = Temporal.Instant.from;

describe.skipIf(!database)("Entry pack withdrawals on Postgres", () => {
  if (!database) return;
  const { pool } = database;
  const providerStatuses = new Map<string, string>();
  const providerFailures = new Set<string>();
  const providerCalls: string[] = [];
  const providerReservations = new Map<
    string,
    {
      readonly dotyposReservationId: DotyposReservationId;
      readonly reservedFrom?: Temporal.Instant;
      readonly reservedUntil?: Temporal.Instant;
    }
  >();
  const getProviderReservation = (id: string) => {
    const reservation = providerReservations.get(id);
    if (!reservation) throw new Error(`Missing provider reservation for ${id}`);
    return reservation;
  };
  const reservationDetails = Layer.mock(WorkspaceReservationService, {
    getReservation: (id) => {
      const reservation = getProviderReservation(id);
      return Effect.succeed({
        ...reservation,
        providerStatus:
          providerStatuses.get(reservation.dotyposReservationId) ?? "CONFIRMED",
      });
    },
  });
  const storage = Layer.mergeAll(
    database.layer,
    WorkspaceDatabaseAdvisoryLock.makeLayer(database.databasePool),
    WithdrawalRepository.Default.pipe(Layer.provide(database.layer)),
    PaymentRefundRepository.Default.pipe(Layer.provide(database.layer)),
    WorkspaceReservationRepository.Default.pipe(Layer.provide(database.layer))
  );
  const cancellation = ReservationCancellation.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        storage,
        Layer.mock(DotyposService, {
          cancelReservation: (id) =>
            Effect.suspend(() => {
              providerCalls.push(id);
              if (providerFailures.delete(id)) {
                return Effect.fail(new Error("Synthetic provider failure"));
              }
              providerStatuses.set(id, "CANCELLED");
              return Effect.void;
            }),
        }),
        reservationDetails
      )
    )
  );
  const snapshots = new Map<string, unknown>();
  const layer = EntryPackWithdrawals.Default.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        storage,
        cancellation,
        reservationDetails,
        Layer.mock(AccountingDocumentSnapshots, {
          findPassPurchase: (id) => Effect.succeed(snapshots.get(id)),
        })
      )
    )
  );
  const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

  const seed = async ({
    paid = 100_119,
    delivery = delivered,
    purpose = "personal",
    earlyStart = true,
    tier: passTier = "open-space",
  } = {}) => {
    const buyer = customerAccountIdSchema.make(crypto.randomUUID());
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    const id = orderIdSchema.make(crypto.randomUUID());
    const attempt = paymentAttemptIdSchema.make(crypto.randomUUID());
    await pool.query("insert into customer_accounts (id) values ($1), ($2)", [
      buyer,
      holder,
    ]);
    await pool.query(
      `insert into orders (id, kind, dotypos_customer_id, payment_state,
         fulfillment_state, paid_at, fulfilled_at, active_payment_attempt_id)
       values ($1, 'pass-purchase', '1', 'paid', 'fulfilled', $2, $2, $3)`,
      [id, delivered, attempt]
    );
    await pool.query(
      `insert into payment_attempts (id, order_id, provider, state,
         provider_order_id, amount_value, amount_exponent, currency)
       values ($1, $2, $3, 'paid', $4, $5, 2, 'CZK')`,
      [
        attempt,
        id,
        paid === 0 ? "internal" : "nexi",
        paid === 0 ? null : attempt,
        paid,
      ]
    );
    await pool.query(
      `insert into pass_purchases (id, buyer_account_id, holder_account_id, product,
         tier, entry_count, status, valid_from, valid_until, quote, locale,
         created_at, buyer_confirmation_delivered_at)
       values ($1, $2, $3, 'entry-pack', $6, 5, 'active', '2027-03-25',
         '2027-05-25', '{}', 'en-US', $4, $5)`,
      [id, buyer, holder, delivered, delivery, passTier]
    );
    await pool.query(
      `insert into legal_evidence_events (order_id, document_key, document_path,
         document_hash, hash_algorithm, accepted, accepted_at, locale, source, acknowledgements)
       values ($1,'termsAndConditions','/terms','test','sha256',true,$2,'en-US','payment_submit',$3)`,
      [
        id,
        delivered,
        earlyStart
          ? {
              earlyPerformanceConsent: true,
              entryPackEarlyStartRequested: true,
            }
          : {},
      ]
    );
    snapshots.set(attempt, {
      orderId: id,
      product: { kind: "entry-pack" },
      billing: { purpose },
    });
    return { id, attempt, buyer, holder, tier: passTier };
  };

  const addClaim = async (
    pack: Awaited<ReturnType<typeof seed>>,
    date: string,
    status: "reserved" | "consumed",
    stay: "day" | "overnight" = "day"
  ) => {
    const reservation = await run(
      workspaceFixtures(database.db).reservation({
        author: pack.holder,
        at: instant(delivered),
        stage:
          status === "consumed"
            ? {
                reservation: "confirmed",
                payment: "paid",
                fulfillment: "fulfilled",
              }
            : { reservation: "held" },
      })
    );
    await pool.query(
      "insert into pass_entry_claims (reservation_id, pass_id, date, status) values ($1,$2,$3,$4)",
      [reservation.id, pack.id, date, status]
    );
    const { dotyposReservationId } = reservation;
    if (!dotyposReservationId) {
      throw new Error(
        "An Entry Pack claim fixture requires a provider reservation"
      );
    }
    const interval =
      pack.tier === "open-space"
        ? undefined
        : getCoworkReservationInterval(pack.tier, date, stay);
    providerReservations.set(reservation.id, {
      dotyposReservationId,
      ...(interval && {
        reservedFrom: instant(interval.startsAt),
        reservedUntil: instant(interval.endsAt),
      }),
    });
    return reservation.id;
  };

  const find = (
    id: string,
    accountId: string,
    locale = "en-US",
    assessedAt?: Temporal.Instant
  ) =>
    run(
      Effect.flatMap(EntryPackWithdrawals, (family) =>
        family.find({ contractId: id, accountId, locale, assessedAt })
      )
    );

  const statement = async (
    pack: Awaited<ReturnType<typeof seed>>,
    now = submittedAt,
    locale = "en-US" as const
  ) => {
    const contract = Option.getOrThrow(
      await find(pack.id, pack.buyer, locale, now)
    );
    const assessment = contract.assess(now);
    if (!assessment.withdrawable) throw new Error(assessment.reason);
    return {
      contract: contract.ref,
      accountId: pack.buyer,
      locale,
      contractLabel: contract.label,
      statementName: "Synthetic Buyer",
      submittedAt: now,
      periodEndsAt: assessment.periodEndsAt,
      paidAmount: contract.paidAmount,
      refundAmount: assessment.refundAmount,
      refundBasis: assessment.refundBasis,
      bookingIntervals: contract.bookingIntervals,
    };
  };

  const recordEffect = (input: Awaited<ReturnType<typeof statement>>) =>
    Effect.flatMap(WithdrawalRepository, (repository) =>
      repository.record(input)
    );

  const cancel = (input: Awaited<ReturnType<typeof statement>>) =>
    Effect.flatMap(EntryPackWithdrawals, (family) =>
      family.cancel({
        contractId: input.contract.id,
        refundAmount: input.refundAmount,
        refundBasis: input.refundBasis,
      })
    );

  const payment = async (id: string) =>
    (
      await pool.query(
        `select refund_state, refund_target_value, refunded_amount_value
       from payment_attempts where id=$1`,
        [id]
      )
    ).rows[0];

  const providerRefund = (id: string, total: number) =>
    run(
      Effect.flatMap(PaymentRefundRepository, (refunds) =>
        refunds.recordRefund({
          id,
          refundedAmountValue: total,
          refundedAt: submittedAt,
          recordedAt: submittedAt,
        })
      )
    );

  const claim = async (id: string) =>
    (
      await pool.query(
        `select pass_entry_claims.status, reservation_state, cancellation_cause
       from pass_entry_claims join workspace_reservations
         on workspace_reservations.id=pass_entry_claims.reservation_id
       where workspace_reservations.id=$1`,
        [id]
      )
    ).rows[0];

  test("counts past and Prague submission-day bookings, and retries only unfinished future cancellations", async () => {
    const pack = await seed();
    const past = await addClaim(pack, "2027-03-26", "consumed");
    const today = await addClaim(pack, "2027-03-28", "consumed");
    const future = await addClaim(pack, "2027-03-29", "consumed");
    const retry = await addClaim(pack, "2027-03-30", "consumed");
    const reserved = await addClaim(pack, "2027-03-31", "reserved");
    const futureProviderId =
      getProviderReservation(future).dotyposReservationId;
    const retryProviderId = getProviderReservation(retry).dotyposReservationId;
    providerFailures.add(retryProviderId);

    expect(Option.isNone(await find(pack.id, pack.holder))).toBe(true);
    const localized = Option.getOrThrow(
      await find(pack.id, pack.buyer, "cs-CZ")
    );
    expect(localized.label).not.toMatch(/Entry pack/);
    const input = await statement(pack);
    expect(input.refundBasis).toEqual({
      kind: "partial",
      unit: "entry",
      unstarted: 3,
      total: 5,
    });
    expect(input.refundAmount).toEqual(currencyCZK(60_000));

    const repeated = await Promise.all([
      run(recordEffect(input)),
      run(recordEffect(input)),
    ]);
    expect(repeated.filter(({ recorded }) => recorded)).toHaveLength(1);
    expect(repeated[0].withdrawal.id).toBe(repeated[1].withdrawal.id);
    expect(await payment(pack.attempt)).toMatchObject({
      refund_state: "required",
      refund_target_value: 60_000,
    });

    expect((await run(Effect.flip(cancel(input)))).code).toBe(
      "entry_pack_bookings_release_failed"
    );
    expect(await claim(future)).toEqual({
      status: "released",
      reservation_state: "cancelled",
      cancellation_cause: "customer_withdrawal",
    });
    expect(await claim(retry)).toMatchObject({
      status: "consumed",
      reservation_state: "cancellation_failed",
    });
    await run(cancel(input));
    await run(cancel(input));
    for (const id of [past, today]) {
      expect(await claim(id)).toMatchObject({
        status: "consumed",
        reservation_state: "confirmed",
      });
      expect(providerCalls).not.toContain(
        getProviderReservation(id).dotyposReservationId
      );
    }
    for (const id of [future, retry, reserved]) {
      expect(await claim(id)).toEqual({
        status: "released",
        reservation_state: "cancelled",
        cancellation_cause: "customer_withdrawal",
      });
    }
    expect(providerCalls.filter((id) => id === futureProviderId)).toHaveLength(
      1
    );
    expect(providerCalls.filter((id) => id === retryProviderId)).toHaveLength(
      2
    );
  });

  test("opens on verified delivery and closes after the extended final day", async () => {
    const delivery = instant("2027-03-27T08:00:00Z");
    const cutoff = instant("2027-04-12T22:00:00Z");
    const pack = await seed({ delivery: delivery.toString() });
    const contract = Option.getOrThrow(await find(pack.id, pack.buyer));
    expect(contract.assess(delivery.subtract({ nanoseconds: 1 }))).toEqual({
      withdrawable: false,
      reason: "not_withdrawable",
    });
    expect(contract.assess(delivery)).toMatchObject({
      withdrawable: true,
      refundAmount: currencyCZK(100_119),
      periodEndsAt: cutoff,
    });
    expect(
      contract.assess(cutoff.subtract({ milliseconds: 1 })).withdrawable
    ).toBe(true);
    expect(contract.assess(cutoff)).toEqual({
      withdrawable: false,
      reason: "period_ended",
    });

    for (const [options, reason] of [
      [{ delivery: null }, "not_withdrawable"],
      [{ purpose: "business" }, "business_purpose"],
    ] as const) {
      const blocked = await seed(options);
      expect(
        Option.getOrThrow(await find(blocked.id, blocked.buyer)).assess(
          submittedAt
        )
      ).toEqual({
        withdrawable: false,
        reason,
      });
    }
  });

  test("does not charge for a past booking cancelled before its service date", async () => {
    const pack = await seed();
    const reservationId = await addClaim(pack, "2027-03-26", "consumed");
    await pool.query(
      `update workspace_reservations set reservation_state='cancelled',
        cancellation_cause='operator', reservation_cancelled_at=$2 where id=$1`,
      [reservationId, delivered]
    );
    const input = await statement(pack);
    expect(input.refundBasis).toEqual({ kind: "full" });
    expect(input.refundAmount).toEqual(currencyCZK(100_119));
    await run(recordEffect(input));
  });

  test("can record a zero refund before the final booked service ends", async () => {
    const pack = await seed();
    for (const day of [25, 26, 27, 28, 29]) {
      await addClaim(pack, `2027-03-${day}`, "consumed");
    }
    await pool.query(
      "update pass_purchases set status='depleted' where id=$1",
      [pack.id]
    );
    const contract = Option.getOrThrow(await find(pack.id, pack.buyer));
    expect(contract.assess(instant("2027-03-29T15:00:00Z"))).toEqual({
      withdrawable: false,
      reason: "performance_started",
    });
    const input = await statement(pack, instant("2027-03-29T14:59:59.999999Z"));
    expect(input.refundBasis).toEqual({
      kind: "partial",
      unit: "entry",
      unstarted: 0,
      total: 5,
    });
    expect(input.refundAmount.value).toBe(0);
    await run(recordEffect(input));
    expect(await payment(pack.attempt)).toMatchObject({
      refund_state: "not_required",
      refund_target_value: null,
    });
  });

  test("serializes spending and rechecks the offered refund basis even at zero price", async () => {
    const pack = await seed({ paid: 0 });
    const reservationId = await addClaim(pack, "2027-03-28", "reserved");
    const input = await statement(pack);
    const consumed = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const spending = run(
      WorkspaceDatabase.use(({ transaction }) =>
        transaction(
          consumeEntryPackClaim(reservationId).pipe(
            Effect.tap(() => Effect.sync(() => consumed.resolve())),
            Effect.andThen(Effect.promise(() => commit.promise))
          )
        )
      )
    );
    await consumed.promise;
    const withdrawal = run(Effect.flip(recordEffect(input)));
    try {
      await waitForPostgresLockWaiter(pool, {
        condition: "locktype = 'transactionid'",
        description: "withdrawal waiting for the entry spend",
      });
    } finally {
      commit.resolve();
      await spending;
    }
    expect((await withdrawal)._tag).toBe("WithdrawalContractChangedError");
    const refreshed = await statement(pack);
    expect(refreshed.refundBasis).toEqual({
      kind: "partial",
      unit: "entry",
      unstarted: 4,
      total: 5,
    });
    expect(refreshed.refundAmount.value).toBe(0);
    await run(recordEffect(refreshed));
    expect(await payment(pack.attempt)).toMatchObject({
      refund_state: "not_required",
      refund_target_value: null,
    });
  });

  test("prevents a reserved entry settling after the withdrawal has won", async () => {
    const pack = await seed();
    const reservationId = await addClaim(pack, "2027-03-28", "reserved");
    const input = await statement(pack);
    await run(recordEffect(input));
    const result = await run(
      Effect.flip(
        WorkspaceDatabase.use(({ transaction }) =>
          transaction(consumeEntryPackClaim(reservationId))
        )
      )
    );
    expect(result._tag).toBe("EntryPackUnavailableError");
    await run(cancel(input));
    expect(await claim(reservationId)).toMatchObject({
      status: "released",
      reservation_state: "cancelled",
    });
  });

  test("retains a pending add-on hold until its provider session can be attached", async () => {
    const pack = await seed();
    const reservationId = await addClaim(pack, "2027-03-28", "reserved");
    const attempt = paymentAttemptIdSchema.make(crypto.randomUUID());
    await pool.query(
      `insert into payment_attempts (id, workspace_reservation_id, order_id, provider,
        provider_order_id, state, amount_value, amount_exponent, currency)
       values ($1, $2, $2, 'nexi', $1, 'created', 12000, 2, 'CZK')`,
      [attempt, reservationId]
    );
    await pool.query(
      `update workspace_reservations set payment_state='pending',
        active_payment_attempt_id=$2 where id=$1`,
      [reservationId, attempt]
    );
    const input = await statement(pack);
    expect(input.refundBasis).toEqual({ kind: "full" });
    await run(recordEffect(input));
    expect((await run(Effect.flip(cancel(input)))).code).toBe(
      "entry_pack_bookings_release_failed"
    );
    expect(await claim(reservationId)).toMatchObject({
      status: "reserved",
      reservation_state: "held",
    });
    expect(providerCalls).not.toContain(
      getProviderReservation(reservationId).dotyposReservationId
    );
    await run(
      attachPaymentProviderSession({
        id: attempt,
        securityToken: "synthetic-session",
        providerRedirectUrl: "https://provider.example.test/checkout",
      })
    );
    await run(cancel(input));
    const cancelled = await pool.query(
      "select state, refund_state from payment_attempts where id=$1",
      [attempt]
    );
    expect(cancelled.rows).toEqual([
      { state: "cancelled", refund_state: "not_required" },
    ]);
    expect(await claim(reservationId)).toEqual({
      status: "released",
      reservation_state: "cancelled",
      cancellation_cause: "customer_withdrawal",
    });
  });

  test("only one of the buyer withdrawal and operator cancellation can win", async () => {
    const pack = await seed();
    const input = await statement(pack);
    const operator = applyPackAdjustment({
      passId: pack.id,
      requestId: crypto.randomUUID(),
      reason: "Synthetic cancellation",
      change: {
        _tag: "cancel",
        expectedValidUntil: plainDateStringSchema.make("2027-05-25"),
        refundValue: 20_000,
        sendCancellationEmail: false,
      },
    }).pipe(
      Effect.provideService(CurrentAdministrator, {
        accountId: pack.buyer,
        email: testEmailAddress("withdrawal-operator"),
      })
    );
    const [buyerResult, operatorResult] = await Promise.all([
      run(Effect.result(recordEffect(input))),
      run(Effect.result(operator)),
    ]);
    expect(
      [buyerResult, operatorResult].map(({ _tag }) => _tag).sort()
    ).toEqual(["Failure", "Success"]);
    expect(await payment(pack.attempt)).toMatchObject({
      refund_state: "required",
      refund_target_value: buyerResult._tag === "Success" ? 100_119 : 20_000,
    });
  });

  test("uses the actual overnight start and end for retained entries", async () => {
    const pack = await seed({ tier: "reserved-desk" });
    const cancelled = await addClaim(
      pack,
      "2027-03-26",
      "consumed",
      "overnight"
    );
    await pool.query(
      `update workspace_reservations set reservation_state='cancelled',
        cancellation_cause='operator', reservation_cancelled_at=$2 where id=$1`,
      [cancelled, "2027-03-26T07:00:00Z"]
    );
    const beforeService = await statement(pack);
    expect(beforeService.refundBasis).toEqual({ kind: "full" });
    await run(recordEffect(beforeService));

    const depleted = await seed({ tier: "reserved-desk" });
    for (const day of [25, 26, 27, 28, 29]) {
      await addClaim(
        depleted,
        `2027-03-${day}`,
        "consumed",
        day === 29 ? "overnight" : "day"
      );
    }
    await pool.query(
      "update pass_purchases set status='depleted' where id=$1",
      [depleted.id]
    );
    const overnight = Option.getOrThrow(
      await find(depleted.id, depleted.buyer)
    );
    expect(overnight.assess(instant("2027-03-30T10:00:00Z"))).toEqual({
      withdrawable: false,
      reason: "performance_started",
    });
    const accepted = await statement(depleted, instant("2027-03-30T07:00:00Z"));
    expect(accepted.refundAmount.value).toBe(0);
    expect((await run(recordEffect(accepted))).recorded).toBe(true);
  });

  test.each([true, false])(
    "reconciles the full paid add-on when a partial refund arrives before cancellation: %s",
    async (refundBeforeCancellation) => {
      const pack = await seed();
      const reservationId = await addClaim(pack, "2027-03-30", "consumed");
      const attempt = paymentAttemptIdSchema.make(crypto.randomUUID());
      await pool.query(
        `insert into payment_attempts (id, workspace_reservation_id, order_id, provider,
        provider_order_id, state, amount_value, amount_exponent, currency)
       values ($1, $2, $2, 'nexi', $1, 'paid', 12000, 2, 'CZK')`,
        [attempt, reservationId]
      );
      await pool.query(
        "update workspace_reservations set active_payment_attempt_id=$2 where id=$1",
        [reservationId, attempt]
      );
      const input = await statement(pack);
      await run(recordEffect(input));
      if (refundBeforeCancellation) await providerRefund(attempt, 2_000);
      await run(cancel(input));
      if (!refundBeforeCancellation) await providerRefund(attempt, 2_000);
      expect(await payment(attempt)).toEqual({
        refund_state: "required",
        refund_target_value: 12_000,
        refunded_amount_value: 2_000,
      });
      await providerRefund(attempt, 12_000);
      expect(await payment(attempt)).toMatchObject({
        refund_state: "refunded",
      });
    }
  );

  test("records an already refunded pass and sends buyer and staff mail in their own locales", async () => {
    const pack = await seed();
    await addClaim(pack, "2027-03-28", "consumed");
    await providerRefund(pack.attempt, 100_119);
    const input = await statement(pack, submittedAt, "de-DE");
    const { withdrawal } = await run(recordEffect(input));
    expect(await payment(pack.attempt)).toEqual({
      refund_state: "refunded",
      refund_target_value: 80_000,
      refunded_amount_value: 100_119,
    });
    const outbox: EmailMessage[] = [];
    const email = testEmailAddress("withdrawal-buyer");
    const delivery = WithdrawalEmails.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          database.layer,
          Layer.mock(EmailConfigTag, { defaultFrom: { email } }),
          Layer.mock(EmailServiceTag, {
            send: (message) =>
              Effect.sync(() => {
                outbox.push(message);
              }),
          })
        )
      )
    );
    await run(
      WithdrawalEmails.use((emails) =>
        Effect.andThen(
          emails.sendReceipt({ withdrawal, receiptEmail: email }),
          emails.sendOperatorNotice({ withdrawal, customerEmail: email })
        )
      ).pipe(Effect.provide(delivery))
    );
    const [receipt, notice] = outbox;
    const buyerLocale = { locale: "de-DE" } as const;
    expect(receipt?.text).toContain(m.passEntryPack({}, buyerLocale));
    expect(receipt?.text).toContain(
      m.passWithdrawalRefundTotal({}, buyerLocale)
    );
    expect(receipt?.text).toContain(
      m.passWithdrawalRefundNote({}, buyerLocale).split(". ")[0]
    );
    expect(notice?.subject).toContain(
      m.passEntryPack({}, { locale: staffLocale })
    );
    expect(notice?.text).toContain(
      m.passEntryPack({}, { locale: staffLocale })
    );
    expect(notice?.subject).not.toContain(m.passEntryPack({}, buyerLocale));
  });

  test("keeps larger manual refund targets and reconciles their outstanding amount", async () => {
    const pack = await seed();
    await addClaim(pack, "2027-03-28", "consumed");
    const input = await statement(pack);
    await pool.query(
      `update payment_attempts set refund_state='required', refund_target_value=90000
       where id=$1`,
      [pack.attempt]
    );
    await Promise.all([
      run(recordEffect(input)),
      providerRefund(pack.attempt, 50_000),
    ]);
    expect(await payment(pack.attempt)).toEqual({
      refund_state: "required",
      refund_target_value: 90_000,
      refunded_amount_value: 50_000,
    });
    await providerRefund(pack.attempt, 90_000);
    await providerRefund(pack.attempt, 70_000);
    expect(await payment(pack.attempt)).toEqual({
      refund_state: "refunded",
      refund_target_value: 90_000,
      refunded_amount_value: 90_000,
    });
  });
});
