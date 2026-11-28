import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import {
  DotyposBranchIdSchema,
  DotyposCloudIdSchema,
  type DotyposCustomer,
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  type DotyposReservation,
  DotyposReservationIdSchema,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { testEmailAddress } from "@deskohub/test-email";
import {
  type AutomationConditionFilter,
  AutomationDryRun as AutomationDryRunWire,
  AutomationFlow,
  type AutomationFlowType,
  type DatePeriodType,
} from "@deskohub/workspace-admin-api";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { Array as Arr, Effect, Exit, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  customerAccounts,
  customerEvents,
  customerMarketingConsents,
  emailCampaignAudiences,
  emailCampaignAutomationCustomerClaims,
  emailCampaignAutomationPreviewRows,
  emailCampaignAutomationPreviews,
  emailCampaignAutomationRuns,
  emailCampaignAutomations,
  emailCampaignAutomationVersions,
  emailCampaignAutomationWorkUnits,
  emailCampaignDeliveryBatches,
  emailCampaignRecipients,
  emailCampaignSends,
  emailCampaigns,
  workspaceReservations,
} from "@/db/schema";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { getPassReminderEndDates } from "@/features/passes/pass-reminder-schedule";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import type { AudienceCondition, AudienceFilter } from "../../audience-filter";
import { AudienceFactsService } from "../../backend/audience-facts.service";
import { CampaignCandidateRepository } from "../../backend/campaign-candidate.repository";
import { CampaignRecipientService } from "../../backend/campaign-recipient.service";
import {
  deleteAutomatedCampaigns,
  everyoneFilter,
  passReminderEmailDocumentFixture,
  seedAutomatedCampaign,
  seedAutomatedSend,
  seedCampaignSend,
  seedPublishedEmail,
} from "../../backend/email-campaigns.test-utils";
import type {
  CampaignAudienceId,
  CampaignId,
} from "../../campaign-identifiers";
import { campaignLocales } from "../../recipient-locale";
import type {
  AutomationPreviewId,
  AutomationWorkUnitId,
} from "../automation-identifiers";
import { oneOffCampaignGapEndsAt } from "../automation-send-policies";
import { automationTickAtOrAfter } from "../automation-ticks";
import { AutomationConditionEvaluation } from "./automation-condition-evaluation.service";
import { AutomationDryRun } from "./automation-dry-run.service";
import {
  makeAutomationDryRunner,
  passReminderReadsTestLayer,
} from "./automation-dry-run.test-utils";
import { automationEngineTestLayer } from "./automation-engine.test-utils";
import {
  databaseInstant,
  makeAutomationEngineScenario,
} from "./automation-engine-scenario.test-utils";
import { AutomationEvaluationFacts } from "./automation-evaluation-facts.service";
import {
  automationFlowFixture,
  automationLifecycleTestKit,
} from "./automation-lifecycle.test-utils";
import { nextPassReminderPreviewOccurrence } from "./automation-pass-reminder-preview";
import { makePreviewUnitHandler } from "./automation-preview-unit";
import {
  seedAutomationRun,
  seedKnownCustomers,
} from "./automation-steps.test-utils";
import {
  comeBackOfferFlow,
  lapsedRegularsFilter,
  reviewRequestFlow,
} from "./automation-stories.test-utils";
import { AutomationUnitProcessor } from "./automation-unit-processor.service";
import { makeAutomationUnitQueueFake } from "./automation-unit-queue.test-utils";

/**
 * A dry run reads every active consent, so the suite runs on a database of
 * its own.
 */
const testDatabase =
  await createWorkspacePostgresSuiteDatabase("automation_dry_run");
afterAll(() => testDatabase?.close());
const runId = crypto.randomUUID().slice(0, 8);
const now = Temporal.Now.instant().round({
  smallestUnit: "second",
  roundingMode: "floor",
});
const ago = (duration: Temporal.DurationLike) => now.subtract(duration);
const pragueOf = (instant: Temporal.Instant) =>
  instant.toZonedDateTimeISO("Europe/Prague");

const customerId = (label: string) =>
  DotyposCustomerIdSchema.make(`dry-run-${runId}-${label}`);

const profile = (
  id: DotyposCustomerId,
  options: { readonly tags?: readonly string[]; readonly email?: string } = {}
) =>
  ({
    id,
    _cloudId: DotyposCloudIdSchema.make("dry-run-cloud"),
    firstName: "Test",
    lastName: id.slice(-4),
    email: options.email ?? testEmailAddress(id),
    points: "0",
    flags: "0",
    display: true,
    deleted: false,
    tags: options.tags ?? [],
  }) satisfies DotyposCustomer;

const decodeFlow = Schema.decodeUnknownSync(AutomationFlow);
const readPreviewCustomers = Schema.decodeUnknownSync(
  Schema.Struct({ customerIds: Schema.Array(DotyposCustomerIdSchema) })
);

const send = { _tag: "Send", id: "send" } as const;
const waitHours = (id: string, count: number) => ({
  _tag: "Wait",
  id,
  wait: { _tag: "Duration", count, unit: "hour" },
});
const condition = (id: string, filter: AutomationConditionFilter) => ({
  _tag: "Condition",
  id,
  filter,
});
const noEmailFromThisCampaign: AudienceCondition = {
  attribute: "campaignEmailCount",
  _tag: "Condition",
  params: {
    purpose: "any",
    period: { _tag: "AnyTime" },
    campaign: { _tag: "This" },
  },
  operator: "eq",
  value: 0,
};
const taggedVip: AudienceCondition = {
  attribute: "dotyposTags",
  _tag: "Condition",
  operator: "anyOf",
  value: ["vip"],
};
const weekly = (weekday: string) => ({
  weekdays: [weekday],
  hours: [10],
});

/** The mutable Dotypos fake: tests change what it returns between previews. */
const dotyposState = {
  customers: Arr.empty<DotyposCustomer>(),
  reservations: Arr.empty<DotyposReservation>(),
  failNextCustomerPage: false,
  customerPageCalls: Arr.empty<number>(),
  reservationReads: 0,
  /** Fails every reservation lookup by id that asks for any id. */
  failReservationLookups: false,
  reservationLookups: Arr.empty<number>(),
};
const dotypos = DotyposServiceMock({
  getCustomersByIds: (ids) => {
    const requested = [...ids];
    dotyposState.customerPageCalls.push(requested.length);
    if (dotyposState.failNextCustomerPage) {
      dotyposState.failNextCustomerPage = false;
      return Effect.fail(
        new DotyposUnavailable({
          operation: "getCustomersByIds",
          reason: "server",
          httpStatus: 503,
        })
      );
    }
    return makeInMemoryDotypos({
      customers: dotyposState.customers,
    }).service.getCustomersByIds(requested);
  },

  listReservations: (options) => {
    dotyposState.reservationReads += 1;
    return makeInMemoryDotypos({
      reservations: dotyposState.reservations,
    }).service.listReservations(options);
  },
  getReservationsByIds: (ids, readOptions) => {
    dotyposState.reservationReads += 1;
    const asked = [...ids].length;
    dotyposState.reservationLookups.push(asked);
    if (dotyposState.failReservationLookups && asked > 0) {
      return Effect.fail(
        new DotyposUnavailable({
          operation: "getReservationsByIds",
          reason: "server",
          httpStatus: 503,
        })
      );
    }
    return makeInMemoryDotypos({
      reservations: dotyposState.reservations,
    }).service.getReservationsByIds(ids, readOptions);
  },
  listReservationsPage: (options) => {
    dotyposState.reservationReads += 1;
    return makeInMemoryDotypos({
      reservations: dotyposState.reservations,
    }).service.listReservationsPage(options);
  },
  listActiveReservationsPage: (interval, page) =>
    makeInMemoryDotypos({
      reservations: dotyposState.reservations,
    }).service.listActiveReservationsPage(interval, page),
});

describe.skipIf(!testDatabase)(
  "AutomationDryRun on disposable Postgres",
  () => {
    if (!testDatabase) return;
    const { db } = testDatabase;
    const kit = automationLifecycleTestKit(testDatabase, { now });
    const campaignIds: CampaignId[] = [];
    const audienceIds: CampaignAudienceId[] = [];
    const reservationIds: WorkspaceReservationId[] = [];
    /** Campaigns whose seeded claims must go before their runs. */
    const claimedCampaignIds: CampaignId[] = [];

    const candidates = CampaignCandidateRepository.Default.pipe(
      Layer.provide(testDatabase.layer)
    );
    const audienceFacts = AudienceFactsService.Default.pipe(
      Layer.provide(Layer.mergeAll(candidates, dotypos))
    );
    const capabilities = Layer.mergeAll(
      testDatabase.layer,
      dotypos,
      candidates,
      passReminderReadsTestLayer(testDatabase),
      CampaignRecipientService.Default.pipe(
        Layer.provide(Layer.mergeAll(candidates, audienceFacts))
      ),
      AutomationConditionEvaluation.Default.pipe(
        Layer.provide(Layer.mergeAll(candidates, audienceFacts))
      ),
      AutomationEvaluationFacts.Default.pipe(
        Layer.provide(Layer.merge(testDatabase.layer, dotypos))
      )
    );
    const dryRunLayer = AutomationDryRun.Default.pipe(
      Layer.provide(capabilities)
    );
    const engineLayer = Effect.runPromise(
      makePreviewUnitHandler.pipe(Effect.provide(capabilities))
    ).then((previewHandler) =>
      automationEngineTestLayer({
        database: testDatabase,
        queue: makeAutomationUnitQueueFake(),
        handlers: [previewHandler],
      })
    );

    const run = <A, E>(effect: Effect.Effect<A, E, AutomationDryRun>) =>
      Effect.runPromise(effect.pipe(Effect.provide(dryRunLayer)));
    const runExit = <A, E>(effect: Effect.Effect<A, E, AutomationDryRun>) =>
      Effect.runPromiseExit(effect.pipe(Effect.provide(dryRunLayer)));
    const query = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect);

    const start = (campaignId: CampaignId) =>
      run(
        Effect.flatMap(AutomationDryRun, (dryRun) => dryRun.start(campaignId))
      );
    const read = (
      previewId: AutomationPreviewId,
      page: { readonly cursor?: string; readonly limit?: number } = {}
    ) =>
      run(
        Effect.flatMap(AutomationDryRun, (dryRun) =>
          dryRun.get({ previewId, ...page })
        )
      );

    const unitsOf = (previewId: AutomationPreviewId) =>
      query(
        db
          .select()
          .from(emailCampaignAutomationWorkUnits)
          .where(
            like(emailCampaignAutomationWorkUnits.key, `preview:${previewId}:%`)
          )
          .orderBy(asc(emailCampaignAutomationWorkUnits.key))
      );

    /** Delivers one unit: enqueues it as a promotion would, then processes it. */
    const processUnit = async (unitId: AutomationWorkUnitId) => {
      await query(
        db
          .update(emailCampaignAutomationWorkUnits)
          .set({ status: "enqueued", enqueuedAt: now })
          .where(
            and(
              eq(emailCampaignAutomationWorkUnits.id, unitId),
              inArray(emailCampaignAutomationWorkUnits.status, [
                "planned",
                "enqueued",
              ])
            )
          )
      );
      return Effect.runPromiseExit(
        Effect.flatMap(AutomationUnitProcessor, (processor) =>
          processor.process(unitId)
        ).pipe(Effect.provide(await engineLayer))
      );
    };

    const processAll = async (
      previewId: AutomationPreviewId,
      order: "forward" | "reverse" = "forward"
    ) => {
      const units = await unitsOf(previewId);
      for (const unit of order === "forward" ? units : units.toReversed()) {
        const exit = await processUnit(unit.id);
        expect(Exit.isSuccess(exit)).toBe(true);
      }
    };

    const rowsOf = (previewId: AutomationPreviewId) =>
      query(
        db
          .select()
          .from(emailCampaignAutomationPreviewRows)
          .where(eq(emailCampaignAutomationPreviewRows.previewId, previewId))
          .orderBy(
            asc(emailCampaignAutomationPreviewRows.triggerAt),
            asc(emailCampaignAutomationPreviewRows.dotyposCustomerId)
          )
      );

    const previewRow = (previewId: AutomationPreviewId) =>
      query(
        db
          .select()
          .from(emailCampaignAutomationPreviews)
          .where(eq(emailCampaignAutomationPreviews.id, previewId))
      ).then(([row]) => requireValue(row));

    const seedAudience = async (filter: AudienceFilter) => {
      const [audience] = await query(
        db
          .insert(emailCampaignAudiences)
          .values({ title: `Dry run ${runId}`, filter })
          .returning({ id: emailCampaignAudiences.id })
      );
      audienceIds.push(requireValue(audience).id);
      return requireValue(audience).id;
    };

    /** An automated campaign with its audience and working-copy flow. */
    const seedAutomation = async (input: {
      readonly flow: AutomationFlowType;
      readonly filter?: AudienceFilter;
      readonly purpose?: "marketing" | "operational";
    }) => {
      const campaignId = await seedAutomatedCampaign(db, {
        purpose: input.purpose ?? "operational",
        status: "draft",
      });
      campaignIds.push(campaignId);
      const audienceId = await seedAudience(input.filter ?? everyoneFilter);
      await query(
        db
          .update(emailCampaigns)
          .set({ audienceId })
          .where(eq(emailCampaigns.id, campaignId))
      );
      await query(
        db.insert(emailCampaignAutomations).values({
          campaignId,
          flow: Schema.encodeSync(AutomationFlow)(input.flow),
        })
      );
      return campaignId;
    };

    const editFlow = (campaignId: CampaignId, flow: AutomationFlowType) =>
      query(
        db
          .update(emailCampaignAutomations)
          .set({ flow: Schema.encodeSync(AutomationFlow)(flow) })
          .where(eq(emailCampaignAutomations.campaignId, campaignId))
      );

    type SeedReservation = {
      readonly label: string;
      readonly customer: DotyposCustomerId;
      readonly startsAt: Temporal.Instant;
      readonly endsAt: Temporal.Instant;
      /** Dotypos cancelled it; Workspace still has it booked. */
      readonly dotyposCancelled?: boolean;
      /** Workspace cancelled it at this instant. */
      readonly workspaceCancelledAt?: Temporal.Instant;
      /** When it was booked; sixty days ago by default. */
      readonly bookedAt?: Temporal.Instant;
    };

    const reservationIdOf = (label: string) =>
      workspaceReservationIdSchema.make(`dry-run-workspace-${runId}-${label}`);

    const seedReservations = async (
      reservations: readonly SeedReservation[]
    ) => {
      const dotyposReservationIdOf = (label: string) =>
        DotyposReservationIdSchema.make(
          `dry-run-reservation-${runId}-${label}`
        );
      const rows = await query(
        workspaceFixtures(db).reservations(
          reservations.map((reservation) => {
            const confirmedAt = reservation.bookedAt ?? ago({ hours: 24 * 60 });
            const cancelledAt = reservation.workspaceCancelledAt;
            return {
              stage: {
                reservation: cancelledAt ? "cancelled" : "confirmed",
                payment: "paid",
                fulfillment: "fulfilled",
              },
              customer: reservation.customer,
              at: confirmedAt,
              locale: "cs-CZ",
              overrides: {
                id: reservationIdOf(reservation.label),
                dotyposReservationId: dotyposReservationIdOf(reservation.label),
                createdAt: confirmedAt,
                ...(cancelledAt && {
                  reservationConfirmedAt: confirmedAt,
                  reservationCancelledAt: cancelledAt,
                }),
              },
            };
          })
        )
      );
      reservationIds.push(...rows.map(({ id }) => id));
      dotyposState.reservations.push(
        ...reservations.map(
          (reservation) =>
            ({
              id: dotyposReservationIdOf(reservation.label),
              _branchId: DotyposBranchIdSchema.make("dry-run-branch"),
              _cloudId: DotyposCloudIdSchema.make("dry-run-cloud"),
              _customerId: reservation.customer,
              startDate: reservation.startsAt.toString(),
              endDate: reservation.endsAt.toString(),
              seats: "1",
              status: reservation.dotyposCancelled ? "CANCELLED" : "CONFIRMED",
            }) satisfies DotyposReservation
        )
      );
    };

    const moveDotyposReservation = (
      label: string,
      times: {
        readonly startsAt: Temporal.Instant;
        readonly endsAt: Temporal.Instant;
      }
    ) => {
      const id = `dry-run-reservation-${runId}-${label}`;
      dotyposState.reservations = dotyposState.reservations.map(
        (reservation) =>
          reservation.id === id
            ? {
                ...reservation,
                startDate: times.startsAt.toString(),
                endDate: times.endsAt.toString(),
              }
            : reservation
      );
    };

    const seedEvents = async (
      events: readonly {
        readonly kind:
          | "reservation-booked"
          | "reservation-cancelled"
          | "reservation-started"
          | "reservation-finished";
        readonly reservation: string;
        readonly customer: DotyposCustomerId;
        readonly occurredAt: Temporal.Instant;
      }[]
    ) => {
      const rows = events.map((event) => ({
        kind: event.kind,
        occurredAt: event.occurredAt,
        recordedAt: event.occurredAt,
        dotyposCustomerId: event.customer,
        workspaceReservationId: reservationIdOf(event.reservation),
      }));
      const ids: (typeof customerEvents.$inferSelect)["id"][] = [];
      for (let index = 0; index < rows.length; index += 500) {
        const inserted = await query(
          db
            .insert(customerEvents)
            .values(rows.slice(index, index + 500))
            .returning({ id: customerEvents.id })
        );
        ids.push(...inserted.map(({ id }) => id));
      }
      return ids;
    };

    /** Customers Workspace knows (one booked reservation each) with Dotypos profiles. */
    const seedScheduleCustomers = async (label: string, count: number) => {
      const ids = Array.from({ length: count }, (_, index) =>
        customerId(`${label}-${String(index).padStart(3, "0")}`)
      );
      dotyposState.customers.push(
        ...ids.map((id, index) =>
          profile(id, { tags: index < 10 ? ["vip"] : [] })
        )
      );
      await seedReservations(
        ids.map((id, index) => ({
          label: `${label}-${index}`,
          customer: id,
          startsAt: ago({ hours: 24 * 40 }),
          endsAt: ago({ hours: 24 * 40 - 2 }),
        }))
      );
      return ids;
    };

    const seedPassHolder = async (
      dotyposCustomerId: DotyposCustomerId,
      options: Parameters<typeof profile>[1] = { tags: ["vip"] }
    ) => {
      const id = crypto.randomUUID();
      await testDatabase.pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2)",
        [id, dotyposCustomerId]
      );
      await testDatabase.pool.query(
        `insert into auth."user" (id, name, email, email_verified)
         values ($1, 'Synthetic holder', $2, true)`,
        [id, testEmailAddress(dotyposCustomerId)]
      );
      dotyposState.customers.push(profile(dotyposCustomerId, options));
      return id;
    };

    const seedPass = async (input: {
      readonly holder: string;
      readonly kind: "entry-pack" | "unlimited";
      readonly validUntil: string;
    }) => {
      const passId = crypto.randomUUID();
      await testDatabase.pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, fulfilled_at)
         values ($1, 'pass-purchase', 'synthetic-billing-id', 'complimentary', 'fulfilled', now())`,
        [passId]
      );
      await testDatabase.pool.query(
        `insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier,
           entry_count, unlimited_coffee, status, valid_from, valid_until, quote, locale, created_at)
         values ($1, $2, $2, $3, 'open-space',
           case when $3 = 'entry-pack' then 5 end,
           case when $3 = 'unlimited' then false end, 'active',
           $4::date - 30, $4, '{}', 'en-US', now())`,
        [passId, input.holder, input.kind, input.validUntil]
      );
      return passId;
    };

    afterAll(async () => {
      if (claimedCampaignIds.length > 0) {
        await query(
          db
            .delete(emailCampaignAutomationCustomerClaims)
            .where(
              inArray(
                emailCampaignAutomationCustomerClaims.campaignId,
                claimedCampaignIds
              )
            )
        );
      }
      await kit.cleanup();
      await deleteAutomatedCampaigns(db, campaignIds);
      if (audienceIds.length > 0) {
        await query(
          db
            .delete(emailCampaignAudiences)
            .where(inArray(emailCampaignAudiences.id, audienceIds))
        );
      }
      if (reservationIds.length > 0) {
        await query(
          db
            .delete(workspaceReservations)
            .where(inArray(workspaceReservations.id, reservationIds))
        );
      }
    });

    test("replays 30 days of events with per-customer overlays", async () => {
      const [alice, bob, carol, dave, erin, frank, gina] = [
        customerId("alice"),
        customerId("bob"),
        customerId("carol"),
        customerId("dave"),
        customerId("erin"),
        customerId("frank"),
        customerId("gina"),
      ];
      const finished = (
        label: string,
        customer: DotyposCustomerId,
        at: Temporal.Instant
      ) => ({
        label,
        customer,
        startsAt: at.subtract({ hours: 2 }),
        endsAt: at,
      });
      await seedReservations([
        finished("alice-1", alice, ago({ hours: 24 * 20 })),
        finished("alice-2", alice, ago({ hours: 24 * 19.5 })),
        finished("alice-3", alice, ago({ hours: 24 * 10 })),
        {
          ...finished("bob", bob, ago({ hours: 24 * 5 })),
          dotyposCancelled: true,
        },
        {
          ...finished("carol", carol, ago({ hours: 24 * 8 })),
          workspaceCancelledAt: ago({ hours: 24 * 7.5 }),
        },
        finished("carol-anchor", carol, ago({ hours: 24 * 40 })),
        {
          ...finished("dave", dave, ago({ hours: 24 * 8 })),
          workspaceCancelledAt: ago({ hours: 24 * 6 }),
        },
        finished("dave-anchor", dave, ago({ hours: 24 * 40 })),
        finished("erin", erin, ago({ hours: 12 })),
        // An office visit that started 35 days ago and finished 10 days ago.
        {
          label: "frank",
          customer: frank,
          startsAt: ago({ hours: 24 * 35 }),
          endsAt: ago({ hours: 24 * 10 }),
        },
        // Extended: the sweep saw it finish 15 days ago, then 14 days ago.
        finished("gina", gina, ago({ hours: 24 * 14 })),
      ]);
      const finishedEvent = (
        reservation: string,
        customer: DotyposCustomerId,
        occurredAt: Temporal.Instant
      ) => ({
        kind: "reservation-finished" as const,
        reservation,
        customer,
        occurredAt,
      });
      const [
        e1,
        e2,
        e3,
        bobEvent,
        carolEvent,
        daveEvent,
        erinEvent,
        frankEvent,
        ginaFirst,
        ginaSecond,
      ] = await seedEvents([
        finishedEvent("alice-1", alice, ago({ hours: 24 * 20 })),
        finishedEvent("alice-2", alice, ago({ hours: 24 * 19.5 })),
        finishedEvent("alice-3", alice, ago({ hours: 24 * 10 })),
        finishedEvent("bob", bob, ago({ hours: 24 * 5 })),
        finishedEvent("carol", carol, ago({ hours: 24 * 8 })),
        finishedEvent("dave", dave, ago({ hours: 24 * 8 })),
        finishedEvent("erin", erin, ago({ hours: 12 })),
        finishedEvent("frank", frank, ago({ hours: 24 * 10 })),
        finishedEvent("gina", gina, ago({ hours: 24 * 15 })),
        finishedEvent("gina", gina, ago({ hours: 24 * 14 })),
      ]);
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: { _tag: "ReservationFinished" },
          steps: [
            condition("first", noEmailFromThisCampaign),
            waitHours("day", 24),
            send,
          ],
        }),
      });

      const started = await start(campaignId);
      expect(started.kind).toBe("replay");
      await processAll(started.previewId);

      const preview = await previewRow(started.previewId);
      expect(preview.status).toBe("completed");
      const mine = new Set<string>([
        alice,
        bob,
        carol,
        dave,
        erin,
        frank,
        gina,
      ]);
      const rows = (await rowsOf(started.previewId)).filter((row) =>
        mine.has(row.dotyposCustomerId)
      );
      const byEvent = new Map(rows.map((row) => [row.customerEventId, row]));

      expect(byEvent.get(requireValue(e1))).toMatchObject({
        outcome: "would-send",
        stepId: "send",
        projected: false,
      });
      // On the engine tick: the event's tick, a day later.
      expect(byEvent.get(requireValue(e1))?.sendAt).toEqual(
        automationTickAtOrAfter(ago({ hours: 24 * 19 }))
      );
      // D4: the first run is still waiting.
      expect(byEvent.get(requireValue(e2))?.outcome).toBe("already-active");
      // The simulated send counts toward "this campaign" afterwards.
      expect(byEvent.get(requireValue(e3))).toMatchObject({
        outcome: "condition-failed",
        stepId: "first",
      });
      expect(byEvent.get(requireValue(bobEvent))).toMatchObject({
        outcome: "withdrawn",
        stepId: null,
      });
      // Cancelled in Workspace before the send: withdrawn at the send step.
      expect(byEvent.get(requireValue(carolEvent))).toMatchObject({
        outcome: "withdrawn",
        stepId: "send",
      });
      // Cancelled only after the email went out.
      expect(byEvent.get(requireValue(daveEvent))?.outcome).toBe("would-send");
      expect(byEvent.get(requireValue(erinEvent))).toMatchObject({
        outcome: "would-send",
        projected: true,
      });
      expect(byEvent.get(requireValue(frankEvent))?.outcome).toBe("would-send");
      expect(byEvent.has(requireValue(ginaFirst))).toBe(false);
      expect(byEvent.get(requireValue(ginaSecond))?.outcome).toBe("would-send");

      const dryRun = await read(started.previewId);
      expect(dryRun.counts["already-active"]).toBeGreaterThanOrEqual(1);
      expect(dryRun.nextFires).toEqual([]);
      expect(dryRun.frequency).toBeNull();
      expect(dryRun.truncated).toBe(false);
    });

    test("replays a sign-up's account creation but never an existing customer's", async () => {
      const [newcomer, existing] = [
        customerId("d37-signup"),
        customerId("d37-legacy"),
      ];
      dotyposState.customers.push(profile(newcomer), profile(existing));
      // The capture reconciler recorded the existing customer's event before
      // it skipped legacy accounts (D37).
      const accounts = [
        {
          id: customerAccountIdSchema.make(`${newcomer}-account`),
          legacy: false,
        },
        {
          id: customerAccountIdSchema.make(`${existing}-account`),
          legacy: true,
        },
      ];
      await query(
        Effect.forEach(accounts, (account) =>
          workspaceFixtures(db).customerAccount(account)
        )
      );
      try {
        const events = await query(
          db
            .insert(customerEvents)
            .values(
              [newcomer, existing].map((customer, index) => ({
                kind: "account-created" as const,
                occurredAt: ago({ hours: 24 * 3 }),
                recordedAt: ago({ hours: 24 * 3 }),
                dotyposCustomerId: customer,
                customerAccountId: requireValue(accounts[index]).id,
              }))
            )
            .returning({ id: customerEvents.id })
        );
        const campaignId = await seedAutomation({
          flow: decodeFlow({
            trigger: { _tag: "AccountCreated" },
            steps: [send],
          }),
        });

        const started = await start(campaignId);
        expect(started.kind).toBe("replay");
        await processAll(started.previewId);

        const rows = await rowsOf(started.previewId);
        expect(rows.map((row) => row.customerEventId)).toEqual([
          requireValue(events[0]).id,
        ]);
        expect((await read(started.previewId)).eventsTotal).toBe(1);
      } finally {
        // Their events go with the accounts.
        await query(
          db.delete(customerAccounts).where(
            inArray(
              customerAccounts.id,
              accounts.map(({ id }) => id)
            )
          )
        );
      }
    });

    describe("counts as of the replayed moment", () => {
      const triggerAt = ago({ hours: 24 * 10 });

      const noEmailIn = (
        period: DatePeriodType,
        campaignId?: CampaignId
      ): AudienceCondition => ({
        attribute: "campaignEmailCount",
        _tag: "Condition",
        params: {
          purpose: "any",
          period,
          ...(campaignId && {
            campaign: { _tag: "Specific", campaignId },
          }),
        },
        operator: "eq",
        value: 0,
      });

      /**
       * Two customers who finished a visit at `triggerAt`: one got another
       * campaign's email two days before it, the other five days after it.
       */
      const seedCustomers = async (label: string) => {
        const [before, after] = [
          customerId(`${label}-before`),
          customerId(`${label}-after`),
        ];
        await seedReservations(
          [before, after].map((customer, index) => ({
            label: `${label}-${index}`,
            customer,
            startsAt: triggerAt.subtract({ hours: 2 }),
            endsAt: triggerAt,
          }))
        );
        const [beforeEvent, afterEvent] = await seedEvents(
          [before, after].map((customer, index) => ({
            kind: "reservation-finished" as const,
            reservation: `${label}-${index}`,
            customer,
            occurredAt: triggerAt,
          }))
        );
        const { campaignId: other, sendId } = await seedCampaignSend(db, {
          purpose: "marketing",
          recipients: [before, after].map((dotyposCustomerId) => ({
            dotyposCustomerId,
            status: "sent" as const,
          })),
        });
        campaignIds.push(other);
        for (const [customer, dispatchedAt] of [
          [before, triggerAt.subtract({ hours: 24 * 2 })],
          [after, triggerAt.add({ hours: 24 * 5 })],
        ] as const) {
          await query(
            db
              .update(emailCampaignRecipients)
              .set({ statusUpdatedAt: dispatchedAt })
              .where(
                and(
                  eq(emailCampaignRecipients.sendId, sendId),
                  eq(emailCampaignRecipients.dotyposCustomerId, customer)
                )
              )
          );
        }
        return {
          other,
          before: requireValue(beforeEvent),
          after: requireValue(afterEvent),
        };
      };

      /** Each event's outcome in a completed dry run of the flow. */
      const outcomesOf = async (input: {
        readonly steps: readonly unknown[];
        readonly filter?: AudienceFilter;
      }) => {
        const campaignId = await seedAutomation({
          flow: decodeFlow({
            trigger: { _tag: "ReservationFinished" },
            steps: input.steps,
          }),
          ...(input.filter && { filter: input.filter }),
        });
        const started = await start(campaignId);
        await processAll(started.previewId);
        expect((await previewRow(started.previewId)).status).toBe("completed");
        return new Map(
          (await rowsOf(started.previewId)).map((row) => [
            row.customerEventId,
            row.outcome,
          ])
        );
      };

      const sources = [
        { label: "any", campaign: () => undefined },
        { label: "specific", campaign: (other: CampaignId) => other },
      ] as const;

      for (const source of sources) {
        test(`an entry gate counts ${source.label} campaign emails dispatched by the event`, async () => {
          const seeded = await seedCustomers(`gate-${source.label}`);
          const periods: readonly DatePeriodType[] = [
            { _tag: "AnyTime" },
            {
              _tag: "Onward",
              date: pragueOf(triggerAt.subtract({ hours: 24 * 7 }))
                .toPlainDate()
                .toString(),
            },
          ];
          for (const period of periods) {
            const outcomes = await outcomesOf({
              steps: [send],
              filter: {
                _tag: "Group",
                operator: "and",
                filters: [noEmailIn(period, source.campaign(seeded.other))],
              },
            });
            expect(outcomes.get(seeded.before)).toBe("not-in-audience");
            expect(outcomes.get(seeded.after)).toBe("would-send");
          }
        });

        test(`a condition counts ${source.label} campaign emails dispatched by its step`, async () => {
          const seeded = await seedCustomers(`step-${source.label}`);
          const afterTrigger = noEmailIn(
            { _tag: "TriggerWindow", side: "after", count: 30, unit: "day" },
            source.campaign(seeded.other)
          );
          const waitingDays = (days: number) =>
            outcomesOf({
              steps: [
                waitHours("wait", 24 * days),
                condition("check", afterTrigger),
                send,
              ],
            });

          const beforeTheEmail = await waitingDays(2);
          expect(beforeTheEmail.get(seeded.before)).toBe("would-send");
          expect(beforeTheEmail.get(seeded.after)).toBe("would-send");

          const afterTheEmail = await waitingDays(7);
          expect(afterTheEmail.get(seeded.before)).toBe("would-send");
          expect(afterTheEmail.get(seeded.after)).toBe("condition-failed");
        });
      }

      const bookingsIn = (
        period: DatePeriodType,
        value: number
      ): AudienceCondition => ({
        attribute: "reservationCount",
        _tag: "Condition",
        params: { dateBasis: "booking", period },
        operator: "eq",
        value,
      });

      /**
       * Two customers who finished a visit at `triggerAt`, booked fifty days
       * before it, and booked a later visit two days before it; the second
       * booked another five days after it.
       */
      const seedBookers = async (label: string) => {
        const [steady, later] = [
          customerId(`${label}-steady`),
          customerId(`${label}-later`),
        ];
        const upcoming = {
          startsAt: triggerAt.add({ hours: 24 * 20 }),
          endsAt: triggerAt.add({ hours: 24 * 20 + 2 }),
        };
        await seedReservations([
          ...[steady, later].flatMap((customer, index) => [
            {
              label: `${label}-${index}`,
              customer,
              startsAt: triggerAt.subtract({ hours: 2 }),
              endsAt: triggerAt,
              bookedAt: triggerAt.subtract({ hours: 24 * 50 }),
            },
            {
              label: `${label}-${index}-early`,
              customer,
              ...upcoming,
              bookedAt: triggerAt.subtract({ hours: 24 * 2 }),
            },
          ]),
          {
            label: `${label}-1-late`,
            customer: later,
            ...upcoming,
            bookedAt: triggerAt.add({ hours: 24 * 5 }),
          },
        ]);
        const [steadyEvent, laterEvent] = await seedEvents(
          [steady, later].map((customer, index) => ({
            kind: "reservation-finished" as const,
            reservation: `${label}-${index}`,
            customer,
            occurredAt: triggerAt,
          }))
        );
        return {
          steady: requireValue(steadyEvent),
          later: requireValue(laterEvent),
        };
      };

      test("an entry gate counts reservations booked by the event", async () => {
        const seeded = await seedBookers("booked-gate");
        const date = (instant: Temporal.Instant) =>
          pragueOf(instant).toPlainDate().toString();
        const weekBefore = date(triggerAt.subtract({ hours: 24 * 7 }));
        const weekAfter = date(triggerAt.add({ hours: 24 * 7 }));
        // What both customers had booked in each period at `triggerAt`.
        const periods: readonly (readonly [DatePeriodType, number])[] = [
          [{ _tag: "AnyTime" }, 2],
          [{ _tag: "Onward", date: weekBefore }, 1],
          [{ _tag: "Range", from: weekBefore, to: weekAfter }, 1],
          [{ _tag: "Until", date: weekAfter }, 2],
          [{ _tag: "TriggerWindow", side: "after", count: 7, unit: "day" }, 0],
        ];
        for (const [period, booked] of periods) {
          const outcomes = await outcomesOf({
            steps: [send],
            filter: {
              _tag: "Group",
              operator: "and",
              filters: [bookingsIn(period, booked)],
            },
          });
          expect(outcomes.get(seeded.steady)).toBe("would-send");
          expect(outcomes.get(seeded.later)).toBe("would-send");
        }
      });

      test("a condition counts reservations booked by its step", async () => {
        const seeded = await seedBookers("booked-step");
        const noBookingAfterTrigger = bookingsIn(
          { _tag: "TriggerWindow", side: "after", count: 30, unit: "day" },
          0
        );
        const waitingDays = (days: number) =>
          outcomesOf({
            steps: [
              waitHours("wait", 24 * days),
              condition("check", noBookingAfterTrigger),
              send,
            ],
          });

        const beforeTheBooking = await waitingDays(2);
        expect(beforeTheBooking.get(seeded.steady)).toBe("would-send");
        expect(beforeTheBooking.get(seeded.later)).toBe("would-send");

        const afterTheBooking = await waitingDays(7);
        expect(afterTheBooking.get(seeded.steady)).toBe("would-send");
        expect(afterTheBooking.get(seeded.later)).toBe("condition-failed");
      });

      test("an entry gate reads reservation statuses as they stood at the event, and marks undated ones", async () => {
        const label = "status-gate";
        const [dated, undated, settled] = [
          customerId(`${label}-dated`),
          customerId(`${label}-undated`),
          customerId(`${label}-settled`),
        ];
        const customers = [dated, undated, settled];
        const twoDaysAfter = triggerAt.add({ hours: 24 * 2 });
        await seedReservations(
          customers.flatMap((customer, index) => [
            {
              label: `${label}-${index}`,
              customer,
              startsAt: triggerAt.subtract({ hours: 2 }),
              endsAt: triggerAt,
              bookedAt: triggerAt.subtract({ hours: 24 * 50 }),
            },
            {
              label: `${label}-${index}-other`,
              customer,
              startsAt: triggerAt.add({ hours: 24 * 20 }),
              endsAt: triggerAt.add({ hours: 24 * 20 + 2 }),
              bookedAt: triggerAt.subtract({ hours: 24 * 5 }),
              // Cancelled two days after the event: booked at it.
              ...(customer === dated && { workspaceCancelledAt: twoDaysAfter }),
            },
          ])
        );
        // A cancellation that failed is dated only by the row's last update.
        for (const [index, updatedAt] of [
          [1, twoDaysAfter],
          [2, triggerAt.subtract({ hours: 24 * 2 })],
        ] as const) {
          await query(
            db
              .update(workspaceReservations)
              .set({ reservationState: "cancellation_failed", updatedAt })
              .where(
                eq(
                  workspaceReservations.id,
                  reservationIdOf(`${label}-${index}-other`)
                )
              )
          );
        }
        const events = await seedEvents(
          customers.map((customer, index) => ({
            kind: "reservation-finished" as const,
            reservation: `${label}-${index}`,
            customer,
            occurredAt: triggerAt,
          }))
        );
        const campaignId = await seedAutomation({
          flow: decodeFlow({
            trigger: { _tag: "ReservationFinished" },
            steps: [send],
          }),
          filter: {
            _tag: "Group",
            operator: "and",
            filters: [bookingsIn({ _tag: "AnyTime" }, 2)],
          },
        });
        const started = await start(campaignId);
        await processAll(started.previewId);
        const byEvent = new Map(
          (await rowsOf(started.previewId)).map((row) => [
            row.customerEventId,
            row,
          ])
        );
        const [datedEvent, undatedEvent, settledEvent] = events;

        expect(byEvent.get(requireValue(datedEvent))).toMatchObject({
          outcome: "would-send",
          reservationStatusesApproximate: false,
        });
        // Read as it is now, which may not be how it stood at the event.
        expect(byEvent.get(requireValue(undatedEvent))).toMatchObject({
          outcome: "not-in-audience",
          reservationStatusesApproximate: true,
        });
        // Unchanged since before the event, so exact.
        expect(byEvent.get(requireValue(settledEvent))).toMatchObject({
          outcome: "not-in-audience",
          reservationStatusesApproximate: false,
        });
        const dryRun = await read(started.previewId);
        expect(
          dryRun.rows.find((row) => row.customerEventId === undatedEvent)
            ?.reservationStatusesApproximate
        ).toBe(true);
      });

      test("an approximate admission marks the events it holds off and the later ones that count its send", async () => {
        const label = "status-carry";
        const roles = ["carried", "exact"] as const;
        const [carried, exact] = [
          customerId(`${label}-${roles[0]}`),
          customerId(`${label}-${roles[1]}`),
        ];
        const twoDaysAfter = triggerAt.add({ hours: 24 * 2 });
        const visitEnds = [
          triggerAt,
          triggerAt.add({ hours: 1 }),
          triggerAt.add({ hours: 24 * 3 }),
        ];
        await seedReservations(
          [carried, exact].flatMap((customer, index) => [
            ...visitEnds.map((endsAt, visit) => ({
              label: `${label}-${roles[index]}-${visit}`,
              customer,
              startsAt: endsAt.subtract({ hours: 1 }),
              endsAt,
              bookedAt: triggerAt.subtract({ hours: 24 * 50 }),
            })),
            {
              label: `${label}-${roles[index]}-upcoming`,
              customer,
              startsAt: triggerAt.add({ hours: 24 * 20 }),
              endsAt: triggerAt.add({ hours: 24 * 20 + 2 }),
              bookedAt: triggerAt.subtract({ hours: 24 * 5 }),
            },
          ])
        );
        // Only `carried` has an undated change, two days after its first
        // two events and a day before its third.
        await query(
          db
            .update(workspaceReservations)
            .set({
              reservationState: "cancellation_failed",
              updatedAt: twoDaysAfter,
            })
            .where(
              eq(
                workspaceReservations.id,
                reservationIdOf(`${label}-carried-upcoming`)
              )
            )
        );
        const events = await seedEvents(
          [carried, exact].flatMap((customer, index) =>
            visitEnds.map((occurredAt, visit) => ({
              kind: "reservation-finished" as const,
              reservation: `${label}-${roles[index]}-${visit}`,
              customer,
              occurredAt,
            }))
          )
        );
        const campaignId = await seedAutomation({
          flow: decodeFlow({
            trigger: { _tag: "ReservationFinished" },
            steps: [
              condition("first-email", noEmailFromThisCampaign),
              waitHours("wait", 24),
              send,
            ],
          }),
          // At least two bookings, however the undated status reads.
          filter: {
            _tag: "Group",
            operator: "and",
            filters: [
              { ...bookingsIn({ _tag: "AnyTime" }, 1), operator: "gt" },
            ],
          },
        });
        const started = await start(campaignId);
        await processAll(started.previewId);
        const byEvent = new Map(
          (await rowsOf(started.previewId)).map((row) => [
            row.customerEventId,
            row,
          ])
        );
        const outcomes = (ids: readonly (string | undefined)[]) =>
          ids.map((id) => {
            const row = byEvent.get(requireValue(id));
            return [row?.outcome, row?.reservationStatusesApproximate];
          });

        // The admission read the undated status; the second event is held
        // off by its run, and the third counts its send.
        expect(outcomes(events.slice(0, 3))).toEqual([
          ["would-send", true],
          ["already-active", true],
          ["condition-failed", true],
        ]);
        expect(outcomes(events.slice(3))).toEqual([
          ["would-send", false],
          ["already-active", false],
          ["condition-failed", false],
        ]);
      });
    });

    test("replays only the latest 1,000 events and counts the rest", async () => {
      const customers = ["t1", "t2", "t3"].map(customerId);
      const labels = Array.from(
        { length: 1005 },
        (_, index) => `many-${index}`
      );
      // A customer's events a tick apart, so none is held off.
      const cancelledAt = (index: number) =>
        ago({ hours: 1, minutes: 5 * index });
      await seedReservations(
        labels.map((label, index) => ({
          label,
          customer: requireValue(customers[index % 3]),
          startsAt: ago({ hours: 24 * 40 }),
          endsAt: ago({ hours: 24 * 40 - 1 }),
          workspaceCancelledAt: cancelledAt(index),
        }))
      );
      await seedEvents(
        labels.map((label, index) => ({
          kind: "reservation-cancelled",
          reservation: label,
          customer: requireValue(customers[index % 3]),
          occurredAt: cancelledAt(index),
        }))
      );
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: {
            _tag: "ReservationCancelled",
            product: { family: "cowork", properties: [] },
          },
          steps: [send],
        }),
      });

      const started = await start(campaignId);
      await processAll(started.previewId);

      const dryRun = await read(started.previewId);
      expect(dryRun.status).toBe("completed");
      expect(dryRun.eventsTotal).toBeGreaterThanOrEqual(1005);
      expect(dryRun.truncated).toBe(true);
      const rows = (await rowsOf(started.previewId)).filter((row) =>
        customers.includes(row.dotyposCustomerId)
      );
      // Other suites' cancellations may share the window, never more than 1,000 rows.
      expect(rows.length).toBeLessThanOrEqual(1000);
      expect(
        rows.some((row) =>
          row.triggerAt.equals(ago({ hours: 1, minutes: 5 * 1004 }))
        )
      ).toBe(false);
      expect(rows.every((row) => row.outcome === "would-send")).toBe(true);
    });

    test("an event trigger with no events completes at once", async () => {
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: {
            _tag: "ReservationBooked",
            product: {
              family: "office",
              properties: [{ property: "seats", operator: "gte", value: 999 }],
            },
          },
          steps: [send],
        }),
      });
      const started = await start(campaignId);
      expect(started).toMatchObject({
        status: "completed",
        unitsTotal: 0,
        kind: "replay",
      });
      expect(await unitsOf(started.previewId)).toEqual([]);
    });

    test("a stay trigger replays only the visits of its stay", async () => {
      const [ida, jack, lena] = [
        customerId("ida"),
        customerId("jack"),
        customerId("lena"),
      ];
      const noonDaysAgo = (days: number) =>
        pragueOf(ago({ hours: 24 * days }))
          .toPlainDate()
          .toZonedDateTime({ timeZone: "Europe/Prague", plainTime: "12:00" })
          .toInstant();
      /** 09:00 to 17:00 in Prague. */
      const dayOf = (days: number) => ({
        startsAt: noonDaysAgo(days).subtract({ hours: 3 }),
        endsAt: noonDaysAgo(days).add({ hours: 5 }),
      });
      /** Noon to noon the next day in Prague. */
      const overnightFrom = (days: number) => ({
        startsAt: noonDaysAgo(days),
        endsAt: noonDaysAgo(days - 1),
      });
      const visits = {
        "ida-overnight": { customer: ida, ...overnightFrom(8) },
        "jack-day": { customer: jack, ...dayOf(7) },
        // Ends while jack's day run still waits.
        "jack-overnight": { customer: jack, ...overnightFrom(6) },
        "lena-day": { customer: lena, ...dayOf(10) },
      };
      await seedReservations(
        Object.entries(visits).map(([label, visit]) => ({
          label,
          ...visit,
          // Workspace cancelled lena's visit after its email went out.
          ...(label === "lena-day" && { workspaceCancelledAt: noonDaysAgo(2) }),
        }))
      );
      await query(
        db
          .update(workspaceReservations)
          .set({
            reservationDetails: {
              kind: "cowork",
              entryTier: "reserved-desk",
              coffee: true,
            },
          })
          .where(
            inArray(
              workspaceReservations.id,
              Object.keys(visits).map(reservationIdOf)
            )
          )
      );
      const [idaEvent, jackDay, jackOvernight, lenaDay] = await seedEvents(
        Object.entries(visits).map(([reservation, visit]) => ({
          kind: "reservation-finished" as const,
          reservation,
          customer: visit.customer,
          occurredAt: visit.endsAt,
        }))
      );
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: {
            _tag: "ReservationFinished",
            product: { family: "cowork", properties: [] },
            stay: "day",
          },
          steps: [waitHours("hold", 72), send],
        }),
      });

      const started = await start(campaignId);
      await processAll(started.previewId);

      const outcomes = new Map(
        (await rowsOf(started.previewId)).map(
          (row): [string | null, string] => [row.customerEventId, row.outcome]
        )
      );
      expect(outcomes.has(requireValue(idaEvent))).toBe(false);
      expect(outcomes.get(requireValue(jackDay))).toBe("would-send");
      expect(outcomes.has(requireValue(jackOvernight))).toBe(false);
      expect(outcomes.get(requireValue(lenaDay))).toBe("would-send");
    });

    test("a payment trigger replays only individually paid reservations", async () => {
      const [mona, nina] = [customerId("mona"), customerId("nina")];
      const finishedAt = ago({ hours: 24 * 4 });
      await seedReservations(
        [
          { label: "mona-card", customer: mona },
          { label: "nina-unpaid-attempt", customer: nina },
        ].map((reservation) => ({
          ...reservation,
          startsAt: finishedAt.subtract({ hours: 2 }),
          endsAt: finishedAt,
        }))
      );
      // Only mona's order has a paid attempt that keeps its amount.
      const attemptId = `dry-run-card-${runId}`;
      await testDatabase.pool.query(
        `insert into payment_attempts (id, order_id, workspace_reservation_id, provider,
           provider_order_id, state, amount_value, amount_exponent, currency)
         values ($1, $2, $2, 'nexi', $1, 'paid', 29000, 2, 'CZK')`,
        [attemptId, reservationIdOf("mona-card")]
      );
      await testDatabase.pool.query(
        "update workspace_reservations set active_payment_attempt_id = $2 where id = $1",
        [reservationIdOf("mona-card"), attemptId]
      );
      const [monaEvent, ninaEvent] = await seedEvents([
        {
          kind: "reservation-finished",
          reservation: "mona-card",
          customer: mona,
          occurredAt: finishedAt,
        },
        {
          kind: "reservation-finished",
          reservation: "nina-unpaid-attempt",
          customer: nina,
          occurredAt: finishedAt,
        },
      ]);
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: { _tag: "ReservationFinished", payment: "individual" },
          steps: [send],
        }),
      });

      const started = await start(campaignId);
      await processAll(started.previewId);

      const outcomes = new Map(
        (await rowsOf(started.previewId)).map(
          (row): [string | null, string] => [row.customerEventId, row.outcome]
        )
      );
      expect(outcomes.get(requireValue(monaEvent))).toBe("would-send");
      expect(outcomes.has(requireValue(ninaEvent))).toBe(false);

      // A unit that kept missing its deadline still judges payment locally.
      const fallback = await start(
        await seedAutomation({
          flow: decodeFlow({
            trigger: { _tag: "ReservationFinished", payment: "individual" },
            steps: [send],
          }),
        })
      );
      for (const unit of await unitsOf(fallback.previewId)) {
        await query(
          db
            .update(emailCampaignAutomationWorkUnits)
            .set({ deadlineMisses: 3 })
            .where(eq(emailCampaignAutomationWorkUnits.id, unit.id))
        );
      }
      await processAll(fallback.previewId);
      const fallbackOutcomes = new Map(
        (await rowsOf(fallback.previewId)).map(
          (row): [string | null, string] => [row.customerEventId, row.outcome]
        )
      );
      expect(fallbackOutcomes.get(requireValue(monaEvent))).toBe("unavailable");
      expect(fallbackOutcomes.has(requireValue(ninaEvent))).toBe(false);
    });

    test("a unit past its deadline still drops events payment and stored tiers settle", async () => {
      const [ola, pia, quin] = [
        customerId("ola"),
        customerId("pia"),
        customerId("quin"),
      ];
      const finishedAt = ago({ hours: 24 * 3 });
      const reservations = {
        "ola-open-space": ola,
        "pia-reserved-desk": pia,
        "quin-reserved-desk-unpaid": quin,
      };
      await seedReservations(
        Object.entries(reservations).map(([label, customer]) => ({
          label,
          customer,
          startsAt: finishedAt.subtract({ hours: 24 }),
          endsAt: finishedAt,
        }))
      );
      await query(
        db
          .update(workspaceReservations)
          .set({
            reservationDetails: {
              kind: "cowork",
              entryTier: "reserved-desk",
              coffee: true,
            },
          })
          .where(
            inArray(workspaceReservations.id, [
              reservationIdOf("pia-reserved-desk"),
              reservationIdOf("quin-reserved-desk-unpaid"),
            ])
          )
      );
      for (const label of ["ola-open-space", "pia-reserved-desk"]) {
        const attemptId = `dry-run-card-${runId}-${label}`;
        await testDatabase.pool.query(
          `insert into payment_attempts (id, order_id, workspace_reservation_id, provider,
             provider_order_id, state, amount_value, amount_exponent, currency)
           values ($1, $2, $2, 'nexi', $1, 'paid', 29000, 2, 'CZK')`,
          [attemptId, reservationIdOf(label)]
        );
        await testDatabase.pool.query(
          "update workspace_reservations set active_payment_attempt_id = $2 where id = $1",
          [reservationIdOf(label), attemptId]
        );
      }
      const [olaEvent, piaEvent, quinEvent] = await seedEvents(
        Object.entries(reservations).map(([reservation, customer]) => ({
          kind: "reservation-finished" as const,
          reservation,
          customer,
          occurredAt: finishedAt,
        }))
      );
      const started = await start(
        await seedAutomation({
          flow: decodeFlow({
            trigger: {
              _tag: "ReservationFinished",
              product: { family: "cowork", properties: [] },
              stay: "overnight",
              payment: "individual",
            },
            steps: [send],
          }),
        })
      );
      for (const unit of await unitsOf(started.previewId)) {
        await query(
          db
            .update(emailCampaignAutomationWorkUnits)
            .set({ deadlineMisses: 3 })
            .where(eq(emailCampaignAutomationWorkUnits.id, unit.id))
        );
      }
      await processAll(started.previewId);

      const outcomes = new Map(
        (await rowsOf(started.previewId)).map(
          (row): [string | null, string] => [row.customerEventId, row.outcome]
        )
      );
      // Open Space can't be overnight; the unpaid one fails payment; only
      // the paid Reserved Desk visit needs its unread interval.
      expect(outcomes.has(requireValue(olaEvent))).toBe(false);
      expect(outcomes.has(requireValue(quinEvent))).toBe(false);
      expect(outcomes.get(requireValue(piaEvent))).toBe("unavailable");
    });

    test("a stay its stored tiers rule out reads no visits, so Dotypos can't stall the replay", async () => {
      const [rita, sven] = [customerId("rita"), customerId("sven")];
      const finishedAt = ago({ hours: 24 * 2 });
      const labels = { "rita-open-space": rita, "sven-open-space": sven };
      await seedReservations(
        Object.entries(labels).map(([label, customer]) => ({
          label,
          customer,
          startsAt: finishedAt.subtract({ hours: 24 }),
          endsAt: finishedAt,
        }))
      );
      await query(
        db
          .update(workspaceReservations)
          .set({
            reservationDetails: {
              kind: "cowork",
              entryTier: "open-space",
              coffee: false,
            },
          })
          .where(
            inArray(
              workspaceReservations.id,
              Object.keys(labels).map(reservationIdOf)
            )
          )
      );
      const events = await seedEvents(
        Object.entries(labels).map(([reservation, customer]) => ({
          kind: "reservation-finished" as const,
          reservation,
          customer,
          occurredAt: finishedAt,
        }))
      );
      const started = await start(
        await seedAutomation({
          flow: decodeFlow({
            trigger: {
              _tag: "ReservationFinished",
              // Only this test's Open Space visits are candidates.
              product: {
                family: "cowork",
                properties: [
                  {
                    property: "tier",
                    operator: "anyOf",
                    value: ["open-space"],
                  },
                ],
              },
              stay: "overnight",
            },
            steps: [send],
          }),
        })
      );

      dotyposState.reservationLookups = [];
      dotyposState.failReservationLookups = true;
      try {
        await processAll(started.previewId);
      } finally {
        dotyposState.failReservationLookups = false;
      }

      expect(
        dotyposState.reservationLookups.filter((asked) => asked > 0)
      ).toEqual([]);
      expect(
        (await unitsOf(started.previewId)).map(({ status }) => status)
      ).toEqual(["done"]);
      const rows = await rowsOf(started.previewId);
      expect(
        rows.filter(({ customerEventId }) =>
          events.includes(customerEventId ?? "")
        )
      ).toEqual([]);
    });

    test("a reschedule in Dotypos changes the next preview without local writes", async () => {
      const hank = customerId("hank");
      await seedReservations([
        {
          label: "hank",
          customer: hank,
          startsAt: ago({ hours: 24 * 6 }),
          endsAt: ago({ hours: 24 * 6 - 2 }),
        },
      ]);
      const [event] = await seedEvents([
        {
          kind: "reservation-started",
          reservation: "hank",
          customer: hank,
          occurredAt: ago({ hours: 24 * 6 }),
        },
      ]);
      const flow = (sendId: string) =>
        decodeFlow({
          trigger: { _tag: "ReservationStarted" },
          steps: [{ _tag: "Send", id: sendId }],
        });
      const campaignId = await seedAutomation({ flow: flow("send") });

      const first = await start(campaignId);
      await processAll(first.previewId);
      expect(
        (await rowsOf(first.previewId)).find(
          (row) => row.customerEventId === event
        )?.outcome
      ).toBe("would-send");

      const localBefore = await query(
        db
          .select()
          .from(customerEvents)
          .where(eq(customerEvents.dotyposCustomerId, hank))
      );
      moveDotyposReservation("hank", {
        startsAt: ago({ hours: 24 * 5 }),
        endsAt: ago({ hours: 24 * 5 - 2 }),
      });
      await editFlow(campaignId, flow("send-again"));
      const second = await start(campaignId);
      expect(second.previewId).not.toBe(first.previewId);
      await processAll(second.previewId);

      expect(
        (await rowsOf(second.previewId)).some(
          (row) => row.customerEventId === event
        )
      ).toBe(false);
      expect(
        await query(
          db
            .select()
            .from(customerEvents)
            .where(eq(customerEvents.dotyposCustomerId, hank))
        )
      ).toEqual(localBefore);
    });

    test("a Workspace-cancelled reservation skips the live re-check, which compares at stored precision, and a standing cancellation trigger is not withdrawn", async () => {
      const [moved, movedCancelled, sameMoment, cancellation] = [
        customerId("recheck-moved"),
        customerId("recheck-moved-cancelled"),
        customerId("recheck-same-moment"),
        customerId("recheck-cancellation"),
      ];
      const finishedAt = ago({ hours: 24 * 9 });
      // Dotypos already reports each visit as it stands now.
      const extended = {
        startsAt: finishedAt.subtract({ hours: 2 }),
        endsAt: finishedAt.add({ hours: 1 }),
      };
      // The newest cancellation, so the 1,000-event cap keeps it.
      const cancelledAt = ago({ minutes: 30 });
      await seedReservations([
        { label: "recheck-moved", customer: moved, ...extended },
        {
          label: "recheck-moved-cancelled",
          customer: movedCancelled,
          ...extended,
          workspaceCancelledAt: finishedAt.add({ hours: 12 }),
        },
        {
          // Later than the event only below the microseconds it's stored at.
          label: "recheck-same-moment",
          customer: sameMoment,
          startsAt: finishedAt.subtract({ hours: 2 }),
          endsAt: finishedAt.add({ nanoseconds: 500 }),
        },
        {
          label: "recheck-cancellation",
          customer: cancellation,
          startsAt: ago({ hours: 24 * 3 }),
          endsAt: ago({ hours: 24 * 3 - 2 }),
          workspaceCancelledAt: cancelledAt,
        },
      ]);
      const finishedEvent = (
        reservation: string,
        customer: DotyposCustomerId
      ) => ({
        kind: "reservation-finished" as const,
        reservation,
        customer,
        occurredAt: finishedAt,
      });
      const [movedEvent, movedCancelledEvent, sameMomentEvent] =
        await seedEvents([
          finishedEvent("recheck-moved", moved),
          finishedEvent("recheck-moved-cancelled", movedCancelled),
          finishedEvent("recheck-same-moment", sameMoment),
        ]);
      const [cancellationEvent] = await seedEvents([
        {
          kind: "reservation-cancelled",
          reservation: "recheck-cancellation",
          customer: cancellation,
          occurredAt: cancelledAt,
        },
      ]);
      const finishedCampaign = await seedAutomation({
        flow: decodeFlow({
          trigger: { _tag: "ReservationFinished" },
          steps: [waitHours("day", 24), send],
        }),
      });
      const cancelledCampaign = await seedAutomation({
        flow: decodeFlow({
          trigger: { _tag: "ReservationCancelled" },
          steps: [send],
        }),
      });

      const finished = await start(finishedCampaign);
      const cancelled = await start(cancelledCampaign);
      // Neither audience nor flow reads Dotypos, so only the re-check costs
      // requests: one per 100 of a chunk's reservations, none for cancellations.
      const finishedUnits = await unitsOf(finished.previewId);
      expect(finishedUnits.length).toBeGreaterThan(0);
      expect(finishedUnits.filter((unit) => unit.requestCost === 0)).toEqual(
        []
      );
      expect(
        (await unitsOf(cancelled.previewId)).filter(
          (unit) => unit.requestCost !== 0
        )
      ).toEqual([]);
      await processAll(finished.previewId);
      await processAll(cancelled.previewId);

      const byEvent = new Map(
        [
          ...(await rowsOf(finished.previewId)),
          ...(await rowsOf(cancelled.previewId)),
        ].map((row) => [row.customerEventId, row])
      );
      // The visit moved past the event, so the sweep's later event stands for it.
      expect(byEvent.has(requireValue(movedEvent))).toBe(false);
      // Cancelled in Workspace before the send: the pre-submit check withdraws it.
      expect(byEvent.get(requireValue(movedCancelledEvent))).toMatchObject({
        outcome: "withdrawn",
        stepId: "send",
      });
      expect(byEvent.get(requireValue(sameMomentEvent))?.outcome).toBe(
        "would-send"
      );
      expect(byEvent.get(requireValue(cancellationEvent))?.outcome).toBe(
        "would-send"
      );
    });

    test("a cancellation a restore undid is withdrawn before entry, and the reservation's later cancellation replays", async () => {
      const [restored, cancelledAgain] = [
        customerId("undone-restored"),
        customerId("undone-again"),
      ];
      // The newest cancellations, so the 1,000-event cap keeps them.
      const firstCancelledAt = ago({ minutes: 45 });
      const secondCancelledAt = ago({ minutes: 20 });
      await seedReservations([
        {
          label: "undone-restored",
          customer: restored,
          startsAt: ago({ hours: 24 * 4 }),
          endsAt: ago({ hours: 24 * 4 - 2 }),
        },
        {
          label: "undone-again",
          customer: cancelledAgain,
          startsAt: ago({ hours: 24 * 4 }),
          endsAt: ago({ hours: 24 * 4 - 2 }),
          workspaceCancelledAt: secondCancelledAt,
        },
      ]);
      const [restoredEvent, undoneEvent, againEvent] = await seedEvents([
        {
          kind: "reservation-cancelled",
          reservation: "undone-restored",
          customer: restored,
          occurredAt: firstCancelledAt,
        },
        {
          kind: "reservation-cancelled",
          reservation: "undone-again",
          customer: cancelledAgain,
          occurredAt: firstCancelledAt,
        },
        {
          kind: "reservation-cancelled",
          reservation: "undone-again",
          customer: cancelledAgain,
          occurredAt: secondCancelledAt,
        },
      ]);
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: { _tag: "ReservationCancelled" },
          steps: [send],
        }),
      });

      const started = await start(campaignId);
      await processAll(started.previewId);

      const byEvent = new Map(
        (await rowsOf(started.previewId)).map((row) => [
          row.customerEventId,
          row,
        ])
      );
      expect(byEvent.get(requireValue(restoredEvent))).toMatchObject({
        outcome: "withdrawn",
        stepId: null,
      });
      expect(byEvent.get(requireValue(undoneEvent))).toMatchObject({
        outcome: "withdrawn",
        stepId: null,
      });
      expect(byEvent.get(requireValue(againEvent))?.outcome).toBe("would-send");
    });

    test("a saved audience edited after planning still evaluates", async () => {
      const mia = customerId("mia");
      // The newest cancellation, so the 1,000-event cap keeps it.
      const cancelledAt = ago({ minutes: 30 });
      await seedReservations([
        {
          label: "mia",
          customer: mia,
          startsAt: ago({ hours: 24 * 20 }),
          endsAt: ago({ hours: 24 * 20 - 2 }),
        },
        {
          label: "mia-cancelled",
          customer: mia,
          startsAt: ago({ hours: 24 * 2 }),
          endsAt: ago({ hours: 24 * 2 - 2 }),
          workspaceCancelledAt: cancelledAt,
        },
      ]);
      const [event] = await seedEvents([
        {
          kind: "reservation-cancelled",
          reservation: "mia-cancelled",
          customer: mia,
          occurredAt: cancelledAt,
        },
      ]);
      const savedAudience = await seedAudience({
        attribute: "hasAccount",
        _tag: "Condition",
        operator: "is",
        value: true,
      });
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: { _tag: "ReservationCancelled" },
          steps: [
            condition("member", {
              _tag: "InAudience",
              audienceId: savedAudience,
              operator: "in",
            }),
            send,
          ],
        }),
      });
      const started = await start(campaignId);
      const [unit] = await unitsOf(started.previewId);
      expect(unit?.requestCost).toBe(0);

      // Now the audience needs visits, which the unit didn't plan for (D32).
      await query(
        db
          .update(emailCampaignAudiences)
          .set({
            filter: {
              attribute: "lastVisit",
              _tag: "Condition",
              operator: "in",
              value: { _tag: "Last", count: 1, unit: "year" },
            },
          })
          .where(eq(emailCampaignAudiences.id, savedAudience))
      );
      const readsBefore = dotyposState.reservationReads;
      await processAll(started.previewId);

      expect((await previewRow(started.previewId)).status).toBe("completed");
      expect(dotyposState.reservationReads).toBeGreaterThan(readsBefore);
      expect(
        (await rowsOf(started.previewId)).find(
          (row) => row.customerEventId === event
        )?.outcome
      ).toBe("would-send");
    });

    test("a Send's delivery policies skip, defer and hold off replayed sends", async () => {
      const triggerAt = ago({ hours: 24 * 10 });
      const [plain, claimed, gapped, packHolder, unlimitedHolder] = [
        customerId("policy-plain"),
        customerId("policy-claimed"),
        customerId("policy-gapped"),
        customerId("policy-pack"),
        customerId("policy-unlimited"),
      ];
      const { campaignId, previewId: activationPreviewId } =
        await kit.seedActive(
          decodeFlow({
            trigger: { _tag: "ReservationFinished" },
            steps: [
              {
                ...send,
                oncePerCustomer: true,
                oneOffCampaignGap: { days: 14 },
                skipPassHolders: true,
              },
            ],
          })
        );

      const validUntil = pragueOf(now)
        .toPlainDate()
        .add({ days: 30 })
        .toString();
      for (const [holder, kind] of [
        [packHolder, "entry-pack"],
        [unlimitedHolder, "unlimited"],
      ] as const) {
        await seedPass({
          holder: await seedPassHolder(holder),
          kind,
          validUntil,
        });
      }
      dotyposState.customers.push(
        ...[plain, claimed, gapped].map((id) => profile(id))
      );
      await seedKnownCustomers(db, [
        plain,
        claimed,
        gapped,
        packHolder,
        unlimitedHolder,
      ]);

      // Activation's completed dry run would otherwise be reused.
      await query(
        db
          .update(emailCampaignAutomationPreviews)
          .set({ status: "superseded" })
          .where(eq(emailCampaignAutomationPreviews.id, activationPreviewId))
      );
      claimedCampaignIds.push(campaignId);
      // A live run of the campaign already holds the claimed customer.
      const [version] = await query(
        db
          .select({ id: emailCampaignAutomationVersions.id })
          .from(emailCampaignAutomationVersions)
          .where(eq(emailCampaignAutomationVersions.campaignId, campaignId))
      );
      const claimingRun = await seedAutomationRun(db, {
        campaignId,
        versionId: requireValue(version).id,
        customerId: claimed,
        stepId: "send",
        phase: "waiting",
        stepEnteredAt: ago({ hours: 1 }),
        dueAt: ago({ hours: 1 }),
      });
      await query(
        db.insert(emailCampaignAutomationCustomerClaims).values({
          campaignId,
          dotyposCustomerId: claimed,
          runId: claimingRun,
        })
      );

      // One-off emails to the gapped customer: one received six days before
      // the event, a later one requested three days before it.
      const sent = await seedCampaignSend(db, {
        purpose: "marketing",
        status: "sent",
        recipients: [{ dotyposCustomerId: gapped, status: "sent" as const }],
      });
      const requested = await seedCampaignSend(db, {
        purpose: "marketing",
        recipients: [{ dotyposCustomerId: gapped, status: "pending" as const }],
      });
      campaignIds.push(sent.campaignId, requested.campaignId);
      await query(
        db
          .update(emailCampaignRecipients)
          .set({ statusUpdatedAt: triggerAt.subtract({ hours: 24 * 6 }) })
          .where(eq(emailCampaignRecipients.sendId, sent.sendId))
      );
      const [pending] = await query(
        db
          .select({ deliveryAttempt: emailCampaignRecipients.deliveryAttempt })
          .from(emailCampaignRecipients)
          .where(eq(emailCampaignRecipients.sendId, requested.sendId))
      );
      const batchRequestedAt = triggerAt.subtract({ hours: 24 * 3 });
      await query(
        db.insert(emailCampaignDeliveryBatches).values({
          sendId: requested.sendId,
          deliveryAttempt: requireValue(pending).deliveryAttempt,
          batchIndex: 0,
          dotyposCustomerIds: [gapped],
          payloadHash: "synthetic-payload-hash",
          requestedAt: batchRequestedAt,
        })
      );

      const customers = [plain, claimed, gapped, packHolder, unlimitedHolder];
      const laterAt = triggerAt.add({ hours: 24 * 2 });
      await seedReservations([
        ...customers.map((customer, index) => ({
          label: `policy-${index}`,
          customer,
          startsAt: triggerAt.subtract({ hours: 2 }),
          endsAt: triggerAt,
        })),
        ...[plain, gapped].map((customer, index) => ({
          label: `policy-later-${index}`,
          customer,
          startsAt: laterAt.subtract({ hours: 2 }),
          endsAt: laterAt,
        })),
      ]);
      await seedEvents([
        ...customers.map((customer, index) => ({
          kind: "reservation-finished" as const,
          reservation: `policy-${index}`,
          customer,
          occurredAt: triggerAt,
        })),
        ...[plain, gapped].map((customer, index) => ({
          kind: "reservation-finished" as const,
          reservation: `policy-later-${index}`,
          customer,
          occurredAt: laterAt,
        })),
      ]);

      const started = await start(campaignId);
      await processAll(started.previewId);
      const report = await read(started.previewId);

      const sendTick = automationTickAtOrAfter(triggerAt).toString();
      const gapSendAt = automationTickAtOrAfter(
        oneOffCampaignGapEndsAt(batchRequestedAt, { days: 14 })
      );
      expect(Temporal.Instant.compare(gapSendAt, now)).toBeGreaterThan(0);
      const rowOf = (customer: DotyposCustomerId, at: Temporal.Instant) =>
        report.rows.find(
          (row) =>
            row.customerId === customer && row.triggerAt === at.toString()
        );
      expect(rowOf(plain, triggerAt)).toMatchObject({
        outcome: "would-send",
        sendAt: sendTick,
        skipReason: null,
      });
      expect(rowOf(plain, laterAt)).toMatchObject({
        outcome: "skipped",
        sendAt: null,
        skipReason: "already-sent-once",
        projected: false,
      });
      expect(rowOf(claimed, triggerAt)).toMatchObject({
        outcome: "skipped",
        skipReason: "already-sent-once",
      });
      expect(rowOf(gapped, triggerAt)).toMatchObject({
        outcome: "would-send",
        sendAt: gapSendAt.toString(),
        skipReason: null,
        projected: true,
      });
      // The deferred send holds the customer's later event off.
      expect(rowOf(gapped, laterAt)).toMatchObject({
        outcome: "already-active",
        skipReason: null,
      });
      for (const holder of [packHolder, unlimitedHolder]) {
        expect(rowOf(holder, triggerAt)).toMatchObject({
          outcome: "skipped",
          sendAt: null,
          skipReason: "pass-holder",
        });
      }
      expect(report.counts).toMatchObject({
        "would-send": 2,
        skipped: 4,
        "already-active": 1,
      });
      const stored = await rowsOf(started.previewId);
      expect(
        stored
          .filter((row) => row.outcome === "skipped")
          .map((row) => row.skipReason)
          .toSorted()
      ).toEqual([
        "already-sent-once",
        "already-sent-once",
        "pass-holder",
        "pass-holder",
      ]);
    });

    test("a stay and payment trigger replays only qualifying visits through its Send's policies", async () => {
      const [repeat, holder, unpaidHolder, overnight] = [
        customerId("qualified-repeat"),
        customerId("qualified-holder"),
        customerId("qualified-unpaid-holder"),
        customerId("qualified-overnight"),
      ];
      const noonDaysAgo = (days: number) =>
        pragueOf(ago({ hours: 24 * days }))
          .toPlainDate()
          .toZonedDateTime({ timeZone: "Europe/Prague", plainTime: "12:00" })
          .toInstant();
      /** 09:00 to 17:00 in Prague. */
      const dayOf = (days: number) => ({
        startsAt: noonDaysAgo(days).subtract({ hours: 3 }),
        endsAt: noonDaysAgo(days).add({ hours: 5 }),
      });
      /** Noon to noon the next day in Prague. */
      const overnightFrom = (days: number) => ({
        startsAt: noonDaysAgo(days),
        endsAt: noonDaysAgo(days - 1),
      });
      const visits = {
        "qualified-repeat-first": {
          customer: repeat,
          ...dayOf(10),
          paid: true,
        },
        "qualified-repeat-overnight": {
          customer: repeat,
          ...overnightFrom(8),
          paid: true,
        },
        "qualified-repeat-later": { customer: repeat, ...dayOf(5), paid: true },
        "qualified-holder-day": { customer: holder, ...dayOf(9), paid: true },
        "qualified-unpaid-holder-day": {
          customer: unpaidHolder,
          ...dayOf(9),
          paid: false,
        },
        "qualified-overnight-stay": {
          customer: overnight,
          ...overnightFrom(7),
          paid: true,
        },
      };
      await seedReservations(
        Object.entries(visits).map(
          ([label, { customer, startsAt, endsAt }]) => ({
            label,
            customer,
            startsAt,
            endsAt,
          })
        )
      );
      await query(
        db
          .update(workspaceReservations)
          .set({
            reservationDetails: {
              kind: "cowork",
              entryTier: "reserved-desk",
              coffee: true,
            },
          })
          .where(
            inArray(
              workspaceReservations.id,
              Object.keys(visits).map(reservationIdOf)
            )
          )
      );
      for (const [label, { paid }] of Object.entries(visits)) {
        if (!paid) continue;
        const attemptId = `dry-run-${label}-${runId}`;
        await testDatabase.pool.query(
          `insert into payment_attempts (id, order_id, workspace_reservation_id, provider,
             provider_order_id, state, amount_value, amount_exponent, currency)
           values ($1, $2, $2, 'nexi', $1, 'paid', 29000, 2, 'CZK')`,
          [attemptId, reservationIdOf(label)]
        );
        await testDatabase.pool.query(
          "update workspace_reservations set active_payment_attempt_id = $2 where id = $1",
          [reservationIdOf(label), attemptId]
        );
      }
      const validUntil = pragueOf(now)
        .toPlainDate()
        .add({ days: 30 })
        .toString();
      for (const passHolder of [holder, unpaidHolder]) {
        await seedPass({
          holder: await seedPassHolder(passHolder),
          kind: "entry-pack",
          validUntil,
        });
      }
      dotyposState.customers.push(
        ...[repeat, overnight].map((id) => profile(id))
      );
      await seedKnownCustomers(db, [repeat, holder, unpaidHolder, overnight]);
      const [
        repeatFirst,
        repeatOvernight,
        repeatLater,
        holderDay,
        unpaidHolderDay,
        overnightStay,
      ] = await seedEvents(
        Object.entries(visits).map(([reservation, visit]) => ({
          kind: "reservation-finished" as const,
          reservation,
          customer: visit.customer,
          occurredAt: visit.endsAt,
        }))
      );
      const campaignId = await seedAutomation({
        flow: decodeFlow({
          trigger: {
            _tag: "ReservationFinished",
            product: { family: "cowork", properties: [] },
            stay: "day",
            payment: "individual",
          },
          steps: [{ ...send, oncePerCustomer: true, skipPassHolders: true }],
        }),
      });

      const started = await start(campaignId);
      await processAll(started.previewId);

      const rows = await rowsOf(started.previewId);
      const rowOf = (eventId: string | undefined) =>
        rows.find((row) => row.customerEventId === eventId);
      expect(rowOf(repeatFirst)).toMatchObject({
        outcome: "would-send",
        skipReason: null,
      });
      expect(rowOf(repeatLater)).toMatchObject({
        outcome: "skipped",
        skipReason: "already-sent-once",
      });
      expect(rowOf(holderDay)).toMatchObject({
        outcome: "skipped",
        skipReason: "pass-holder",
      });
      for (const ruledOut of [
        repeatOvernight,
        unpaidHolderDay,
        overnightStay,
      ]) {
        expect(rowOf(ruledOut)).toBeUndefined();
      }
      // A customer whose every event the trigger rules out shows no row.
      expect(
        rows
          .map((row) => row.dotyposCustomerId)
          .filter((id) => id === unpaidHolder || id === overnight)
      ).toEqual([]);
    });

    test("an earlier version's sent run counts as sent once, and skipping pass holders reads marketing consent on an operational campaign", async () => {
      const triggerAt = ago({ hours: 24 * 10 });
      const [plain, sentEarlier, withdrawn] = [
        customerId("policy-op-plain"),
        customerId("policy-op-sent-earlier"),
        customerId("policy-op-withdrawn"),
      ];
      const { campaignId, previewId: activationPreviewId } =
        await kit.seedActive(
          decodeFlow({
            trigger: { _tag: "ReservationFinished" },
            steps: [{ ...send, oncePerCustomer: true, skipPassHolders: true }],
          })
        );
      await query(
        db
          .update(emailCampaigns)
          .set({ purpose: "operational" })
          .where(eq(emailCampaigns.id, campaignId))
      );
      const customers = [plain, sentEarlier, withdrawn];
      dotyposState.customers.push(...customers.map((id) => profile(id)));
      await seedKnownCustomers(db, customers);
      await query(
        db
          .update(customerMarketingConsents)
          .set({ withdrawnAt: now })
          .where(eq(customerMarketingConsents.dotyposCustomerId, withdrawn))
      );
      // Activation's completed dry run would otherwise be reused.
      await query(
        db
          .update(emailCampaignAutomationPreviews)
          .set({ status: "superseded" })
          .where(eq(emailCampaignAutomationPreviews.id, activationPreviewId))
      );
      claimedCampaignIds.push(campaignId);
      // A run of the campaign sent `sentEarlier` the email without a claim,
      // as a version without the policy does.
      const [version] = await query(
        db
          .select({ id: emailCampaignAutomationVersions.id })
          .from(emailCampaignAutomationVersions)
          .where(eq(emailCampaignAutomationVersions.campaignId, campaignId))
      );
      const sendId = await seedAutomatedSend(db, {
        campaignId,
        versionId: requireValue(version).id,
        purpose: "operational",
        recipients: [
          { dotyposCustomerId: sentEarlier, status: "sent" as const },
        ],
      });
      const earlierRun = await seedAutomationRun(db, {
        campaignId,
        versionId: requireValue(version).id,
        customerId: sentEarlier,
        stepId: "send",
        phase: "ready",
        stepEnteredAt: ago({ hours: 24 * 20 }),
        dueAt: ago({ hours: 24 * 20 }),
      });
      await query(
        db
          .update(emailCampaignAutomationRuns)
          .set({
            status: "ended",
            phase: null,
            dueAt: null,
            sendId,
            outcome: "sent",
            endedAt: ago({ hours: 24 * 20 }),
          })
          .where(eq(emailCampaignAutomationRuns.id, earlierRun))
      );

      await seedReservations(
        customers.map((customer, index) => ({
          label: `policy-op-${index}`,
          customer,
          startsAt: triggerAt.subtract({ hours: 2 }),
          endsAt: triggerAt,
        }))
      );
      await seedEvents(
        customers.map((customer, index) => ({
          kind: "reservation-finished" as const,
          reservation: `policy-op-${index}`,
          customer,
          occurredAt: triggerAt,
        }))
      );

      const started = await start(campaignId);
      await processAll(started.previewId);
      const report = await read(started.previewId);
      const rowOf = (customer: DotyposCustomerId) =>
        report.rows.find((row) => row.customerId === customer);

      expect(rowOf(plain)).toMatchObject({
        outcome: "would-send",
        skipReason: null,
      });
      expect(rowOf(sentEarlier)).toMatchObject({
        outcome: "skipped",
        skipReason: "already-sent-once",
      });
      expect(rowOf(withdrawn)).toMatchObject({
        outcome: "skipped",
        skipReason: "consent-withdrawn",
      });
    });

    describe("schedule triggers", () => {
      let customers: readonly DotyposCustomerId[] = [];
      const scheduleFlow = (weekday: string, conditionId = "vip") =>
        decodeFlow({
          trigger: { _tag: "Schedule", calendar: weekly(weekday) },
          steps: [condition(conditionId, taggedVip), send],
        });

      test("seeds the pool", async () => {
        customers = await seedScheduleCustomers("pool", 250);
        expect(customers.length).toBe(250);
      });

      test("a draft previews its own next fires and entrants", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("monday"),
        });
        const started = await start(campaignId);
        expect(started.kind).toBe("schedule");
        const fire = Temporal.Instant.from(started.asOf);
        expect(pragueOf(fire).dayOfWeek).toBe(1);
        expect(pragueOf(fire).hour).toBe(10);

        await processAll(started.previewId);
        const dryRun = await read(started.previewId);
        expect(dryRun.status).toBe("completed");
        expect(dryRun.nextFires).toHaveLength(5);
        expect(dryRun.nextFires[0]).toBe(fire.toString());
        expect(
          dryRun.nextFires.every(
            (at) => pragueOf(Temporal.Instant.from(at)).dayOfWeek === 1
          )
        ).toBe(true);
        expect(dryRun.frequency).toEqual({
          maxFiresPerHour: 1,
          firesMoreThanHourly: false,
        });
        expect(dryRun.emails.map(({ locale }) => locale)).toEqual(["cs-CZ"]);

        const rows = new Map(
          (await rowsOf(started.previewId)).map((row) => [
            row.dotyposCustomerId,
            row,
          ])
        );
        expect(rows.get(requireValue(customers[0]))).toMatchObject({
          outcome: "would-send",
          stepId: "send",
          projected: true,
        });
        expect(rows.get(requireValue(customers[0]))?.sendAt?.equals(fire)).toBe(
          true
        );
        expect(rows.get(requireValue(customers[20]))).toMatchObject({
          outcome: "condition-failed",
          stepId: "vip",
        });
      });

      test("an active Monday v1 edited to Wednesdays previews Wednesdays", async () => {
        // Activated through the lifecycle, so v1 fires on Mondays.
        const { campaignId } = await kit.seedActive(scheduleFlow("monday"));
        const [active] = await query(
          db
            .select({ nextFireAt: emailCampaignAutomations.nextFireAt })
            .from(emailCampaignAutomations)
            .where(eq(emailCampaignAutomations.campaignId, campaignId))
        );
        const nextMonday = requireValue(
          requireValue(active, "active automation").nextFireAt,
          "next Monday fire"
        );
        expect(pragueOf(nextMonday).dayOfWeek).toBe(1);
        await kit.run(
          kit.lifecycle((lifecycle) =>
            lifecycle.updateFlow({
              campaignId,
              flow: scheduleFlow("wednesday"),
            })
          )
        );

        const started = await start(campaignId);
        expect(pragueOf(Temporal.Instant.from(started.asOf)).dayOfWeek).toBe(3);
        const dryRun = await read(started.previewId);
        expect(
          dryRun.nextFires.every(
            (at) => pragueOf(Temporal.Instant.from(at)).dayOfWeek === 3
          )
        ).toBe(true);
        const [automation] = await query(
          db
            .select({ nextFireAt: emailCampaignAutomations.nextFireAt })
            .from(emailCampaignAutomations)
            .where(eq(emailCampaignAutomations.campaignId, campaignId))
        );
        expect(automation?.nextFireAt?.equals(nextMonday)).toBe(true);
      });

      test("units completing in any order or retried write no duplicates", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("friday"),
        });
        const started = await start(campaignId);
        const units = await unitsOf(started.previewId);
        expect(units.length).toBeGreaterThanOrEqual(3);

        // The last unit fails its Dotypos read once and is redelivered.
        const [last, ...rest] = units.toReversed();
        dotyposState.failNextCustomerPage = true;
        expect(Exit.isFailure(await processUnit(requireValue(last).id))).toBe(
          true
        );
        expect(Exit.isSuccess(await processUnit(requireValue(last).id))).toBe(
          true
        );
        for (const unit of rest) {
          expect(Exit.isSuccess(await processUnit(unit.id))).toBe(true);
        }

        const preview = await previewRow(started.previewId);
        expect(preview).toMatchObject({
          status: "completed",
          unitsDone: units.length,
        });
        const rows = await rowsOf(started.previewId);
        const subjects = units.flatMap(
          (unit) => readPreviewCustomers(unit.subject).customerIds
        );
        expect(rows.length).toBe(subjects.length);
        expect(new Set(rows.map((row) => row.dotyposCustomerId)).size).toBe(
          rows.length
        );
        expect(
          Object.values(preview.counts).reduce((sum, value) => sum + value, 0)
        ).toBe(rows.length);
      });

      test("returns the dry run of the current draft and supersedes an older one", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("tuesday"),
        });
        const first = await start(campaignId);
        expect((await start(campaignId)).previewId).toBe(first.previewId);

        await editFlow(campaignId, scheduleFlow("tuesday", "vip-only"));
        const second = await start(campaignId);
        expect(second.previewId).not.toBe(first.previewId);
        expect((await previewRow(first.previewId)).status).toBe("superseded");
        expect(
          (await unitsOf(first.previewId)).every(
            (unit) => unit.status === "dropped"
          )
        ).toBe(true);
      });

      test("an edit mid-job supersedes it", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("thursday"),
        });
        const started = await start(campaignId);
        const [first, second, ...rest] = await unitsOf(started.previewId);
        expect(Exit.isSuccess(await processUnit(requireValue(first).id))).toBe(
          true
        );
        const written = (await rowsOf(started.previewId)).length;

        await editFlow(campaignId, scheduleFlow("thursday", "edited"));
        expect(Exit.isSuccess(await processUnit(requireValue(second).id))).toBe(
          true
        );

        expect((await previewRow(started.previewId)).status).toBe("superseded");
        expect((await rowsOf(started.previewId)).length).toBe(written);
        const units = await unitsOf(started.previewId);
        expect(
          units.find((unit) => unit.id === requireValue(second).id)?.status
        ).toBe("done");
        // Planned units drop; ones a hand-off already enqueued are marked.
        expect(
          units
            .filter((unit) => rest.some(({ id }) => id === unit.id))
            .every(
              (unit) =>
                unit.status === "dropped" ||
                (unit.status === "enqueued" && unit.cancelRequestedAt !== null)
            )
        ).toBe(true);
      });

      test("a running dry run without progress for an hour fails", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("saturday"),
        });
        const started = await start(campaignId);
        await query(
          db
            .update(emailCampaignAutomationPreviews)
            .set({ createdAt: ago({ hours: 2 }) })
            .where(eq(emailCampaignAutomationPreviews.id, started.previewId))
        );

        const dryRun = await read(started.previewId);
        expect(dryRun).toMatchObject({
          status: "failed",
          errorCode: "preview-stalled",
        });
        expect((await previewRow(started.previewId)).status).toBe("failed");
        expect(
          (await unitsOf(started.previewId)).every(
            (unit) => unit.status === "dropped"
          )
        ).toBe(true);
        // A new start replaces it.
        const restarted = await start(campaignId);
        expect(restarted.previewId).not.toBe(started.previewId);
      });

      test("hydrates at most 200 customers per page, live", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("sunday"),
        });
        const started = await start(campaignId);
        await processAll(started.previewId);

        dotyposState.customerPageCalls = [];
        const page = await read(started.previewId);
        expect(page.rows.length).toBe(200);
        expect(page.customers.length).toBeLessThanOrEqual(200);
        expect(page.customers.length).toBe(
          new Set(page.rows.map(({ customerId }) => customerId)).size
        );
        expect(dotyposState.customerPageCalls.length).toBeLessThanOrEqual(4);
        expect(dotyposState.customerPageCalls.every((ids) => ids <= 200)).toBe(
          true
        );
        const named = page.customers.find(
          ({ customerId }) => customerId === customers[0]
        );
        expect(named?.email).toBe(testEmailAddress(requireValue(customers[0])));
        expect(page.nextCursor).not.toBeNull();

        const next = await read(started.previewId, {
          cursor: requireValue(page.nextCursor),
        });
        expect(next.rows.length).toBeGreaterThan(0);
        expect(
          next.rows.some(({ customerId }) =>
            page.rows.some((row) => row.customerId === customerId)
          )
        ).toBe(false);
      });

      test("a solo unit missing its deadline three times reports unavailable", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("monday", "late"),
        });
        const started = await start(campaignId);
        const [unit] = await unitsOf(started.previewId);
        await query(
          db
            .update(emailCampaignAutomationWorkUnits)
            .set({ deadlineMisses: 3 })
            .where(
              eq(emailCampaignAutomationWorkUnits.id, requireValue(unit).id)
            )
        );
        expect(Exit.isSuccess(await processUnit(requireValue(unit).id))).toBe(
          true
        );
        const rows = await rowsOf(started.previewId);
        expect(rows.length).toBe(
          readPreviewCustomers(requireValue(unit).subject).customerIds.length
        );
        expect(rows.every((row) => row.outcome === "unavailable")).toBe(true);
      });

      test("refuses an automation without a flow", async () => {
        const campaignId = await seedAutomation({
          flow: scheduleFlow("monday", "x"),
        });
        await query(
          db
            .update(emailCampaignAutomations)
            .set({ flow: null })
            .where(eq(emailCampaignAutomations.campaignId, campaignId))
        );
        const noFlow = await runExit(
          Effect.flatMap(AutomationDryRun, (dryRun) => dryRun.start(campaignId))
        );
        expect(noFlow).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { _tag: "AutomationFlowInvalid" } }] },
        });
      });
    });

    describe("pass reminder triggers", () => {
      const runAt = <A, E>(
        operation: Effect.Effect<A, E, AutomationDryRun>,
        at: Temporal.Instant
      ) =>
        Effect.runPromise(
          TestClock.setTime(at.epochMilliseconds).pipe(
            Effect.andThen(operation),
            Effect.provide(Layer.merge(dryRunLayer, TestClock.layer()))
          )
        );

      const startReminder = (campaignId: CampaignId, at: Temporal.Instant) =>
        runAt(
          Effect.flatMap(AutomationDryRun, (dryRun) =>
            dryRun.start(campaignId)
          ),
          at
        );

      for (const _tag of ["EntryPackExpiring", "UnlimitedEnding"] as const) {
        test(`${_tag} previews current recipients and synthetic emails without entering runs`, async () => {
          const trigger = { _tag };
          const published = await seedPublishedEmail(db, {
            title: `Dry-run ${_tag} email`,
            document: passReminderEmailDocumentFixture(
              _tag === "EntryPackExpiring"
                ? "entry-pack-expiring"
                : "unlimited-ending"
            ),
          });
          const campaignId = await seedAutomation({
            flow: decodeFlow({ trigger, steps: [send] }),
            purpose: "marketing",
            filter: { ...everyoneFilter, filters: [taggedVip] },
          });
          await query(
            db
              .update(emailCampaigns)
              .set({
                emailId: published.emailId,
                content: {},
                templateKey: "workspace",
              })
              .where(eq(emailCampaigns.id, campaignId))
          );
          const operationalId = await seedAutomation({
            flow: decodeFlow({ trigger, steps: [send] }),
            purpose: "operational",
            filter: { ...everyoneFilter, filters: [taggedVip] },
          });
          const refusal = await runExit(
            Effect.flatMap(AutomationDryRun, (dryRun) =>
              dryRun.start(operationalId)
            )
          );
          expect(Exit.isFailure(refusal)).toBe(true);

          const occurrence = nextPassReminderPreviewOccurrence(trigger, now);
          const { kind, dueDate, fireAt } = occurrence;
          const { validUntil } = getPassReminderEndDates(kind, dueDate);
          const eligible = customerId(`${kind}-due`);
          const withdrawn = customerId(`${kind}-withdrawn`);
          const unconsented = customerId(`${kind}-unconsented`);
          const historic = customerId(`${kind}-historic`);
          const otherHolder = customerId(`${kind}-shared-mailbox`);
          const outsideAudience = customerId(`${kind}-outside-audience`);
          const historicDate = plainDateStringSchema.make(
            Temporal.PlainDate.from(dueDate).subtract({ days: 1 }).toString()
          );
          const historicEnd = getPassReminderEndDates(kind, historicDate);
          const holder = await seedPassHolder(eligible);
          const passId = await seedPass({ holder, kind, validUntil });
          if (kind === "entry-pack") {
            await seedPass({ holder, kind, validUntil });
          }
          await seedPass({
            holder: await seedPassHolder(otherHolder, {
              email: testEmailAddress(eligible),
              tags: ["vip"],
            }),
            kind,
            validUntil,
          });
          await seedPass({
            holder: await seedPassHolder(outsideAudience, { tags: [] }),
            kind,
            validUntil,
          });
          for (const [id, end] of [
            [withdrawn, validUntil],
            [unconsented, validUntil],
            [historic, historicEnd.validUntil],
          ] as const) {
            await seedPass({
              holder: await seedPassHolder(id),
              kind,
              validUntil: end,
            });
          }
          await seedKnownCustomers(db, [
            eligible,
            withdrawn,
            historic,
            otherHolder,
            outsideAudience,
          ]);

          const started = await startReminder(campaignId, now);
          expect(started).toMatchObject({
            kind: "schedule",
            asOf: fireAt.toString(),
            status: "running",
          });
          expect(pragueOf(fireAt).hour).toBe(10);
          expect((await startReminder(campaignId, now)).previewId).toBe(
            started.previewId
          );
          await query(
            db
              .update(customerMarketingConsents)
              .set({ withdrawnAt: now })
              .where(eq(customerMarketingConsents.dotyposCustomerId, withdrawn))
          );
          await processAll(started.previewId);

          const report = await read(started.previewId);
          expect(report).toMatchObject({
            status: "completed",
            eventsTotal: null,
            nextFires: [fireAt.toString()],
          });
          expect(report.rows).toEqual([
            expect.objectContaining({
              customerId: eligible,
              outcome: "would-send",
            }),
            expect.objectContaining({
              customerId: outsideAudience,
              outcome: "not-in-audience",
            }),
            expect.objectContaining({
              customerId: otherHolder,
              outcome: "would-send",
            }),
            expect.objectContaining({
              customerId: withdrawn,
              outcome: "not-in-audience",
            }),
          ]);
          expect(report.emails.map(({ locale }) => locale)).toEqual(
            campaignLocales
          );
          for (const email of report.emails) {
            expect(email.preheader).toBeTruthy();
            expect(email.html).toContain(
              _tag === "EntryPackExpiring" ? "/reservation/cowork" : "/passes/"
            );
            expect(email.html).not.toContain(passId);
            expect(email.html).not.toContain(testEmailAddress(eligible));
            expect(email.subject).not.toBe("Rozpracovaný koncept");
          }
          const wire = Schema.encodeSync(AutomationDryRunWire)(report);
          expect(wire.emails).toHaveLength(campaignLocales.length);
          expect(wire.emails[0]).not.toHaveProperty("preheader");
          await query(
            db
              .update(customerMarketingConsents)
              .set({ withdrawnAt: now })
              .where(
                eq(customerMarketingConsents.dotyposCustomerId, otherHolder)
              )
          );
          const refreshed = await startReminder(campaignId, now);
          expect(refreshed.previewId).not.toBe(started.previewId);
          expect(refreshed.asOf).toBe(started.asOf);
          await processAll(refreshed.previewId);
          expect(
            (await read(refreshed.previewId)).rows.map(
              ({ customerId }) => customerId
            )
          ).toEqual([eligible, outsideAudience]);
          expect((await read(started.previewId)).rows).toEqual(report.rows);
          expect(
            await query(
              db
                .select()
                .from(emailCampaignAutomationRuns)
                .where(eq(emailCampaignAutomationRuns.campaignId, campaignId))
            )
          ).toEqual([]);
          expect(
            await query(
              db
                .select()
                .from(emailCampaignSends)
                .where(eq(emailCampaignSends.campaignId, campaignId))
            )
          ).toEqual([]);

          const later = fireAt.add({ seconds: 1 });
          const next = await startReminder(campaignId, later);
          expect(next.previewId).not.toBe(started.previewId);
          expect(next.status).toBe("completed");
          expect(
            await runAt(
              Effect.flatMap(AutomationDryRun, (dryRun) =>
                dryRun.get({ previewId: started.previewId })
              ),
              later
            )
          ).toMatchObject({
            asOf: report.asOf,
            createdAt: report.createdAt,
            nextFires: [report.asOf],
          });

          await editFlow(
            campaignId,
            decodeFlow({
              trigger: { _tag: "Schedule", calendar: weekly("monday") },
              steps: [send],
            })
          );
          expect(await read(started.previewId)).toMatchObject({
            asOf: report.asOf,
            createdAt: report.createdAt,
            counts: report.counts,
            rows: report.rows,
            nextFires: [],
            frequency: null,
            emails: [],
          });
        });
      }
    });
  }
);

describe.skipIf(!testDatabase)(
  "AutomationDryRun and the engine agree (§8)",
  async () => {
    if (!testDatabase) return;
    const { pool } = testDatabase;
    const instant = (value: string) => Temporal.Instant.from(value);
    const iso = (value: Date | string | null | undefined) =>
      databaseInstant(value)?.toString() ?? null;
    const scenario = await makeAutomationEngineScenario({
      database: testDatabase,
      now: instant("2026-10-13T06:00:00Z"),
      prefix: `dry-run-parity-${runId}`,
    });
    const dryRunner = makeAutomationDryRunner({
      database: testDatabase,
      dotypos: scenario.dotypos.layer,
    });
    const { fixtures, kit, read } = scenario;
    afterAll(() => scenario.cleanup());

    type PreviewRow = {
      readonly dotypos_customer_id: string;
      readonly customer_event_id: string | null;
      readonly outcome: string;
      readonly step_id: string | null;
      readonly send_at: Date | string | null;
    };
    const previewRows = async (previewId: AutomationPreviewId) =>
      (
        await pool.query<PreviewRow>(
          "select * from email_campaign_automation_preview_rows where preview_id = $1 order by trigger_at, dotypos_customer_id",
          [previewId]
        )
      ).rows;

    /**
     * Starts a dry run of the active automation at `at` and processes it,
     * then runs the engine on the same Dotypos data from the same instant
     * until every run of the campaign has ended. The dry run's rows are
     * read once it completes, since the planner prunes week-old dry runs.
     * The automation is archived afterwards, so later tests' schedules
     * don't fire it.
     */
    const dryRunThenEngine = async (
      active: {
        readonly campaignId: CampaignId;
        readonly previewId: AutomationPreviewId;
      },
      at: Temporal.Instant,
      until: Temporal.Instant
    ) => {
      const { campaignId } = active;
      await scenario.prepare(at);
      // The kit's stand-in for the dry run that let it activate.
      await pool.query(
        "update email_campaign_automation_previews set status = 'superseded' where id = $1",
        [active.previewId]
      );
      const started = await dryRunner.start(campaignId, at);
      const previewed = await scenario.runUntil({
        from: at,
        until: at,
        sameInstant: true,
        settled: async () => {
          const { rows } = await pool.query<{ status: string }>(
            "select status from email_campaign_automation_previews where id = $1",
            [started.previewId]
          );
          return rows[0]?.status === "completed";
        },
      });
      expect(previewed.settled).toBe(true);
      const rows = await previewRows(started.previewId);
      // The engine on the cron's ticks, which the dry run's times model.
      const progress = await scenario.runUntil({
        from: at,
        until,
        onTicks: true,
        settled: async () => {
          const runs = await read.runs(campaignId);
          return runs.length > 0 && runs.every((run) => run.status === "ended");
        },
      });
      expect(progress.settled).toBe(true);
      await scenario.lifecycle(
        (lifecycle) => lifecycle.archive(campaignId),
        progress.at
      );
      return { started, rows, runs: await read.runs(campaignId) };
    };

    /** The columns of an ended run that parity compares. */
    type EndedRun = {
      readonly outcome: string | null;
      readonly step_id: string;
      readonly step_entered_at: Date | string;
    };
    /** A run's end as a dry-run row states it: the send instant is when the run reached its send step. */
    const engineOutcome = (run: EndedRun) => ({
      outcome: run.outcome === "sent" ? "would-send" : run.outcome,
      stepId: run.step_id,
      sendAt: run.outcome === "sent" ? iso(run.step_entered_at) : null,
    });
    const rowOutcome = (row: PreviewRow) => ({
      outcome: row.outcome,
      stepId: row.step_id,
      sendAt: iso(row.send_at),
    });

    test("story 1: identical send instants for the same events", async () => {
      const active = await kit.seedActive(reviewRequestFlow, {
        at: instant("2026-10-13T06:00:00Z"),
      });
      const second = await fixtures.addCustomer("story1-second");
      const once = await fixtures.addCustomer("story1-once");
      const finishedVisit = async (
        label: string,
        customer: DotyposCustomerId,
        endsAt: Temporal.Instant
      ) => {
        const reservationId = await fixtures.book({
          label,
          customer,
          startsAt: endsAt.subtract({ hours: 8 }),
          endsAt,
        });
        return fixtures.recordEvent({
          kind: "reservation-finished",
          customer,
          occurredAt: endsAt,
          reservationId,
        });
      };
      // Before activation: the dry run replays it, the engine ignores it.
      const earlier = await finishedVisit(
        "story1-second-first",
        second,
        instant("2026-10-01T15:00:00Z")
      );
      await finishedVisit(
        "story1-second-second",
        second,
        instant("2026-10-13T15:00:00Z")
      );
      await finishedVisit("story1-once", once, instant("2026-10-13T15:00:00Z"));

      const { started, rows, runs } = await dryRunThenEngine(
        active,
        instant("2026-10-13T15:05:00Z"),
        instant("2026-10-15T00:00:00Z")
      );

      expect(started.kind).toBe("replay");
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        const row = rows.find(
          (candidate) => candidate.customer_event_id === run.trigger_event_id
        );
        expect(rowOutcome(requireValue(row, "row for the live run"))).toEqual(
          engineOutcome(run)
        );
      }
      const byCustomer = new Map(
        runs.map((run) => [run.dotypos_customer_id, engineOutcome(run)])
      );
      // 10:00 in Prague the next day, after the 2-hour settle.
      expect(byCustomer.get(second)).toEqual({
        outcome: "would-send",
        stepId: "send",
        sendAt: "2026-10-14T08:00:00Z",
      });
      expect(byCustomer.get(once)).toMatchObject({
        outcome: "condition-failed",
        stepId: "second-visit-within-a-month",
      });
      expect(
        rows.find((row) => row.customer_event_id === earlier)
      ).toMatchObject({ outcome: "condition-failed" });
    });

    test("story 2: identical send instants for the same fire", async () => {
      const activatedAt = instant("2026-10-18T10:00:00Z");
      const active = await kit.seedActive(comeBackOfferFlow, {
        at: activatedAt,
        audienceFilter: lapsedRegularsFilter,
      });
      const visit = async (
        label: string,
        customer: DotyposCustomerId,
        startsAt: string
      ) =>
        fixtures.book({
          label,
          customer,
          startsAt: instant(startsAt),
          endsAt: instant(startsAt).add({ hours: 8 }),
        });
      const regular = await fixtures.addCustomer("story2-regular");
      await visit("story2-regular-1", regular, "2026-07-10T07:00:00Z");
      await visit("story2-regular-2", regular, "2026-08-14T07:00:00Z");
      const recent = await fixtures.addCustomer("story2-recent");
      await visit("story2-recent-1", recent, "2026-07-10T07:00:00Z");
      await visit("story2-recent-2", recent, "2026-10-08T07:00:00Z");
      const single = await fixtures.addCustomer("story2-single");
      await visit("story2-single-1", single, "2026-07-10T07:00:00Z");

      const { started, rows, runs } = await dryRunThenEngine(
        active,
        activatedAt,
        instant("2026-10-19T09:00:00Z")
      );

      // Monday 10:00 in Prague.
      const fire = "2026-10-19T08:00:00Z";
      expect(started).toMatchObject({ kind: "schedule", asOf: fire });
      const rowsByCustomer = new Map(
        rows.map((row) => [row.dotypos_customer_id, rowOutcome(row)])
      );
      const runsByCustomer = new Map(
        runs.map((run) => [run.dotypos_customer_id, engineOutcome(run)])
      );
      expect(
        new Map(
          [...rowsByCustomer].filter(([, row]) => row.outcome === "would-send")
        )
      ).toEqual(new Map(runsByCustomer));
      expect(runsByCustomer.get(regular)).toEqual({
        outcome: "would-send",
        stepId: "send",
        sendAt: fire,
      });
      expect(runsByCustomer.has(recent)).toBe(false);
      expect(runsByCustomer.has(single)).toBe(false);
    });

    test("§8.1: at 10:30 on a Monday both send next Monday at 10:00", async () => {
      const mondayAtHalfPastTen = instant("2026-10-19T08:30:00Z");
      const active = await kit.seedActive(
        automationFlowFixture({
          trigger: {
            _tag: "Schedule",
            calendar: { weekdays: ["monday"], hours: [10] },
          },
          steps: [
            {
              _tag: "Wait",
              id: "ten-oclock",
              wait: { _tag: "Calendar", expression: { hours: [10] } },
            },
            { _tag: "Send", id: "send" },
          ],
        }),
        { at: mondayAtHalfPastTen }
      );
      const customer = await fixtures.addCustomer("half-past-ten");
      await fixtures.book({
        label: "half-past-ten",
        customer,
        startsAt: instant("2026-09-01T07:00:00Z"),
        endsAt: instant("2026-09-01T15:00:00Z"),
      });

      const { started, rows, runs } = await dryRunThenEngine(
        active,
        mondayAtHalfPastTen,
        instant("2026-10-26T10:00:00Z")
      );

      // 10:00 in Prague on 26 October, after the switch to winter time.
      const nextMonday = "2026-10-26T09:00:00Z";
      expect(started).toMatchObject({ kind: "schedule", asOf: nextMonday });
      const row = rows.find(
        (candidate) => candidate.dotypos_customer_id === customer
      );
      const run = runs.find(
        (candidate) => candidate.dotypos_customer_id === customer
      );
      expect(rowOutcome(requireValue(row))).toEqual({
        outcome: "would-send",
        stepId: "send",
        sendAt: nextMonday,
      });
      expect(engineOutcome(requireValue(run))).toEqual(
        rowOutcome(requireValue(row))
      );
      for (const other of runs) {
        expect(
          rowOutcome(
            requireValue(
              rows.find(
                (candidate) =>
                  candidate.dotypos_customer_id === other.dotypos_customer_id
              )
            )
          )
        ).toEqual(engineOutcome(other));
      }
    });
  }
);
