import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import {
  DotyposBranchIdSchema,
  DotyposCloudIdSchema,
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { customerMarketingConsents } from "@/db/schema";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import type { AudienceFilter } from "../audience-filter";
import type { CampaignId } from "../campaign-identifiers";
import { AudienceFactsService } from "./audience-facts.service";
import { CampaignAudienceService } from "./campaign-audience.service";
import { CampaignCandidateRepository } from "./campaign-candidate.repository";
import { CampaignRecipientService } from "./campaign-recipient.service";
import { seedCampaignSend } from "./email-campaigns.test-utils";

/**
 * The one-off launch audiences of the pass entry-point campaigns, built only
 * from existing saved-audience attributes and resolved the way a one-off
 * send resolves them: the saved audience's filter, marketing purpose, every
 * candidate, evaluated at the clock's current time.
 */
const database = await createWorkspacePostgresSuiteDatabase(
  "launch_audience_cohorts"
);
afterAll(() => database?.close());

const at = (value: string) => Temporal.Instant.from(value);
const launchAt = at("2026-10-15T08:00:00Z");
/** The launch follow-up goes out three days after the lapsed group's email. */
const followUpAt = launchAt.add({ hours: 72 });
/** "Last 60 days" steps back through the Prague calendar from `now`. */
const sixtyDaysBefore = (instant: Temporal.Instant) =>
  instant
    .toZonedDateTimeISO("Europe/Prague")
    .subtract({ days: 60 })
    .toInstant();
const launchCutoff = sixtyDaysBefore(launchAt);
const bookedLongBefore = at("2026-01-01T00:00:00Z");

/** Completed coworking visits whose end falls in the last 60 days. */
const completedCoworkVisitsInLast60Days = (
  operator: "gt" | "eq"
): AudienceFilter => ({
  attribute: "reservationCount",
  _tag: "Condition",
  params: {
    dateBasis: "visitEnd",
    period: { _tag: "Last", count: 60, unit: "day" },
    product: { family: "cowork", properties: [] },
  },
  operator,
  value: 0,
});

/** Customers the given campaign's email reached (accepted or uncertain). */
const receivedCampaign = (campaignId: CampaignId): AudienceFilter => ({
  attribute: "campaignEmailCount",
  _tag: "Condition",
  params: {
    purpose: "any",
    period: { _tag: "AnyTime" },
    campaign: { _tag: "Specific", campaignId },
  },
  operator: "gt",
  value: 0,
});

type Consent = "active" | "withdrawn" | "none";
type Visit = {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
  readonly product?: "cowork" | "meeting-room";
  readonly cancelled?: "workspace" | "provider";
};
type Shopper = {
  readonly consent: Consent;
  readonly visits: readonly Visit[];
};

const visitEndingAt = (end: Temporal.Instant, extra: Partial<Visit> = {}) => ({
  start: end.subtract({ hours: 2 }),
  end,
  ...extra,
});

const shoppers = {
  /** One completed cowork visit ten days ago. */
  recentOnce: {
    consent: "active",
    visits: [visitEndingAt(launchAt.subtract({ hours: 240 }))],
  },
  /** The visit ended exactly at the 60-day cutoff, which the period includes. */
  recentAtCutoff: {
    consent: "active",
    visits: [visitEndingAt(launchCutoff)],
  },
  /** The visit ended a second before the 60-day cutoff. */
  lapsedJustBeforeCutoff: {
    consent: "active",
    visits: [visitEndingAt(launchCutoff.subtract({ seconds: 1 }))],
  },
  lapsedLongAgo: {
    consent: "active",
    visits: [visitEndingAt(at("2026-03-01T10:00:00Z"))],
  },
  /** An opted-in subscriber without any reservation. */
  neverVisited: { consent: "active", visits: [] },
  /** The only recent visit was cancelled in Workspace. */
  cancelledInWorkspace: {
    consent: "active",
    visits: [
      visitEndingAt(launchAt.subtract({ hours: 120 }), {
        cancelled: "workspace",
      }),
    ],
  },
  /** The only recent visit was cancelled in Dotypos. */
  cancelledInDotypos: {
    consent: "active",
    visits: [
      visitEndingAt(launchAt.subtract({ hours: 96 }), {
        cancelled: "provider",
      }),
    ],
  },
  /** The visit began an hour before the launch and hasn't ended. */
  visitInProgress: {
    consent: "active",
    visits: [
      {
        start: launchAt.subtract({ hours: 1 }),
        end: launchAt.add({ hours: 1 }),
      },
    ],
  },
  /** The only visit is booked for the day after the launch. */
  visitBookedAhead: {
    consent: "active",
    visits: [visitEndingAt(launchAt.add({ hours: 26 }))],
  },
  /** A recent meeting-room booking is not a coworking visit. */
  meetingRoomOnly: {
    consent: "active",
    visits: [
      visitEndingAt(launchAt.subtract({ hours: 48 }), {
        product: "meeting-room",
      }),
    ],
  },
  withdrawnRecent: {
    consent: "withdrawn",
    visits: [visitEndingAt(launchAt.subtract({ hours: 72 }))],
  },
  withdrawnNeverVisited: { consent: "withdrawn", visits: [] },
  neverConsentedLapsed: {
    consent: "none",
    visits: [visitEndingAt(at("2026-04-01T10:00:00Z"))],
  },
} satisfies Record<string, Shopper>;
type ShopperName = keyof typeof shoppers;

const run = crypto.randomUUID().slice(0, 8);
const customerOf = (name: ShopperName) =>
  DotyposCustomerIdSchema.make(`launch-${run}-${name}`);
const names = Object.keys(shoppers).filter((name): name is ShopperName =>
  Object.hasOwn(shoppers, name)
);
const visits = names.flatMap((name) =>
  shoppers[name].visits.map((visit: Visit, index) => ({
    ...visit,
    customer: customerOf(name),
    id: DotyposReservationIdSchema.make(`launch-${run}-${name}-${index}`),
  }))
);

const seedShoppers = (db: NonNullable<typeof database>["db"]) =>
  Effect.all([
    workspaceFixtures(db).reservations(
      visits.map(({ customer, id, product, cancelled }) => ({
        customer,
        locale: "cs-CZ" as const,
        at: bookedLongBefore,
        details:
          product === "meeting-room"
            ? { kind: "meeting-room" as const, earlySetup: false }
            : {
                kind: "cowork" as const,
                entryTier: "open-space" as const,
                coffee: false,
              },
        stage:
          cancelled === "workspace"
            ? { reservation: "cancelled" as const, payment: "paid" as const }
            : {
                reservation: "confirmed" as const,
                payment: "paid" as const,
                fulfillment: "fulfilled" as const,
              },
        overrides: {
          createdAt: bookedLongBefore,
          dotyposReservationId: id,
          reservationConfirmedAt: bookedLongBefore,
        },
      }))
    ),
    db.insert(customerMarketingConsents).values(
      names
        .filter((name) => shoppers[name].consent !== "none")
        .map((name) => ({
          dotyposCustomerId: customerOf(name),
          documentHash: "hash",
          locale: "cs-CZ" as const,
          grantedAt: bookedLongBefore,
          ...(shoppers[name].consent === "withdrawn" && {
            withdrawnAt: bookedLongBefore.add({ hours: 24 }),
          }),
        }))
    ),
  ]);

const dotyposCloud = DotyposCloudIdSchema.make("launch-cloud");
const dotypos = makeInMemoryDotypos({
  customers: names.map((name) => ({
    id: customerOf(name),
    email: testEmailAddress(`launch-${run}-${name}`),
    _cloudId: dotyposCloud,
    display: true,
    flags: "0",
    points: "0",
    deleted: false,
  })),
  reservations: visits.map(({ id, customer, start, end, cancelled }) => ({
    id,
    _branchId: DotyposBranchIdSchema.make("launch-branch"),
    _cloudId: dotyposCloud,
    _customerId: customer,
    seats: "1",
    startDate: start.toString(),
    endDate: end.toString(),
    status:
      cancelled === "provider" ? ("CANCELLED" as const) : ("NEW" as const),
  })),
});

describe.skipIf(!database)(
  "pass launch audiences on Postgres with existing saved-audience attributes",
  () => {
    if (!database) return;

    const layer = Layer.mergeAll(
      CampaignAudienceService.Default,
      CampaignRecipientService.Default.pipe(
        Layer.provide(AudienceFactsService.Default),
        Layer.provideMerge(
          Layer.mergeAll(
            CampaignCandidateRepository.Default,
            DotyposServiceMock(dotypos.service)
          )
        )
      )
    ).pipe(Layer.provide(database.layer));

    /** Saves the filter as an audience, as an operator would. */
    const saveAudience = (title: string, filter: AudienceFilter) =>
      Effect.runPromise(
        Effect.flatMap(CampaignAudienceService, (audiences) =>
          audiences.create({ title, filter })
        ).pipe(Effect.provide(layer))
      );

    /** The audience's marketing recipients a one-off send freezes at `now`. */
    const recipientsAt = (
      audience: { readonly filter: AudienceFilter },
      now: Temporal.Instant
    ) =>
      Effect.runPromise(
        TestClock.setTime(now.epochMilliseconds).pipe(
          Effect.andThen(
            Effect.flatMap(CampaignRecipientService, (recipients) =>
              recipients.resolve({
                purpose: "marketing",
                filter: audience.filter,
              })
            )
          ),
          Effect.provide(Layer.mergeAll(layer, TestClock.layer()))
        )
      ).then(({ recipients }) =>
        recipients
          .map(({ dotyposCustomerId }) => dotyposCustomerId)
          .toSorted((left, right) => left.localeCompare(right))
      );

    const customersOf = (...members: readonly ShopperName[]) =>
      members
        .map(customerOf)
        .toSorted((left, right) => left.localeCompare(right));

    const withdraw = (customer: DotyposCustomerId) =>
      database.pool.query(
        "update customer_marketing_consents set withdrawn_at = $2 where dotypos_customer_id = $1",
        [customer, launchAt.add({ hours: 1 }).toString()]
      );

    test("splits opted-in customers by their last completed coworking visit and keeps the lapsed group's follow-up frozen", async () => {
      await Effect.runPromise(seedShoppers(database.db));
      const recent = await saveAudience(
        "Recent coworkers",
        completedCoworkVisitsInLast60Days("gt")
      );
      const lapsed = await saveAudience(
        "Lapsed and never-visited coworkers",
        completedCoworkVisitsInLast60Days("eq")
      );

      const recentAtLaunch = customersOf("recentOnce", "recentAtCutoff");
      const lapsedAtLaunch = customersOf(
        "lapsedJustBeforeCutoff",
        "lapsedLongAgo",
        "neverVisited",
        "cancelledInWorkspace",
        "cancelledInDotypos",
        "visitInProgress",
        "visitBookedAhead",
        "meetingRoomOnly"
      );
      // Exact lists: customers without active marketing consent
      // (withdrawnRecent, withdrawnNeverVisited, neverConsentedLapsed) are in
      // neither group.
      expect(await recipientsAt(recent, launchAt)).toEqual(recentAtLaunch);
      expect(await recipientsAt(lapsed, launchAt)).toEqual(lapsedAtLaunch);

      // The lapsed group's first email: who it reached decides the follow-up.
      const { campaignId: lapsedEmail } = await seedCampaignSend(database.db, {
        purpose: "marketing",
        status: "sent",
        recipients: [
          {
            dotyposCustomerId: customerOf("lapsedJustBeforeCutoff"),
            status: "sent",
          },
          {
            dotyposCustomerId: customerOf("lapsedLongAgo"),
            status: "delivered",
          },
          { dotyposCustomerId: customerOf("neverVisited"), status: "sent" },
          { dotyposCustomerId: customerOf("visitBookedAhead"), status: "sent" },
          {
            dotyposCustomerId: customerOf("cancelledInWorkspace"),
            status: "unconfirmed",
          },
          {
            dotyposCustomerId: customerOf("cancelledInDotypos"),
            status: "failed",
            failureCode: "rejected",
          },
          {
            dotyposCustomerId: customerOf("visitInProgress"),
            status: "skipped",
          },
          { dotyposCustomerId: customerOf("meetingRoomOnly"), status: "sent" },
        ],
      });
      // The recent group's email doesn't count toward the lapsed follow-up.
      await seedCampaignSend(database.db, {
        purpose: "marketing",
        status: "sent",
        recipients: [
          { dotyposCustomerId: customerOf("recentOnce"), status: "sent" },
          { dotyposCustomerId: customerOf("recentAtCutoff"), status: "sent" },
        ],
      });
      const followUp = await saveAudience(
        "Lapsed coworkers follow-up",
        receivedCampaign(lapsedEmail)
      );
      await withdraw(customerOf("meetingRoomOnly"));

      // Three days later the visit booked ahead has completed, and the visit
      // at the launch cutoff has aged out of the last 60 days.
      expect(await recipientsAt(recent, followUpAt)).toEqual(
        customersOf("recentOnce", "visitInProgress", "visitBookedAhead")
      );
      expect(await recipientsAt(lapsed, followUpAt)).toContain(
        customerOf("recentAtCutoff")
      );
      expect(await recipientsAt(followUp, followUpAt)).toEqual(
        customersOf(
          "lapsedJustBeforeCutoff",
          "lapsedLongAgo",
          "neverVisited",
          "visitBookedAhead",
          "cancelledInWorkspace"
        )
      );
    });
  }
);
