import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import {
  CurrentCustomerAccount,
  requireVerifiedIdentity,
} from "@/features/account/backend/current-customer-account";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import {
  type CustomerAccountId,
  customerAccountIdSchema,
} from "@/features/account/customer-account";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  createWorkspacePostgresSuiteDatabase,
  requireTestDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { atInstant } from "@/shared/testing/workspace-test-clock.test-utils";
import { maskEmailAddress } from "@/shared/utils";
import { loadEntryPackStatus } from "./entry-pack-status";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Entry pack status",
  () => {
    const buyer = customerAccountIdSchema.make(crypto.randomUUID());
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    const holderEmail = testEmailAddress("pack-holder");
    const now = Temporal.Instant.from("2026-11-19T12:00:00Z");
    const paymentPage = "https://payment.example.invalid/entry-pack";
    let database: WorkspacePostgresSuiteDatabase;

    beforeAll(async () => {
      database = requireTestDatabase(
        await createWorkspacePostgresSuiteDatabase("entry_pack_status")
      );
      await database.pool.query(
        "insert into customer_accounts (id) values ($1), ($2)",
        [buyer, holder]
      );
      await database.pool.query(
        'insert into auth."user" (id, name, email, email_verified) values ($1, $2, $3, false)',
        [holder, "", holderEmail]
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    const seedOrder = async ({
      paymentState,
      holderAccountId = buyer,
    }: {
      readonly paymentState: "not_started" | "paid" | "pending" | "expired";
      readonly holderAccountId?: CustomerAccountId;
    }) => {
      const orderId = orderIdSchema.make(crypto.randomUUID());
      const attemptId = crypto.randomUUID();
      const paidAt = paymentState === "paid" ? now.toString() : null;
      await database.pool.query(
        `insert into orders
          (id, kind, dotypos_customer_id, payment_state, fulfillment_state, active_payment_attempt_id, paid_at)
          values ($1, 'pass-purchase', 'fixture-buyer', $2, 'not_started', $3, $4)`,
        [
          orderId,
          paymentState,
          paymentState === "not_started" ? null : attemptId,
          paidAt,
        ]
      );
      await database.pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
          values ($1, $2, $3, 'entry-pack', 'open-space', 5, $4, '2026-11-19', '2027-01-19', '{}', 'en-US', $5)`,
        [
          orderId,
          buyer,
          holderAccountId,
          {
            paid: "active",
            not_started: "pending_payment",
            pending: "pending_payment",
            expired: "void",
          }[paymentState],
          now.toString(),
        ]
      );
      if (paymentState !== "not_started")
        await database.pool.query(
          `insert into payment_attempts
          (id, order_id, provider, provider_order_id, security_token, state, amount_value, amount_exponent, currency,
           provider_redirect_url, failure_code, provider_order_created_at)
          values ($1, $2, 'nexi', $1, 'synthetic', $3, 100000, 2, 'CZK', $4, $5, $6)`,
          [
            attemptId,
            orderId,
            paymentState,
            paymentPage,
            paymentState === "expired" ? "fixture_expired" : null,
            now.toString(),
          ]
        );
      return { orderId, attemptId };
    };

    const view = (
      orderId: OrderId,
      {
        viewer = buyer,
        finalize,
        recover,
        viewedAt = now,
      }: {
        readonly viewer?: CustomerAccountId | null;
        readonly viewedAt?: Temporal.Instant;
        readonly finalize?: (
          id: OrderId
        ) => Effect.Effect<"awaiting_payment" | "pending">;
        readonly recover?: (
          id: OrderId
        ) => Effect.Effect<
          "recovery_started" | "confirmed_unpaid" | "not_settled"
        >;
      } = {}
    ) =>
      Effect.runPromise(
        loadEntryPackStatus(orderId).pipe(
          Effect.provide(
            Layer.mergeAll(
              database.layer,
              Layer.mock(CurrentCustomerAccount, {
                requireActive: requireVerifiedIdentity(
                  viewer === null
                    ? null
                    : {
                        accountId: viewer,
                        email: testEmailAddress("pack-viewer"),
                        deletionRequested: false,
                        ...testSessionProfile,
                      }
                ),
                peek: Effect.succeed({ kind: "signed-out" } as const),
              }),
              Layer.mock(ProviderPaymentFinalizationService, {
                finalizePendingProviderPayment: ({ orderId: id }) =>
                  finalize?.(id) ??
                  Effect.die("Unexpected payment verification"),
              }),
              Layer.mock(LatePaymentVerificationService, {
                startRecoveryIfSettled: ({ orderId: id }) =>
                  recover?.(id) ?? Effect.die("Unexpected payment recovery"),
              })
            )
          ),
          atInstant(viewedAt)
        )
      );

    test("only the active buyer can inspect or refresh a purchase", async () => {
      const { orderId } = await seedOrder({
        paymentState: "pending",
        holderAccountId: holder,
      });
      expect(await view(orderId, { viewer: holder })).toEqual({
        status: "not_found",
      });
      expect(await view(orderId, { viewer: null })).toEqual({
        status: "sign_in",
      });

      const checked: OrderId[] = [];
      expect(
        await view(orderId, {
          finalize: (id) =>
            Effect.sync(() => {
              checked.push(id);
              return "awaiting_payment" as const;
            }),
        })
      ).toMatchObject({ status: "pending", paymentPage });
      expect(checked).toEqual([orderId]);
      expect(
        await view(orderId, { finalize: () => Effect.succeed("pending") })
      ).toMatchObject({ status: "pending", paymentPage: undefined });
    });

    test("only the buyer receives the paid gift designation and masked holder", async () => {
      const { orderId } = await seedOrder({
        paymentState: "paid",
        holderAccountId: holder,
      });
      expect(await view(orderId, { viewer: holder })).toEqual({
        status: "not_found",
      });
      expect(await view(orderId)).toMatchObject({
        status: "paid",
        gift: true,
        invitation: "not_sent",
        claimed: false,
        maskedHolderEmail: maskEmailAddress(holderEmail),
      });
      const self = await seedOrder({ paymentState: "paid" });
      const selfStatus = await view(self.orderId);
      expect(selfStatus).toMatchObject({
        status: "paid",
        gift: false,
      });
      expect(selfStatus).not.toHaveProperty("maskedHolderEmail");
      expect(selfStatus).not.toHaveProperty("invitation");
    });

    test("exposes a fulfilled complimentary order to its author and claimed holder without payment details", async () => {
      const orderId = orderIdSchema.make(crypto.randomUUID());
      const unrelated = customerAccountIdSchema.make(crypto.randomUUID());
      await database.pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state)
         values ($1, 'pass-purchase', 'fixture-holder', 'complimentary', 'processing')`,
        [orderId]
      );
      await database.pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, unlimited_coffee, status, valid_from, valid_until, quote, locale, created_at)
         values ($1, $2, $3, 'unlimited', 'open-space', false, 'pending_payment', '2026-11-20', '2026-12-20', '{}', 'en-US', $4)`,
        [orderId, buyer, holder, now.toString()]
      );

      expect(await view(orderId)).toEqual({ status: "not_found" });
      expect(await view(orderId, { viewer: holder })).toEqual({
        status: "not_found",
      });

      await database.pool.query(
        "update orders set fulfillment_state = 'fulfilled', fulfilled_at = $2 where id = $1",
        [orderId, now.toString()]
      );
      await database.pool.query(
        "update pass_purchases set status = 'active', gift_issued_at = $2 where id = $1",
        [orderId, now.toString()]
      );
      const granted = {
        status: "granted",
        orderId,
        tier: "open-space",
        entryCount: null,
        validFrom: "2026-11-20",
        validUntil: "2026-12-20",
      };
      expect(await view(orderId)).toEqual({ ...granted, canOpenAccess: false });
      expect(await view(orderId, { viewer: holder })).toEqual({
        status: "not_found",
      });

      await database.pool.query(
        "update pass_purchases set gift_claimed_at = $2 where id = $1",
        [orderId, now.toString()]
      );
      expect(await view(orderId, { viewer: holder })).toEqual({
        ...granted,
        canOpenAccess: true,
      });
      expect(await view(orderId, { viewer: unrelated })).toEqual({
        status: "not_found",
      });
      expect(await view(orderId, { viewer: null })).toEqual({
        status: "sign_in",
      });

      await database.pool.query(
        "update pass_purchases set status = 'cancelled', access_ends_on = valid_from where id = $1",
        [orderId]
      );
      const cancelled = { ...granted, status: "grant_cancelled" };
      const empty = { ...cancelled, validUntil: granted.validFrom };
      const beforeStart = Temporal.Instant.from("2026-11-19T12:00:00Z");
      expect(await view(orderId, { viewedAt: beforeStart })).toEqual({
        ...empty,
        canOpenAccess: false,
      });
      expect(
        await view(orderId, { viewer: holder, viewedAt: beforeStart })
      ).toEqual({ ...empty, canOpenAccess: false });

      await database.pool.query(
        "update pass_purchases set access_ends_on = '2026-11-25' where id = $1",
        [orderId]
      );
      const truncated = { ...cancelled, validUntil: "2026-11-25" };
      const retainedDay = Temporal.Instant.from("2026-11-24T12:00:00Z");
      expect(await view(orderId, { viewedAt: retainedDay })).toEqual({
        ...truncated,
        canOpenAccess: false,
      });
      expect(
        await view(orderId, { viewer: holder, viewedAt: retainedDay })
      ).toEqual({ ...truncated, canOpenAccess: true });
      const cutoff = Temporal.Instant.from("2026-11-24T23:00:00Z");
      expect(await view(orderId, { viewer: holder, viewedAt: cutoff })).toEqual(
        { ...truncated, canOpenAccess: false }
      );
    });

    test("reads a recorded delivery and claim for the buyer", async () => {
      const { orderId } = await seedOrder({
        paymentState: "paid",
        holderAccountId: holder,
      });
      await database.pool.query(
        `insert into entry_pack_gift_invitations
          (order_id, holder_account_id, locale, generation, attempts, requested_at, sent_at, key_id)
          values ($1, $2, 'en-US', 0, 1, $3, $3, 'fixture-key')`,
        [orderId, holder, now.toString()]
      );
      expect(await view(orderId)).toMatchObject({
        invitation: "sent",
        claimed: false,
      });

      await database.pool.query(
        "update pass_purchases set gift_claimed_at = $2 where id = $1",
        [orderId, now.toString()]
      );
      expect(await view(orderId)).toMatchObject({
        invitation: "sent",
        claimed: true,
      });
    });

    test("reads the recorded refund after checking for a late capture", async () => {
      const { orderId, attemptId } = await seedOrder({
        paymentState: "expired",
      });
      expect(
        await view(orderId, {
          recover: (id) =>
            Effect.promise(async () => {
              expect(id).toBe(orderId);
              await database.pool.query(
                "update payment_attempts set state = 'paid', refund_state = 'required', failure_code = null where id = $1",
                [attemptId]
              );
              return "recovery_started" as const;
            }),
        })
      ).toMatchObject({ status: "refund_required" });

      await database.pool.query(
        "update payment_attempts set refund_state = 'refunded', refunded_amount_value = amount_value, refunded_at = now() where id = $1",
        [attemptId]
      );
      expect(await view(orderId)).toMatchObject({ status: "refunded" });
    });

    test("an untouched draft has no provider attempt or payment failure", async () => {
      const { orderId } = await seedOrder({ paymentState: "not_started" });
      expect(await view(orderId)).toMatchObject({ status: "not_started" });
    });

    test("the active attempt refund takes precedence over paid gift status", async () => {
      const { orderId, attemptId } = await seedOrder({
        paymentState: "paid",
        holderAccountId: holder,
      });
      await database.pool.query(
        "update payment_attempts set refund_state = 'required', refund_target_value = 60000, refunded_amount_value = 25000, refunded_at = now() where id = $1",
        [attemptId]
      );
      expect(await view(orderId)).toMatchObject({
        status: "partially_refunded",
        refunded: { value: 25000, exponent: 2, currency: "CZK" },
        refundPending: true,
      });
      expect(await view(orderId)).not.toHaveProperty("maskedHolderEmail");
      expect(await view(orderId, { viewer: holder })).toEqual({
        status: "not_found",
      });

      await database.pool.query(
        "update payment_attempts set refund_state = 'refunded', refunded_amount_value = refund_target_value where id = $1",
        [attemptId]
      );
      expect(await view(orderId)).toMatchObject({
        status: "partially_refunded",
        refunded: { value: 60000, exponent: 2, currency: "CZK" },
        refundPending: false,
      });

      await database.pool.query(
        "update payment_attempts set refunded_amount_value = amount_value where id = $1",
        [attemptId]
      );
      expect(await view(orderId)).toMatchObject({ status: "refunded" });
    });
  }
);
