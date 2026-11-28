import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import {
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  type DotyposReservation,
  DotyposReservationIdSchema,
  DotyposReservationSchema,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import type {
  AutomationConditionFilter,
  ReservationPayment,
  ReservationStay,
} from "@deskohub/workspace-admin-api";
import { Effect, Layer, Option, Schema } from "effect";
import type { WorkspaceCoworkProductTier } from "@/features/checkout/product-catalog";
import { orderIdSchema } from "@/features/order/order";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import type { CoworkStay } from "@/features/reservation/cowork-stay";
import { storedWorkspaceReservationDetailsSchema } from "@/features/reservation/persistence-contracts";
import {
  type ReservationFixtureInput,
  workspaceFixtures,
} from "@/shared/testing/workspace-fixtures.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import type { AudienceCondition, AudienceFilter } from "../audience-filter";
import { AutomationConditionEvaluation } from "../automation/backend/automation-condition-evaluation.service";
import { AutomationEvaluationFacts } from "../automation/backend/automation-evaluation-facts.service";
import type { DatePeriod } from "../date-period";
import { evaluateAudienceFilter } from "./audience-evaluation";
import {
  AudienceFactSource,
  audienceEvaluationAt,
} from "./audience-evaluation-context";
import { AudienceFactsService } from "./audience-facts.service";
import { CampaignCandidateRepository } from "./campaign-candidate.repository";

/**
 * Live facts read the earliest of all reservations, so the suite runs on a
 * database of its own.
 */
const testDatabase = await createWorkspacePostgresSuiteDatabase(
  "reservation_count_qualifiers"
);
afterAll(() => testDatabase?.close());

const run = crypto.randomUUID();
const now = Temporal.Instant.from("2026-10-19T10:00:00Z");
const context = audienceEvaluationAt(now);

const customerId = (label: string) =>
  DotyposCustomerIdSchema.make(`count-qualifier-${run}-${label}`);

/** How a fixture reservation was paid, beyond its paid stage. */
type Funding =
  | {
      readonly _tag: "Order";
      readonly amount: number;
      /** A refund done (`refunded`) or owed (`required`, with its target). */
      readonly refund?: {
        readonly state: "refunded" | "required";
        readonly refunded?: number;
        readonly target?: number;
      };
    }
  | { readonly _tag: "EntryPack"; readonly amount: number }
  | { readonly _tag: "Unlimited" }
  | { readonly _tag: "Unpaid" };

/** One customer's single Workspace reservation and its Dotypos visit. */
type Visit = {
  readonly label: string;
  readonly tier: WorkspaceCoworkProductTier;
  readonly date: string;
  /** The booked interval's stay; the tier decides the stay it reads as. */
  readonly interval: CoworkStay;
  readonly funding: Funding;
};

const order = (amount: number): Funding => ({ _tag: "Order", amount });

const visits = [
  // Stays: a Reserved Desk noon-to-noon booking is overnight; the same
  // interval on another tier, or a day interval, is a day stay.
  {
    label: "overnight-desk",
    tier: "reserved-desk",
    date: "2026-10-05",
    interval: "overnight",
    funding: order(65_000),
  },
  {
    label: "day-desk",
    tier: "reserved-desk",
    date: "2026-10-06",
    interval: "day",
    funding: order(45_000),
  },
  {
    label: "noon-to-noon-open-space",
    tier: "open-space",
    date: "2026-10-07",
    interval: "overnight",
    funding: { _tag: "Unpaid" },
  },
  // Payments, all day stays.
  {
    label: "entry-pack-funded",
    tier: "open-space",
    date: "2026-10-08",
    interval: "day",
    funding: { _tag: "EntryPack", amount: 0 },
  },
  {
    label: "entry-pack-with-paid-add-on",
    tier: "open-space",
    date: "2026-10-09",
    interval: "day",
    funding: { _tag: "EntryPack", amount: 15_000 },
  },
  {
    label: "unlimited-covered",
    tier: "open-space",
    date: "2026-10-10",
    interval: "day",
    funding: { _tag: "Unlimited" },
  },
  {
    label: "fully-discounted",
    tier: "open-space",
    date: "2026-10-11",
    interval: "day",
    funding: order(0),
  },
  {
    label: "refunded",
    tier: "open-space",
    date: "2026-10-12",
    interval: "day",
    funding: {
      _tag: "Order",
      amount: 45_000,
      refund: { state: "refunded", refunded: 45_000 },
    },
  },
  {
    label: "full-refund-owed",
    tier: "open-space",
    date: "2026-10-13",
    interval: "day",
    funding: {
      _tag: "Order",
      amount: 45_000,
      refund: { state: "required", refunded: 10_000, target: 45_000 },
    },
  },
  {
    // A cancellation owes a refund before its amount is known: the whole.
    label: "unknown-refund-owed",
    tier: "open-space",
    date: "2026-10-16",
    interval: "day",
    funding: { _tag: "Order", amount: 45_000, refund: { state: "required" } },
  },
  {
    label: "partial-refund-owed",
    tier: "open-space",
    date: "2026-10-14",
    interval: "day",
    funding: {
      _tag: "Order",
      amount: 45_000,
      refund: { state: "required", refunded: 10_000, target: 20_000 },
    },
  },
  {
    label: "partially-refunded",
    tier: "open-space",
    date: "2026-10-15",
    interval: "day",
    funding: {
      _tag: "Order",
      amount: 45_000,
      refund: { state: "refunded", refunded: 10_000 },
    },
  },
] as const satisfies readonly Visit[];

type Label = (typeof visits)[number]["label"] | "dotypos-only";

const of = (...labels: readonly Label[]) => labels.map(customerId);
const everyone = of(...visits.map(({ label }) => label), "dotypos-only");

const cowork = { family: "cowork", properties: [] } as const;

const reservationCount = (params: {
  readonly dateBasis: "visit" | "visitEnd";
  readonly period: DatePeriod;
  readonly stay?: ReservationStay;
  readonly payment?: ReservationPayment;
  readonly coworkOnly?: false;
}): AudienceCondition => {
  const { coworkOnly, ...rest } = params;
  return {
    _tag: "Condition",
    attribute: "reservationCount",
    params: { ...rest, ...(coworkOnly !== false && { product: cowork }) },
    operator: "gte",
    value: 1,
  };
};

const lastSixtyDays: DatePeriod = { _tag: "Last", count: 60, unit: "day" };
const anyTime: DatePeriod = { _tag: "AnyTime" };

describe.skipIf(!testDatabase)(
  "reservation counts qualified by stay and payment on disposable Postgres",
  () => {
    if (!testDatabase) return;
    const { db, pool } = testDatabase;
    const reservationIds: string[] = [];
    const accountId = `count-qualifier-holder-${run}`;
    const passId = orderIdSchema.make(crypto.randomUUID());
    const passAttemptId = crypto.randomUUID();

    /** One Entry pack, which funds the pack visits and stands in for an Unlimited pass. */
    const seedPass = async () => {
      await pool.query("insert into customer_accounts (id) values ($1)", [
        accountId,
      ]);
      await pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state,
           fulfillment_state, paid_at, fulfilled_at)
         values ($1, 'pass-purchase', '1', 'paid', 'fulfilled', $2, $2)`,
        [passId, "2026-09-01T10:00:00Z"]
      );
      await pool.query(
        `insert into payment_attempts (id, order_id, provider, state,
           provider_order_id, amount_value, amount_exponent, currency)
         values ($1, $2, 'nexi', 'paid', $1, 190000, 2, 'CZK')`,
        [passAttemptId, passId]
      );
      await pool.query(
        "update orders set active_payment_attempt_id = $1 where id = $2",
        [passAttemptId, passId]
      );
      await pool.query(
        `insert into pass_purchases (id, buyer_account_id, holder_account_id, product,
           tier, entry_count, status, valid_from, valid_until, quote, locale,
           created_at, buyer_confirmation_delivered_at)
         values ($1, $2, $2, 'entry-pack', 'open-space', 5, 'active', '2026-09-01',
           '2026-12-31', '{}', 'en-US', $3, $3)`,
        [passId, accountId, "2026-09-01T10:00:00Z"]
      );
    };

    const fundingColumns = (
      funding: Funding,
      date: string
    ): ReservationFixtureInput["overrides"] =>
      funding._tag === "Unlimited"
        ? {
            passId,
            serviceDate: plainDateStringSchema.make(date),
            passDayTableId: DotyposTableIdSchema.make(
              `count-qualifier-table-${run}`
            ),
          }
        : {};

    /** Records how each paid reservation was paid. */
    const seedFunding = async (
      reservationId: string,
      { funding, date }: Visit
    ) => {
      if (funding._tag === "Unlimited" || funding._tag === "Unpaid") return;
      const attempt = crypto.randomUUID();
      const refund = funding._tag === "Order" ? funding.refund : undefined;
      await pool.query(
        `insert into payment_attempts (id, workspace_reservation_id, order_id,
           provider, state, provider_order_id, amount_value, amount_exponent,
           currency, refund_state, refunded_amount_value, refunded_at,
           refund_target_value)
         values ($1, $2, $2, $3, 'paid', $4, $5, 2, 'CZK', $6, $7, $8, $9)`,
        [
          attempt,
          reservationId,
          funding.amount === 0 ? "internal" : "nexi",
          funding.amount === 0 ? null : attempt,
          funding.amount,
          refund?.state ?? "not_required",
          refund?.refunded ?? null,
          refund?.refunded === undefined ? null : "2026-10-16T10:00:00Z",
          refund?.target ?? null,
        ]
      );
      await pool.query(
        "update workspace_reservations set active_payment_attempt_id = $1 where id = $2",
        [attempt, reservationId]
      );
      if (funding._tag === "EntryPack") {
        await pool.query(
          "insert into pass_entry_claims (reservation_id, pass_id, date, status) values ($1, $2, $3, 'consumed')",
          [reservationId, passId, date]
        );
      }
    };

    const confirmedAt = Temporal.Instant.from("2026-10-01T08:00:00Z");
    const decodeDetails = Schema.decodeUnknownSync(
      storedWorkspaceReservationDetailsSchema
    );

    const seeded = (async () => {
      await seedPass();
      const rows = await Effect.runPromise(
        workspaceFixtures(db).reservations(
          visits.map((visit) => ({
            stage: {
              reservation: "confirmed",
              payment: visit.funding._tag === "Unpaid" ? "pending" : "paid",
              fulfillment: "fulfilled",
            },
            customer: customerId(visit.label),
            details: decodeDetails({
              kind: "cowork",
              entryTier: visit.tier,
              coffee: visit.tier === "reserved-desk",
            }),
            at: confirmedAt,
            locale: "cs-CZ",
            overrides: {
              createdAt: confirmedAt,
              ...fundingColumns(visit.funding, visit.date),
            },
          }))
        )
      );
      reservationIds.push(...rows.map(({ id }) => id));
      const dotyposVisits = await Promise.all(
        rows.map(async (row, index) => {
          const visit = visits[index];
          if (visit === undefined) {
            throw new Error("Reservation fixture returned an unexpected row");
          }
          const id = row.dotyposReservationId;
          if (id === null) {
            throw new Error(
              "Reservation fixture has no Dotypos reservation ID"
            );
          }
          await seedFunding(row.id, visit);
          const { startsAt, endsAt } = getCoworkReservationInterval(
            // The interval is booked as a Reserved Desk stay of that length;
            // the stored tier alone decides whether it reads as overnight.
            "reserved-desk",
            visit.date,
            visit.interval
          );
          return dotyposVisit(id, row.dotyposCustomerId, startsAt, endsAt);
        })
      );
      // A visit Workspace didn't book: Dotypos alone knows it.
      const dotyposOnly = dotyposVisit(
        DotyposReservationIdSchema.make(`count-qualifier-${run}-dotypos-only`),
        customerId("dotypos-only"),
        "2026-10-14T08:00:00Z",
        "2026-10-14T16:00:00Z"
      );
      return [...dotyposVisits, dotyposOnly];
    })();

    afterAll(async () => {
      await pool.query(
        "delete from pass_entry_claims where reservation_id = any($1)",
        [reservationIds]
      );
      await pool.query(
        "update workspace_reservations set active_payment_attempt_id = null where id = any($1)",
        [reservationIds]
      );
      await pool.query(
        "delete from payment_attempts where workspace_reservation_id = any($1)",
        [reservationIds]
      );
      await pool.query(
        "delete from workspace_reservations where id = any($1)",
        [reservationIds]
      );
      await pool.query("delete from pass_purchases where id = $1", [passId]);
      await pool.query(
        "update orders set active_payment_attempt_id = null where id = $1",
        [passId]
      );
      await pool.query("delete from payment_attempts where id = $1", [
        passAttemptId,
      ]);
      await pool.query("delete from orders where id = $1", [passId]);
      await pool.query("delete from customer_accounts where id = $1", [
        accountId,
      ]);
    });

    const dotyposLayer = async () =>
      DotyposServiceMock(
        makeInMemoryDotypos({ reservations: await seeded }).service
      );

    const candidatesLayer = CampaignCandidateRepository.Default.pipe(
      Layer.provide(testDatabase.layer)
    );

    /** The customers an audience filter matches, resolved live. */
    const audienceMatches = async (filter: AudienceFilter) => {
      const facts = await Effect.runPromise(
        AudienceFactsService.pipe(
          Effect.flatMap((service) =>
            service.resolve({ filter, contexts: [context] })
          ),
          Effect.provide(
            AudienceFactsService.Default.pipe(
              Layer.provide(
                Layer.mergeAll(candidatesLayer, await dotyposLayer())
              )
            )
          )
        )
      );
      return everyone.filter(
        (dotyposCustomerId) =>
          evaluateAudienceFilter({
            filter,
            candidate: {
              dotyposCustomerId,
              locale: "cs-CZ",
              hasAccount: false,
            },
            context,
            facts,
            profile: Option.none(),
          }) === "match"
      );
    };

    /**
     * The customers an automation condition matches, from the facts a unit
     * fetches for its customers and from live facts, which must agree.
     */
    const automationMatches = async (condition: AudienceCondition) => {
      const filter: AutomationConditionFilter = {
        _tag: "Group",
        operator: "and",
        filters: [condition],
      };
      const dotypos = await dotyposLayer();
      const audienceFacts = AudienceFactsService.Default.pipe(
        Layer.provide(Layer.mergeAll(candidatesLayer, dotypos))
      );
      const layer = Layer.mergeAll(
        AutomationConditionEvaluation.Default.pipe(
          Layer.provide(Layer.mergeAll(candidatesLayer, audienceFacts))
        ),
        AutomationEvaluationFacts.Default.pipe(
          Layer.provide(Layer.merge(testDatabase.layer, dotypos))
        )
      );
      const decisions = await Effect.runPromise(
        Effect.gen(function* () {
          const evaluationFacts = yield* AutomationEvaluationFacts;
          const evaluation = yield* AutomationConditionEvaluation;
          const plan = yield* evaluationFacts.plan({
            filters: { condition: filter },
            context,
          });
          const fetched = yield* evaluationFacts.fetch({
            reads: plan.reads,
            customers: everyone,
          });
          const evaluate = (facts: AudienceFactSource) =>
            evaluation.evaluate({
              condition: filter,
              plan,
              customers: everyone,
              context,
              facts,
            });
          return {
            fetched: yield* evaluate(fetched),
            live: yield* evaluate(AudienceFactSource.Live()),
          };
        }).pipe(Effect.provide(layer))
      );
      const matched = (outcomes: typeof decisions.fetched) =>
        everyone.filter((id) => outcomes.get(id)?.outcome === "match");
      expect(matched(decisions.live)).toEqual(matched(decisions.fetched));
      return matched(decisions.fetched);
    };

    test("counts only the visits whose booked interval and tier give the stay", async () => {
      expect(
        await audienceMatches(
          reservationCount({
            dateBasis: "visitEnd",
            period: lastSixtyDays,
            stay: "overnight",
          })
        )
      ).toEqual(of("overnight-desk"));
      expect(
        await audienceMatches(
          reservationCount({
            dateBasis: "visitEnd",
            period: lastSixtyDays,
            stay: "day",
          })
        )
      ).toEqual(
        everyone.filter(
          (id) => !of("overnight-desk", "dotypos-only").includes(id)
        )
      );
    });

    test("reads the visits' intervals for a stay at any time", async () => {
      expect(
        await audienceMatches(
          reservationCount({
            dateBasis: "visit",
            period: anyTime,
            stay: "overnight",
          })
        )
      ).toEqual(of("overnight-desk"));
    });

    test("counts only reservations paid by their own order with an amount kept", async () => {
      for (const dateBasis of ["visit", "visitEnd"] as const) {
        expect(
          await audienceMatches(
            reservationCount({
              dateBasis,
              period: dateBasis === "visit" ? anyTime : lastSixtyDays,
              payment: "individual",
            })
          )
        ).toEqual(
          of(
            "overnight-desk",
            "day-desk",
            "partial-refund-owed",
            "partially-refunded"
          )
        );
      }
    });

    test("counts every Workspace reservation without qualifiers", async () => {
      expect(
        await audienceMatches(
          reservationCount({
            dateBasis: "visitEnd",
            period: lastSixtyDays,
            coworkOnly: false,
          })
        )
      ).toEqual(everyone.filter((id) => !of("dotypos-only").includes(id)));
    });

    test("qualifies automation conditions alike from fetched and live facts", async () => {
      expect(
        await automationMatches(
          reservationCount({
            dateBasis: "visitEnd",
            period: lastSixtyDays,
            stay: "day",
            payment: "individual",
          })
        )
      ).toEqual(of("day-desk", "partial-refund-owed", "partially-refunded"));
      expect(
        await automationMatches(
          reservationCount({
            dateBasis: "visitEnd",
            period: lastSixtyDays,
            stay: "overnight",
          })
        )
      ).toEqual(of("overnight-desk"));
      expect(
        await automationMatches(
          reservationCount({ dateBasis: "visitEnd", period: lastSixtyDays })
        )
      ).toEqual(everyone.filter((id) => !of("dotypos-only").includes(id)));
    });
  }
);

function dotyposVisit(
  id: DotyposReservation["id"],
  customer: DotyposCustomerId,
  startsAt: string,
  endsAt: string
): DotyposReservation {
  return Schema.decodeSync(DotyposReservationSchema)({
    id,
    _branchId: "count-qualifier-branch",
    _cloudId: "count-qualifier-cloud",
    _customerId: customer,
    startDate: startsAt,
    endDate: endsAt,
    seats: "1",
    status: "CONFIRMED",
  });
}
