import "@/shared/testing/workspace-test-env";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposRejected, DotyposService } from "@deskohub/dotypos";
import {
  AlgoPinSchema,
  IgloohomePinIdSchema,
  IgloohomeService,
} from "@deskohub/igloohome";
import { testEmailAddress } from "@deskohub/test-email";
import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  CurrentCustomerAccount,
  requireVerifiedIdentity,
} from "@/features/account/backend/current-customer-account";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import {
  type CustomerAccountId,
  customerAccountIdSchema,
} from "@/features/account/customer-account";
import { type OrderId, orderIdSchema } from "@/features/order";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { ReservationAccessService } from "@/features/reservation-access";
import { ReservationAccessRepository } from "@/features/reservation-access/backend/reservation-access.repository";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { atInstant } from "@/shared/testing/workspace-test-clock.test-utils";
import type { PassTier } from "../pass-offer";
import { unlimitedAccessTokenQueryParam } from "../unlimited-access";
import { loadUnlimitedAccess } from "./unlimited-access";
import {
  createUnlimitedAccessUrl,
  exchangeUnlimitedAccessToken,
} from "./unlimited-access-capability";

const firstDay = "2030-03-31"; // Prague moves to summer time on this date.
const nextDay = "2030-04-01";
const during = Temporal.Instant.from("2030-03-31T11:00Z");
const openSpaceClosing = Temporal.Instant.from("2030-03-31T15:00Z");
const nextMidnight = Temporal.Instant.from("2030-03-31T22:00Z");
const syntheticPin = AlgoPinSchema.make("246813579");

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Unlimited access on disposable Postgres",
  () => {
    const buyer = customerAccountIdSchema.make(crypto.randomUUID());
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    let database: WorkspacePostgresSuiteDatabase;

    beforeAll(async () => {
      database = (await createWorkspacePostgresSuiteDatabase(
        "unlimited_access"
      ))!;
      await database.pool.query(
        "insert into customer_accounts (id) values ($1), ($2)",
        [buyer, holder]
      );
      await database.pool.query(
        `insert into auth."user" (id, name, email, email_verified)
         values ($1, 'Synthetic buyer', $3, true), ($2, 'Synthetic holder', $4, true)`,
        [
          buyer,
          holder,
          testEmailAddress("pass-buyer"),
          testEmailAddress("pass-holder"),
        ]
      );
    });

    afterAll(async () => {
      await database?.close();
    });

    const seedPass = async (tier: PassTier, gifted = false) => {
      const orderId = orderIdSchema.make(crypto.randomUUID());
      await database.pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at)
         values ($1, 'pass-purchase', '1', 'paid', 'processing', now())`,
        [orderId]
      );
      await database.pool.query(
        `insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier, unlimited_coffee,
           status, valid_from, valid_until, quote, locale, created_at)
         values ($1, $2, $3, 'unlimited', $4, $5, 'active', $6, '2030-04-30', '{}', 'en-US', now())`,
        [
          orderId,
          buyer,
          gifted ? holder : buyer,
          tier,
          tier === "open-space" ? false : null,
          firstDay,
        ]
      );
      const { rows } = await database.pool.query<{ id: string }>(
        `insert into workspace_reservations (checkout_attempt_key, pass_id, service_date, pass_day_table_id, dotypos_customer_id,
           author_account_id, dotypos_reservation_id, reservation_state, payment_state, fulfillment_state,
           paid_at, fulfilled_at, reservation_details, locale)
         values (uuid_generate_v7(), $1, $3::date, '14', '1', $2, concat($1::text, ':', $3::text), 'confirmed', 'paid', 'fulfilled', now(), now(), '{}', 'en-US'),
                (uuid_generate_v7(), $1, $4::date, '14', '1', $2, concat($1::text, ':', $4::text), 'confirmed', 'paid', 'fulfilled', now(), now(), '{}', 'en-US')
         returning id`,
        [orderId, buyer, firstDay, nextDay]
      );
      return { orderId, dayIds: rows.map(({ id }) => id) };
    };

    type Provider = {
      readonly issue: () => Effect.Effect<{
        pin: typeof syntheticPin;
        pinId: ReturnType<typeof IgloohomePinIdSchema.make>;
      }>;
      readonly reads?: string[];
      readonly readReservation?: DotyposService["Service"]["getReservationWithoutCustomer"];
      readonly intervalEndsEarly?: boolean;
      readonly isSignedIn?: () => boolean;
      readonly accessCookie?: string;
    };

    const load = (
      orderId: OrderId,
      tier: PassTier,
      viewer: CustomerAccountId | null,
      now: Temporal.Instant,
      provider: Provider
    ) => {
      const accessCodes = ReservationAccessService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            ReservationAccessRepository.Default,
            Layer.mock(IgloohomeService, { issueHourlyAlgoPin: provider.issue })
          )
        ),
        Layer.provide(Layer.mergeAll(database.layer, NodeCrypto.layer))
      );

      return Effect.runPromise(
        loadUnlimitedAccess(orderId, provider.accessCookie).pipe(
          Effect.provide(
            Layer.mergeAll(
              database.layer,
              accessCodes,
              Layer.mock(CurrentCustomerAccount, {
                requireActive: Effect.suspend(() =>
                  requireVerifiedIdentity(
                    viewer === null || provider.isSignedIn?.() === false
                      ? null
                      : {
                          ...testSessionProfile,
                          accountId: viewer,
                          deletionRequested: false,
                          email: testEmailAddress("pass-viewer"),
                        }
                  )
                ),
              }),
              Layer.mock(DotyposService, {
                getReservationWithoutCustomer:
                  provider.readReservation ??
                  ((id) =>
                    Effect.sync(() => {
                      const date = id.slice(-10);
                      provider.reads?.push(date);
                      const { startsAt, endsAt } = getCoworkReservationInterval(
                        tier === "open-space" ? "open-space" : "reserved-desk",
                        date
                      );
                      return {
                        id,
                        _tableId: "14",
                        status: "CONFIRMED",
                        startDate: startsAt,
                        endDate: provider.intervalEndsEarly
                          ? Temporal.Instant.from(endsAt)
                              .subtract({ minutes: 1 })
                              .toString()
                          : endsAt,
                        seats: 1,
                      };
                    })),
                getTables: () =>
                  Effect.succeed([{ id: "14", name: "Desk 14" }]),
              })
            )
          ),
          atInstant(now)
        )
      );
    };

    const issue = () =>
      Effect.succeed({
        pin: syntheticPin,
        pinId: IgloohomePinIdSchema.make("synthetic-unlimited-pin"),
      });

    const holderCookie = (
      orderId: OrderId,
      holderAccountId: CustomerAccountId
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const locale = "en-US";
          const url = yield* createUnlimitedAccessUrl({
            orderId,
            holderAccountId,
            locale,
            origin: new URL("https://workspace.example"),
          });
          const token = new URL(url).searchParams.get(
            unlimitedAccessTokenQueryParam
          )!;
          const cookie = yield* exchangeUnlimitedAccessToken({
            token,
            orderId,
            locale,
          });
          return cookie.value;
        })
      );

    const reassignToHolder = (orderId: OrderId) =>
      database.pool.query(
        "update pass_purchases set holder_account_id = $2, gift_claimed_at = now() where id = $1",
        [orderId, holder]
      );

    test("gates a gift to the claimed holder and never exposes a pass day as a reservation order", async () => {
      const {
        orderId,
        dayIds: [firstDayId],
      } = await seedPass("reserved-desk", true);
      const reads: string[] = [];
      const provider = { issue, reads };
      expect(
        await load(orderId, "reserved-desk", null, during, provider)
      ).toEqual({ state: "sign-in" });
      expect(
        await load(orderId, "reserved-desk", holder, during, provider)
      ).toEqual({ state: "not-found" });
      await database.pool.query(
        "update pass_purchases set gift_claimed_at = now() where id = $1",
        [orderId]
      );
      expect(
        await load(orderId, "reserved-desk", buyer, during, provider)
      ).toEqual({ state: "not-found" });
      expect(reads).toEqual([]);

      const ordinaryOrder = await Effect.runPromise(
        WorkspaceReservationRepository.pipe(
          Effect.flatMap((reservations) => reservations.findById(firstDayId)),
          Effect.provide(WorkspaceReservationRepository.Default),
          Effect.provide(database.layer)
        )
      );
      expect(ordinaryOrder).toBeNull();

      const lastMinute = nextMidnight.subtract({ minutes: 1 });
      expect(
        await load(orderId, "reserved-desk", holder, lastMinute, provider)
      ).toMatchObject({
        state: "available",
        day: 1,
        code: syntheticPin,
        endsAt: nextMidnight,
        deskLabel: "Desk 14",
      });
      expect(reads).toEqual([firstDay]);

      await database.pool.query(
        "update pass_purchases set status = 'withdrawn', access_ends_on = $2 where id = $1",
        [orderId, nextDay]
      );
      expect(
        await load(orderId, "reserved-desk", holder, lastMinute, provider)
      ).toMatchObject({ state: "available", continuesTomorrow: false });
      expect(
        await load(orderId, "reserved-desk", holder, nextMidnight, provider)
      ).toMatchObject({ state: "ended" });
    });

    test("opens for the named holder without a session and rejects replay after reassignment", async () => {
      const { orderId } = await seedPass("open-space");
      const accessCookie = await holderCookie(orderId, buyer);
      const reads: string[] = [];
      const provider = { issue, reads, accessCookie };

      expect(
        await load(orderId, "open-space", null, during, provider)
      ).toMatchObject({
        state: "available",
        code: syntheticPin,
        endsAt: openSpaceClosing,
      });
      await reassignToHolder(orderId);

      // Reopening the original email is still bound to its original holder.
      const reopenedCookie = await holderCookie(orderId, buyer);
      for (const cookie of [accessCookie, reopenedCookie]) {
        expect(
          await load(orderId, "open-space", null, during, {
            ...provider,
            accessCookie: cookie,
          })
        ).toEqual({ state: "not-found" });
      }
      expect(
        await load(orderId, "open-space", buyer, during, provider)
      ).toEqual({ state: "not-found" });
      expect(reads).toEqual([firstDay]);
      expect(
        await load(orderId, "open-space", holder, during, provider)
      ).toMatchObject({
        state: "available",
        code: syntheticPin,
      });
    });

    test("withholds the code if the pass changes holder during issuance", async () => {
      const { orderId } = await seedPass("open-space");
      const accessCookie = await holderCookie(orderId, buyer);
      const access = await load(orderId, "open-space", null, during, {
        accessCookie,
        issue: () =>
          Effect.promise(() => reassignToHolder(orderId)).pipe(
            Effect.andThen(issue())
          ),
      });
      expect(access).toEqual({ state: "not-found" });
    });

    test("withholds bearer access while the holder's login is unverified or awaiting deletion", async () => {
      const { orderId } = await seedPass("open-space");
      const accessCookie = await holderCookie(orderId, buyer);
      const reads: string[] = [];
      try {
        await database.pool.query(
          `update auth."user" set email_verified = false where id = $1`,
          [buyer]
        );
        expect(
          await load(orderId, "open-space", null, during, {
            issue,
            reads,
            accessCookie,
          })
        ).toEqual({ state: "not-found" });
        await database.pool.query(
          `update auth."user" set email_verified = true, deletion_requested_at = now() where id = $1`,
          [buyer]
        );
        expect(
          await load(orderId, "open-space", null, during, {
            issue,
            reads,
            accessCookie,
          })
        ).toEqual({ state: "not-found" });
        expect(reads).toEqual([]);
      } finally {
        await database.pool.query(
          `update auth."user" set email_verified = true, deletion_requested_at = null where id = $1`,
          [buyer]
        );
      }
    });

    test("only one request issues today's code and the next Prague date has a different grant", async () => {
      const { orderId, dayIds } = await seedPass("open-space");
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let issued = 0;
      const provider = {
        issue: () =>
          Effect.promise(async () => {
            issued++;
            started.resolve();
            await release.promise;
          }).pipe(Effect.andThen(issue())),
      };
      expect(
        await load(
          orderId,
          "open-space",
          buyer,
          during.subtract({ hours: 24 }),
          provider
        )
      ).toMatchObject({ state: "before-start" });

      const issuing = load(orderId, "open-space", buyer, during, provider);
      await Promise.race([
        started.promise,
        issuing.then(() => {
          throw new Error("Request finished before issuance");
        }),
      ]);
      try {
        expect(
          await load(orderId, "open-space", buyer, during, provider)
        ).toMatchObject({ state: "retry" });
        expect(issued).toBe(1);
      } finally {
        release.resolve();
      }
      expect(await issuing).toMatchObject({
        state: "available",
        day: 1,
        code: syntheticPin,
        endsAt: openSpaceClosing,
      });
      expect(
        await load(
          orderId,
          "open-space",
          buyer,
          during.add({ hours: 1 }),
          provider
        )
      ).toMatchObject({ state: "available", code: syntheticPin });
      expect(
        await load(orderId, "open-space", buyer, openSpaceClosing, provider)
      ).toMatchObject({ state: "closed", continuesTomorrow: true });
      expect(issued).toBe(1);
      expect(
        await load(orderId, "open-space", buyer, nextMidnight, provider)
      ).toMatchObject({ state: "available", day: 2 });
      expect(issued).toBe(2);
      const { rows } = await database.pool.query(
        "select workspace_reservation_id from reservation_access_grants where workspace_reservation_id = any($1)",
        [dayIds]
      );
      expect(rows).toHaveLength(2);
    });

    test("withholds a code when issuance completes across the closing boundary", async () => {
      const { orderId } = await seedPass("open-space");
      const access = await load(
        orderId,
        "open-space",
        buyer,
        openSpaceClosing.subtract({ seconds: 1 }),
        {
          issue: () =>
            TestClock.setTime(openSpaceClosing.epochMilliseconds).pipe(
              Effect.andThen(issue())
            ),
        }
      );
      expect(access).toMatchObject({ state: "closed" });
      expect(access).not.toHaveProperty("code");
    });

    test("uses live reservation facts without requiring the provider's customer profile", async () => {
      const { orderId } = await seedPass("open-space");
      const reads: string[] = [];
      expect(
        await load(orderId, "open-space", buyer, during, { issue, reads })
      ).toMatchObject({
        state: "available",
        code: syntheticPin,
      });
      expect(reads).toEqual([firstDay]);
      const access = await load(orderId, "open-space", buyer, during, {
        issue,
        intervalEndsEarly: true,
      });
      expect(access.state).toBe("retry");
      expect(access).not.toHaveProperty("code");
    });

    test("shows closed when the venue read fails at the Open Space cutoff", async () => {
      const { orderId } = await seedPass("open-space");
      const access = await load(
        orderId,
        "open-space",
        buyer,
        openSpaceClosing.subtract({ seconds: 1 }),
        {
          issue: () => Effect.die("Unexpected issuance"),
          readReservation: () =>
            TestClock.setTime(openSpaceClosing.epochMilliseconds).pipe(
              Effect.andThen(
                new DotyposRejected({
                  operation: "getReservationWithoutCustomer",
                  request: "reservation.get",
                  reason: "not-found",
                  message: "Synthetic venue record missing",
                })
              )
            ),
        }
      );
      expect(access).toMatchObject({
        state: "closed",
        continuesTomorrow: true,
      });
      expect(access).not.toHaveProperty("code");
    });

    test("withholds a newly issued PIN if the holder's session ended during issuance", async () => {
      const { orderId } = await seedPass("open-space");
      let signedIn = true;
      const access = await load(orderId, "open-space", buyer, during, {
        isSignedIn: () => signedIn,
        issue: () =>
          Effect.sync(() => {
            signedIn = false;
          }).pipe(Effect.andThen(issue())),
      });
      expect(access).toEqual({ state: "not-found" });
    });
  }
);
