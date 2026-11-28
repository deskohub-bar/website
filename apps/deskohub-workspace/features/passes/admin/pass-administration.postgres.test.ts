import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DotyposService,
  DotyposTableSchema,
  DotyposVersionConflict,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Result, Schema } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { ReservationAdministrationService } from "@/features/administration/reservation-administration.service";
import { ReservationRestorationService } from "@/features/administration/reservation-restoration.service";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { WorkspaceReservationEmailService } from "@/features/checkout/backend/fulfillment/workspace-reservation-email.service";
import { PaymentRefundService } from "@/features/checkout/backend/payment/payment-refund.service";
import { WorkspaceTableAssignmentService } from "@/features/checkout/backend/reservation/workspace-table-assignment.service";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceReservationService } from "@/features/reservation/backend/workspace-reservation.service";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { ReservationAccessService } from "@/features/reservation-access";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  requireTestDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { applyPackAdjustment } from "./apply-pass-adjustment";
import { beginUnlimitedPassChange } from "./begin-unlimited-pass-change";
import { completePassChange } from "./complete-pass-change";
import { grantPass } from "./grant-pass";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "pass administration on disposable PostgreSQL",
  () => {
    let database: WorkspacePostgresSuiteDatabase;
    const actor = {
      accountId: customerAccountIdSchema.make(crypto.randomUUID()),
      email: testEmailAddress("pass-operator"),
    };
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    const recipient = customerAccountIdSchema.make(crypto.randomUUID());
    const date = plainDateStringSchema.make;

    beforeEach(async () => {
      database = requireTestDatabase(
        await createWorkspacePostgresSuiteDatabase("pass_administration")
      );
      await database.pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, '4141'), ($2, '4142'), ($3, '4143')",
        [actor.accountId, holder, recipient]
      );
      await database.pool.query(
        `insert into auth."user" (id, email, name, email_verified, created_at, updated_at)
      values ($1, $2, 'Fixture Holder', true, now(), now()), ($3, $4, 'Fixture Recipient', true, now(), now())`,
        [
          holder,
          testEmailAddress("pass-holder"),
          recipient,
          testEmailAddress("pass-recipient"),
        ]
      );
    });

    afterEach(async () => database?.close());

    const run = (effect, provider = makeInMemoryDotypos({})) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              database.layer,
              WorkspaceDatabaseAdvisoryLock.makeLayer(database.databasePool),
              Layer.succeed(CurrentAdministrator, actor),
              provider.layer,
              WorkspaceReservationRepository.Default.pipe(
                Layer.provide(database.layer)
              ),
              Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
                listLimitations: () => Effect.succeed([]),
              }),
              Layer.mock(ReservationAdministrationService, {})
            )
          )
        )
      );

    const seedPack = async () => {
      const passId = orderIdSchema.make(crypto.randomUUID());
      const attemptId = crypto.randomUUID();
      await database.pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at, fulfilled_at, active_payment_attempt_id)
      values ($1,'pass-purchase','4142','paid','fulfilled',now(),now(),$2)`,
        [passId, attemptId]
      );
      await database.pool.query(
        `insert into payment_attempts (id, order_id, provider, state, provider_order_id, amount_value, amount_exponent, currency)
      values ($1,$2,'nexi','paid',$1,100000,2,'CZK')`,
        [attemptId, passId]
      );
      // The deployed writer's column list omits the new holder revision.
      await database.pool.query(
        `insert into pass_purchases
      (id,buyer_account_id,holder_account_id,product,tier,entry_count,status,valid_from,valid_until,quote,locale,created_at)
      values ($1,$2,$2,'entry-pack','open-space',5,'active','2099-06-01','2099-08-01','{}','en-US',now())`,
        [passId, holder]
      );
      return { passId, attemptId };
    };

    test("concurrent stale validity changes reserve one refund and a replay creates no new obligation", async () => {
      const { passId, attemptId } = await seedPack();
      const change = {
        _tag: "validity" as const,
        expectedValidUntil: date("2099-08-01"),
        lastDay: date("2099-07-23"),
        refundValue: 20_000,
      };
      const first = {
        passId,
        requestId: crypto.randomUUID(),
        reason: "Fixture prorated reduction",
        change,
      };
      const second = { ...first, requestId: crypto.randomUUID() };
      const results = await Promise.all(
        [first, second].map((input) =>
          run(Effect.result(applyPackAdjustment(input)))
        )
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(
        results.filter(Result.isFailure).map(({ failure }) => failure.reason)
      ).toEqual(["changed"]);
      const winner = results[0]._tag === "Success" ? first : second;
      expect((await run(applyPackAdjustment(winner))).requestId).toBe(
        winner.requestId
      );
      const { rows } = await database.pool.query(
        `select pass.valid_until::text, pass.holder_version,
      attempt.refund_state, attempt.refund_target_value, attempt.refunded_amount_value
      from pass_purchases pass join payment_attempts attempt on attempt.order_id = pass.id where attempt.id=$1`,
        [attemptId]
      );
      expect(rows).toEqual([
        {
          valid_until: "2099-07-24",
          holder_version: 0,
          refund_state: "required",
          refund_target_value: 20_000,
          refunded_amount_value: null,
        },
      ]);
    });

    test("rejects a refund above the amount still available after provider refunds", async () => {
      const { passId, attemptId } = await seedPack();
      await database.pool.query(
        `update payment_attempts set refund_state='refunded', refunded_amount_value=73000, refunded_at=now() where id=$1`,
        [attemptId]
      );
      const outcome = await run(
        Effect.result(
          applyPackAdjustment({
            passId,
            requestId: crypto.randomUUID(),
            reason: "Fixture cancellation",
            change: {
              _tag: "cancel",
              expectedValidUntil: date("2099-08-01"),
              refundValue: 28_000,
              sendCancellationEmail: false,
            },
          })
        )
      );
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { reason: "refund-limit" },
      });
      const { rows } = await database.pool.query(
        "select status from pass_purchases where id=$1",
        [passId]
      );
      expect(rows[0]?.status).toBe("active");
    });

    test("outstanding claims block reassignment and validity cannot cut off their booked dates", async () => {
      const { passId } = await seedPack();
      const reservation = await Effect.runPromise(
        workspaceFixtures(database.db).reservation({
          stage: { reservation: "draft" },
          author: holder,
        })
      );
      await database.pool.query(
        "insert into pass_entry_claims (reservation_id, pass_id, date, status) values ($1,$2,'2099-07-30','reserved')",
        [reservation.id, passId]
      );
      const request = {
        passId,
        requestId: crypto.randomUUID(),
        reason: "Fixture claim boundary",
      };
      const reassign = await run(
        Effect.result(
          applyPackAdjustment({
            ...request,
            change: {
              _tag: "reassign",
              expectedHolderAccountId: holder,
              expectedHolderVersion: 0,
              holderAccountId: recipient,
            },
          })
        )
      );
      expect(reassign).toMatchObject({
        _tag: "Failure",
        failure: { reason: "first-use" },
      });
      const shortened = await run(
        Effect.result(
          applyPackAdjustment({
            ...request,
            change: {
              _tag: "validity",
              expectedValidUntil: date("2099-08-01"),
              lastDay: date("2099-07-29"),
              refundValue: 0,
            },
          })
        )
      );
      expect(shortened).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-validity" },
      });
      const kept = await run(
        applyPackAdjustment({
          ...request,
          change: {
            _tag: "validity",
            expectedValidUntil: date("2099-08-01"),
            lastDay: date("2099-07-30"),
            refundValue: 0,
          },
        })
      );
      expect(kept.completedAt).not.toBeNull();
    });

    test("cancels a future pack-funded booking exactly once and refuses ordinary restoration", async () => {
      const { passId, attemptId } = await seedPack();
      const reservation = await Effect.runPromise(
        workspaceFixtures(database.db).reservation({
          stage: {
            reservation: "confirmed",
            payment: "paid",
            fulfillment: "fulfilled",
          },
          author: holder,
        })
      );
      await database.pool.query(
        "insert into pass_entry_claims (reservation_id, pass_id, date, status) values ($1,$2,'2099-07-30','consumed')",
        [reservation.id, passId]
      );
      const cancel = mock(({ reservationId }) =>
        Effect.promise(async () => {
          await database.pool.query(
            "update workspace_reservations set reservation_state='cancelled', reservation_cancelled_at=now() where id=$1",
            [reservationId]
          );
          return {
            outcome: "cancelled" as const,
            email: "not_requested" as const,
            invoice: null,
          };
        })
      );
      const request = {
        passId,
        requestId: crypto.randomUUID(),
        reason: "Fixture cancel whole pass",
        change: {
          _tag: "cancel" as const,
          expectedValidUntil: date("2099-08-01"),
          refundValue: 25_000,
          sendCancellationEmail: false,
        },
      };
      const complete = () =>
        run(
          applyPackAdjustment(request).pipe(
            Effect.flatMap(completePassChange),
            Effect.provide(
              Layer.mock(ReservationAdministrationService, { cancel })
            )
          )
        );
      const completed = await complete();
      expect(completed.completedAt).not.toBeNull();
      expect((await complete()).completedAt).toEqual(completed.completedAt);
      expect(cancel).toHaveBeenCalledTimes(1);

      const restore = await run(
        ReservationRestorationService.use((service) =>
          Effect.result(
            service.restore({
              reservationId: reservation.id,
              acknowledgeRefundedPayment: false,
              sendRestorationEmail: false,
            })
          )
        ).pipe(
          Effect.provide(
            ReservationRestorationService.Default.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(ReservationAccessService, {}),
                  Layer.mock(AccountingDocumentSnapshots, {}),
                  Layer.mock(DotyposService, {}),
                  Layer.mock(WorkspaceReservationEmailService, {}),
                  Layer.mock(PaymentRefundService, {}),
                  Layer.mock(WorkspaceReservationService, {}),
                  Layer.mock(WorkspaceTableAssignmentService, {})
                )
              )
            )
          )
        )
      );
      if (!Result.isFailure(restore))
        throw new Error("Restoration was accepted");
      expect(restore.failure.reason).toBe("invalid_state");
      const recorded = await database.pool.query(
        `select workspace_reservations.reservation_state,
                pass_entry_claims.status as claim_status,
                payment_attempts.refund_state, payment_attempts.refund_target_value
         from workspace_reservations
         join pass_entry_claims on pass_entry_claims.reservation_id=workspace_reservations.id
         join payment_attempts on payment_attempts.id=$2
         where workspace_reservations.id=$1`,
        [reservation.id, attemptId]
      );
      expect(recorded.rows).toEqual([
        {
          reservation_state: "cancelled",
          claim_status: "released",
          refund_state: "required",
          refund_target_value: 25_000,
        },
      ]);
    });

    test("reassignment rotates invitation identity and holder capability versions", async () => {
      const { passId } = await seedPack();
      const reassign = (previous, next, version) =>
        run(
          applyPackAdjustment({
            passId,
            requestId: crypto.randomUUID(),
            reason: "Fixture holder transfer",
            change: {
              _tag: "reassign",
              expectedHolderAccountId: previous,
              expectedHolderVersion: version,
              holderAccountId: next,
            },
          })
        );
      await reassign(holder, recipient, 0);
      const first = (
        await database.pool.query(
          "select context_id, generation, first_generation from entry_pack_gift_invitations where order_id=$1",
          [passId]
        )
      ).rows[0];
      expect(first.generation).toBe(first.first_generation);
      await reassign(recipient, holder, 1);
      await expect(reassign(holder, recipient, 0)).rejects.toMatchObject({
        reason: "changed",
      });
      await reassign(holder, recipient, 2);
      const current = (
        await database.pool.query(
          `select invitation.context_id, invitation.generation,
      invitation.first_generation, pass.holder_version, pass.gift_claimed_at from entry_pack_gift_invitations invitation
      join pass_purchases pass on pass.id=invitation.order_id where pass.id=$1`,
          [passId]
        )
      ).rows[0];
      expect(current.context_id).not.toBe(first.context_id);
      expect(current.generation).toBeGreaterThan(first.generation);
      expect(current.first_generation).toBe(current.generation);
      expect(current.holder_version).toBe(3);
      expect(current.gift_claimed_at).toBeNull();
    });

    test("a complimentary grant creates one order, issues the claim and creates no payment or consent", async () => {
      const passId = orderIdSchema.make(crypto.randomUUID());
      const request = {
        requestId: passId,
        passId,
        reason: "Fixture community grant",
        change: {
          _tag: "grant" as const,
          holderAccountId: recipient,
          selection: {
            kind: "entry-pack" as const,
            tier: "open-space" as const,
            size: 5 as const,
          },
        },
      };
      const prior = await run(grantPass(request, "en-US"));
      const replay = await run(grantPass(request, "en-US"));
      expect(prior.requestId).toBe(replay.requestId);
      const { rows } = await database.pool.query(
        `select orders.payment_state, orders.paid_at, orders.active_payment_attempt_id,
      (select count(*)::int from payment_attempts where order_id=orders.id) as attempts,
      (select count(*)::int from legal_evidence_events where order_id=orders.id) as documents,
      (select count(*)::int from entry_pack_gift_invitations where order_id=orders.id) as invitations
      from orders where id=$1`,
        [passId]
      );
      expect(rows).toEqual([
        {
          payment_state: "complimentary",
          paid_at: null,
          active_payment_attempt_id: null,
          attempts: 0,
          documents: 0,
          invitations: 1,
        },
      ]);
    });

    test.each(["grant", "extension"] as const)(
      "releases only newly confirmed Unlimited days after the holder disappears during %s",
      async (operation) => {
        const extending = operation === "extension";
        const table = Schema.decodeUnknownSync(DotyposTableSchema)({
          id: extending ? "4151" : "4152",
          _cloudId: "1",
          display: true,
          enabled: true,
          name: "Synthetic rollback desk",
          seats: "1",
          tags: ["cowork:reserved-desk"],
        });
        const provider = makeInMemoryDotypos({ tables: [table] });
        const passId = orderIdSchema.make(crypto.randomUUID());
        const holderAccountId = customerAccountIdSchema.make(
          crypto.randomUUID()
        );
        const customerId = extending ? "4153" : "4154";
        await database.pool.query(
          "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2)",
          [holderAccountId, customerId]
        );
        await database.pool.query(
          `insert into auth."user" (id, email, name, email_verified, created_at, updated_at)
            values ($1, $2, 'Synthetic rollback holder', true, now(), now())`,
          [holderAccountId, testEmailAddress(`pass-rollback-${operation}`)]
        );
        const start = getWorkspaceDate(Temporal.Now.instant()).add({
          days: extending ? 75 : 40,
        });
        const originalEnd = date(start.add({ days: 30 }).toString());
        const grant = await run(
          grantPass(
            {
              passId,
              requestId: passId,
              reason: "Fixture grant before rollback",
              change: {
                _tag: "grant",
                holderAccountId,
                selection: {
                  tier: "reserved-desk",
                  startDate: date(start.toString()),
                },
              },
            },
            "en-US"
          ),
          provider
        );
        const change = extending
          ? await run(
              completePassChange(grant).pipe(
                Effect.andThen(
                  beginUnlimitedPassChange({
                    passId,
                    requestId: crypto.randomUUID(),
                    reason: "Fixture extension before rollback",
                    change: {
                      _tag: "validity",
                      lastDay: date(start.add({ days: 31 }).toString()),
                      expectedValidUntil: originalEnd,
                      refundValue: 0,
                    },
                  })
                )
              ),
              provider
            )
          : grant;
        const service = await run(DotyposService, provider);
        let cancelAvailable = false;
        const confirmAttempts: string[] = [];
        const interrupted = {
          layer: Layer.succeed(DotyposService, {
            ...service,
            setReservationStatusIfMatches: (input) => {
              if (input.status === "CANCELLED") {
                return cancelAvailable
                  ? service.setReservationStatusIfMatches(input)
                  : Effect.fail(
                      new DotyposVersionConflict({
                        operation: "setReservationStatusIfMatches",
                        message: "Fixture rollback was interrupted",
                      })
                    );
              }
              return service.setReservationStatusIfMatches(input).pipe(
                Effect.tap(() =>
                  Effect.promise(async () => {
                    confirmAttempts.push(input.reservationId);
                    if (confirmAttempts.length === 1) {
                      await database.pool.query(
                        "update customer_accounts set deleted_at=now(), dotypos_customer_id=null where id=$1",
                        [holderAccountId]
                      );
                    }
                  })
                )
              );
            },
          }),
        };
        const pending = await run(completePassChange(change), interrupted);
        expect(pending.failedAt).toBeNull();
        const staged = await database.pool.query(
          "select hold_rollback_at from pass_administration_changes where request_id=$1",
          [change.requestId]
        );
        expect(staged.rows[0]?.hold_rollback_at).not.toBeNull();
        const expectedRemoved = extending ? 2 : 30;
        expect(confirmAttempts).toHaveLength(expectedRemoved);

        cancelAvailable = true;
        const rolledBack = await run(completePassChange(change), interrupted);
        expect(rolledBack.failedAt).not.toBeNull();
        expect(
          (await run(completePassChange(change), interrupted)).failedAt
        ).toEqual(rolledBack.failedAt);
        expect(confirmAttempts).toHaveLength(expectedRemoved);
        const pass = await database.pool.query(
          `select pass_purchases.status, valid_until::text, fulfillment_state
            from pass_purchases join orders using (id) where id=$1`,
          [passId]
        );
        expect(pass.rows[0]).toEqual({
          status: extending ? "active" : "void",
          valid_until: originalEnd,
          fulfillment_state: extending ? "fulfilled" : "failed",
        });
        const holds = await database.pool.query(
          "select reservation_state from workspace_reservations where pass_id=$1 order by service_date",
          [passId]
        );
        expect(
          holds.rows.map(({ reservation_state }) => reservation_state)
        ).toEqual([
          ...Array.from({ length: extending ? 30 : 0 }, () => "confirmed"),
          ...Array.from({ length: expectedRemoved }, () => "cancelled"),
        ]);
      }
    );

    test("Unlimited grant, shortening and re-extension settle marked days without duplicating provider holds", async () => {
      const table = Schema.decodeUnknownSync(DotyposTableSchema)({
        id: "4144",
        _cloudId: "1",
        display: true,
        enabled: true,
        name: "Synthetic reserved desk",
        seats: "1",
        tags: ["cowork:reserved-desk"],
      });
      const alternate = {
        ...table,
        id: "4145",
        name: "Synthetic alternate desk",
      };
      const provider = makeInMemoryDotypos({ tables: [table, alternate] });
      const passId = orderIdSchema.make(crypto.randomUUID());
      const start = getWorkspaceDate(Temporal.Now.instant()).add({ days: 2 });
      const originalEnd = date(start.add({ days: 30 }).toString());
      const shortenedEnd = date(start.add({ days: 28 }).toString());
      const request = {
        passId,
        requestId: passId,
        reason: "Fixture monthly grant",
        change: {
          _tag: "grant" as const,
          holderAccountId: holder,
          selection: {
            tier: "reserved-desk" as const,
            startDate: date(start.toString()),
          },
        },
      };
      const grant = await run(grantPass(request, "en-US"), provider);
      expect(grant.completedAt).toBeNull();
      expect(
        (await run(completePassChange(grant), provider)).completedAt
      ).not.toBeNull();
      const passDays = async () =>
        (
          await database.pool.query(
            `select service_date::text, reservation_state, dotypos_reservation_id, pass_day_table_id from workspace_reservations
      where pass_id=$1 order by service_date`,
            [passId]
          )
        ).rows;
      const original = await passDays();
      expect(original).toHaveLength(30);
      expect(
        original.every((row) => row.reservation_state === "confirmed")
      ).toBe(true);

      const adjust = (expectedValidUntil, lastDay) =>
        run(
          beginUnlimitedPassChange({
            passId,
            requestId: crypto.randomUUID(),
            reason: "Fixture validity change",
            change: {
              _tag: "validity",
              expectedValidUntil,
              lastDay: date(lastDay.toString()),
              refundValue: 0,
            },
          }),
          provider
        );
      const shortening = await adjust(originalEnd, start.add({ days: 27 }));
      expect(
        (await run(completePassChange(shortening), provider)).completedAt
      ).not.toBeNull();
      expect(
        (await passDays()).slice(-2).map((row) => row.reservation_state)
      ).toEqual(["cancelled", "cancelled"]);

      const extension = await adjust(shortenedEnd, start.add({ days: 29 }));
      expect(
        (await run(completePassChange(extension), provider)).completedAt
      ).not.toBeNull();
      await run(completePassChange(extension), provider);
      const restored = await passDays();
      expect(restored.slice(0, 28)).toEqual(original.slice(0, 28));
      expect(restored.slice(-2).map((row) => row.reservation_state)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect(
        restored.slice(-2).map((row) => row.dotypos_reservation_id)
      ).not.toEqual(
        original.slice(-2).map((row) => row.dotypos_reservation_id)
      );
      const observed = await run(
        DotyposService.pipe(
          Effect.flatMap((dotypos) => dotypos.listReservations({}))
        ),
        provider
      );
      expect(
        observed.filter(({ status }) => status === "CONFIRMED")
      ).toHaveLength(30);
      expect(
        observed.filter(({ status }) => status === "CANCELLED")
      ).toHaveLength(2);

      const transfer = await run(
        beginUnlimitedPassChange({
          passId,
          requestId: crypto.randomUUID(),
          reason: "Fixture holder transfer",
          change: {
            _tag: "reassign",
            expectedHolderAccountId: holder,
            expectedHolderVersion: 0,
            holderAccountId: recipient,
            holderCustomerId: "4143",
          },
        }),
        provider
      );
      expect(transfer.completedAt).toBeNull();
      expect(
        (await run(completePassChange(transfer), provider)).completedAt
      ).not.toBeNull();
      await run(completePassChange(transfer), provider);
      const transferred = await run(
        DotyposService.pipe(
          Effect.flatMap((dotypos) =>
            dotypos.listReservations({ customerId: "4143" })
          )
        ),
        provider
      );
      expect(transferred.map(({ id, status }) => [id, status]).sort()).toEqual(
        restored
          .map(({ dotypos_reservation_id }) => [
            dotypos_reservation_id,
            "CONFIRMED",
          ])
          .sort()
      );
      const { rows } = await database.pool.query(
        "select holder_account_id, holder_version, gift_claimed_at from pass_purchases where id=$1",
        [passId]
      );
      expect(rows[0]).toEqual({
        holder_account_id: recipient,
        holder_version: 1,
        gift_claimed_at: null,
      });

      const service = await run(DotyposService, provider);
      const conflictingId = restored[1].dotypos_reservation_id;
      const conflicting = {
        layer: Layer.succeed(DotyposService, {
          ...service,
          reassignReservationCustomerIfMatches: (input) =>
            input.reservationId === conflictingId
              ? Effect.fail(
                  new DotyposVersionConflict({
                    operation: "reassignReservationCustomerIfMatches",
                    message: "Fixture provider version conflict",
                  })
                )
              : service.reassignReservationCustomerIfMatches(input),
        }),
      };
      const failedTransfer = await run(
        beginUnlimitedPassChange({
          passId,
          requestId: crypto.randomUUID(),
          reason: "Fixture conflicting transfer",
          change: {
            _tag: "reassign",
            expectedHolderAccountId: recipient,
            expectedHolderVersion: 1,
            holderAccountId: holder,
            holderCustomerId: "4142",
          },
        }),
        conflicting
      );
      await run(completePassChange(failedTransfer), conflicting);
      const movedAhead = await run(
        DotyposService.pipe(
          Effect.flatMap((dotypos) =>
            dotypos.listReservations({ customerId: "4142" })
          )
        ),
        provider
      );
      expect(
        movedAhead.filter(({ status }) => status === "CONFIRMED")
      ).toHaveLength(1);
      await run(completePassChange(failedTransfer), conflicting);
      const restoredProvider = await run(
        DotyposService.pipe(
          Effect.flatMap((dotypos) =>
            dotypos.listReservations({ customerId: "4143" })
          )
        ),
        provider
      );
      expect(restoredProvider).toHaveLength(30);
      const recorded = await database.pool.query(
        "select transfer_progress->'conflicts' as conflicts from pass_administration_changes where request_id=$1",
        [failedTransfer.requestId]
      );
      expect(recorded.rows[0]?.conflicts).toEqual([restored[1].service_date]);
      expect(
        (await run(completePassChange(failedTransfer), provider)).failedAt
      ).not.toBeNull();

      const assignedDesk = original[0].pass_day_table_id;
      const conflict = getCoworkReservationInterval(
        "reserved-desk",
        originalEnd
      );
      await run(
        DotyposService.pipe(
          Effect.flatMap((dotypos) =>
            dotypos.createReservation({
              customerId: "4141",
              tableId: assignedDesk,
              status: "CONFIRMED",
              seats: 1,
              startDate: new Date(conflict.startsAt),
              endDate: new Date(conflict.endsAt),
            })
          )
        ),
        provider
      );
      await expect(
        adjust(originalEnd, Temporal.PlainDate.from(originalEnd))
      ).rejects.toMatchObject({ reason: "capacity" });
      expect(await passDays()).toEqual(restored);

      const cancellation = await run(
        beginUnlimitedPassChange({
          passId,
          requestId: crypto.randomUUID(),
          reason: "Fixture cancellation before start",
          change: {
            _tag: "cancel",
            expectedValidUntil: originalEnd,
            refundValue: 0,
            sendCancellationEmail: false,
          },
        }),
        provider
      );
      expect(
        (await run(completePassChange(cancellation), provider)).completedAt
      ).not.toBeNull();
      expect(
        (await passDays()).every(
          ({ reservation_state }) => reservation_state === "cancelled"
        )
      ).toBe(true);
    });
  }
);
