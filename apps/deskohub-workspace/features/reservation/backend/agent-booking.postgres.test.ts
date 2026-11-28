import { dotyposHoldFixture } from "./workspace-reservation.test-utils";
import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  type DotyposReservationId,
  type DotyposReservationStatus,
  DotyposService,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { EmailRecipientDomainServiceMock } from "@deskohub/email/backend/recipient-domain.service.mock";
import { testEmailAddress } from "@deskohub/test-email";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { passEntryClaims, workspaceReservations } from "@/db/schema";
import type {
  CustomerAgentClientId,
  CustomerAgentGrant,
} from "@/features/account";
import { customerAgentClientIdSchema } from "@/features/account/backend/auth/customer-agent-authorization.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { makeCustomerAccountSections } from "@/features/account/backend/customer-account-sections.test-utils";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { inMemoryCustomerAgentCallServices } from "@/features/agent-tools/agent-tools.test-utils";
import { startReservationTool } from "@/features/agent-tools/start-reservation.tool";
import { recordCheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service.mock";
import {
  buildAdvertisedPriceState,
  sealAdvertisedPriceState,
} from "@/features/checkout/backend/checkout";
import { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import { ReservationHoldCleanupScheduleService } from "@/features/checkout/backend/holds";
import { WorkspaceTableAssignmentServiceMock } from "@/features/checkout/backend/reservation/workspace-table-assignment.service.mock";
import { getReservationQuoteFingerprint } from "@/features/checkout/reservation-quote-fingerprint";
import { getMeetingRoomReservationQuote } from "@/features/checkout/reservation-quote-meeting-room";
import {
  affirmedDiscountAdvertisementQuoteCodec,
  discountAdvertisementQuoteCodec,
} from "@/features/discounts";
import { DiscountServiceMock } from "@/features/discounts/discount.service.mock";
import type { Locale } from "@/features/i18n";
import { AnalyticsConsentLedger } from "@/features/legal/backend/analytics-consent-ledger";
import {
  type IMarketingConsentLedger,
  MarketingConsentLedger,
} from "@/features/legal/backend/marketing-consent-ledger";
import { OfficeReleaseGate } from "@/features/office/backend/office-release-gate";
import { orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { WithheldReferralService } from "@/features/referrals/referral.service.mock";
import { ReferralReleaseGate } from "@/features/referrals/referral-release-gate";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import { meetingRoomAdvertisedPriceReservationSchema } from "@/features/reservation/meeting-room-reservation";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { ReviewAccounts, ReviewSandbox } from "@/features/review-accounts";
import { OpenSpaceTableMoves } from "@/features/team-table/backend/open-space-table-moves";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import { TestSealedStateKeys } from "@/shared/testing/sealed-state-keys.test-utils";
import {
  syntheticDotyposCustomerId,
  workspaceFixtures,
} from "@/shared/testing/workspace-fixtures.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { atInstant } from "@/shared/testing/workspace-test-clock.test-utils";
import { instantStringSchema } from "@/shared/utils/temporal";
import { prepareAgentPayState } from "./agent-booking";
import { deriveAgentCheckoutIdentifiers } from "./booking-agent";
import type { SelectedReservation } from "./booking-selection";
import { ReservationBooking } from "./reservation-booking.service";
import { ReservationHolds } from "./reservation-holds.service";
import { WorkspaceAvailabilityService } from "./workspace-availability.service";
import { WorkspaceReservationRepository } from "./workspace-reservation.repository";

// The suite books one fixed account, so it owns a database whose reservation
// ledger nothing else fills.
const database = await createWorkspacePostgresSuiteDatabase("agent_booking");
afterAll(() => database?.close());

/** A four-hour meeting room on a date, as a booking selection names it. */
const meetingRoom = (reservationDate: string) =>
  ({
    kind: "meeting-room",
    duration: { unit: "hour", amount: 4 },
    reservationDate,
    startsAt: instantStringSchema.make(`${reservationDate}T08:00:00Z`),
    endsAt: instantStringSchema.make(`${reservationDate}T12:00:00Z`),
  }) as const satisfies SelectedReservation;

/**
 * The advertised price token the agent tool quotes for a meeting room,
 * sealed on the clock the booking runs on.
 */
const advertisedPriceToken = (reservationDate: string, locale: Locale) => {
  const advertised = Schema.decodeUnknownSync(
    meetingRoomAdvertisedPriceReservationSchema
  )({
    kind: "meeting-room",
    details: {
      kind: "meeting-room",
      duration: { unit: "hour", amount: 4 },
      reservationDate,
      lastServiceDate: reservationDate,
    },
  });
  return getMeetingRoomReservationQuote(advertised.details).pipe(
    Effect.flatMap((quote) =>
      buildAdvertisedPriceState({
        kind: "meeting-room",
        locale,
        reservation: advertised,
        quote: {
          ...quote,
          fingerprint: getReservationQuoteFingerprint(
            advertised.details,
            quote
          ),
        },
      })
    ),
    Effect.flatMap(sealAdvertisedPriceState),
    Effect.provide(TestSealedStateKeys)
  );
};

describe.skipIf(!database)("prepareAgentPayState on Postgres", () => {
  if (!database) return;

  // The account the activity guard fixture signs in, linked to its Dotypos
  // customer with a complete profile.
  const accountId = customerAccountIdSchema.make(
    "5b6f31d0-2c1a-4f0e-9a3d-6c7b8e2f1a01"
  );
  const dotyposCustomerId = syntheticDotyposCustomerId("agent-booking");
  beforeAll(() =>
    Effect.runPromise(
      workspaceFixtures(database.db).customerAccount({
        id: accountId,
        linkedCustomer: dotyposCustomerId,
      })
    )
  );

  const contact = {
    name: "Ada Agent",
    email: testEmailAddress("agent-booking"),
    phone: "+420 777 123 456",
  };
  const session = {
    accountId,
    email: reservationCustomerEmailSchema.make(contact.email),
    deletionRequested: false,
    ...testSessionProfile,
  };
  const recordMarketingConsent = mock(
    (_grant: Parameters<IMarketingConsentLedger["record"]>[0]) => Effect.void
  );

  /**
   * Dotypos behind its service mock: each created hold gets a fresh id, and
   * every hold reads as `NEW`, so an unpaid one can be superseded.
   */
  const dotypos = {
    createReservation: mock(() =>
      Effect.sync(() =>
        dotyposHoldFixture(`dotypos-hold-${crypto.randomUUID()}`)
      )
    ),
    cancelReservation: mock((_id: DotyposReservationId) => Effect.void),
    getReservationStatus: mock((_id: DotyposReservationId) =>
      Effect.succeed<DotyposReservationStatus>("NEW")
    ),
  };

  const account = {
    requireActive: Effect.succeed(session),
    peek: Effect.succeed({
      kind: "linked" as const,
      session,
      reviewMarker: "absent" as const,
      account: { accountId, dotyposCustomerId },
      autoLinked: false,
    }),
  };
  const currentAccount = Layer.mock(CurrentCustomerAccount, account);
  const accountContact = {
    current: Effect.succeed(contact),
    linkedContact: () =>
      Effect.succeed({ accountId, dotyposCustomerId, ...contact }),
  };
  const contacts = Layer.mock(CustomerAccountContactService, accountContact);
  const discounts = DiscountServiceMock({
    discoverAdvertisedDiscounts: ({ discountableSubtotal, product }) =>
      Effect.succeed({
        quote: discountAdvertisementQuoteCodec.make({
          product,
          discountableSubtotal,
          discounts: [],
          totalDiscount: { ...discountableSubtotal, value: 0 },
          discountedSubtotal: discountableSubtotal,
        }),
        complete: true,
      }),
    affirmAdvertisement: ({ product, discountableSubtotal }) =>
      Effect.succeed(
        affirmedDiscountAdvertisementQuoteCodec.make({
          product,
          discountableSubtotal,
          discounts: [],
          totalDiscount: { ...discountableSubtotal, value: 0 },
          discountedSubtotal: discountableSubtotal,
        })
      ),
    applyCustomerDiscount: ({ affirmedAdvertisement }) =>
      Effect.succeed({
        ...affirmedAdvertisement,
        advertisedPriceChanged: false,
      }),
  });
  const services = Layer.mergeAll(
    database.layer,
    TeamTableReleaseGate.fromDecision(false),
    Layer.mock(OpenSpaceTableMoves, {}),
    WorkspaceDatabaseAdvisoryLock.makeLayer(database.databasePool),
    makeCustomerAccountSections({ session: {}, activityState: "active" }).layer,
    Layer.mergeAll(
      WorkspaceReservationRepository.Default,
      ReviewAccounts.Default,
      ReviewSandbox.Default
    ).pipe(Layer.provide(database.layer)),
    CheckoutPricingService.Default.pipe(Layer.provide(discounts)),
    Layer.mock(DotyposService, dotypos),
    Layer.mock(WorkspaceAvailabilityService, {
      ensureAvailable: () => Effect.void,
    }),
    Layer.mock(ReservationHoldCleanupScheduleService, {
      enqueueCleanup: () => Effect.void,
    }),
    Layer.mock(MarketingConsentLedger, {
      record: recordMarketingConsent,
    }),
    Layer.mock(AnalyticsConsentLedger, {
      mirror: () => Effect.succeed(true),
    }),
    currentAccount,
    contacts,
    WorkspaceTableAssignmentServiceMock({
      assignTableId: () =>
        Effect.succeed(DotyposTableIdSchema.make("table-id")),
    }),
    EmailRecipientDomainServiceMock({
      check: () => Effect.succeed("accepts_mail" as const),
    }),
    Layer.mock(OfficeReleaseGate, {}),
    WithheldReferralService,
    RememberedReferral.inMemory({}).pipe(
      Layer.provide(
        Layer.mergeAll(
          ReferralReleaseGate.fromDecision(false),
          WithheldReferralService,
          currentAccount
        )
      )
    ),
    recordCheckoutAnalytics().layer,
    TestSealedStateKeys
  );
  const booking = ReservationBooking.Default.pipe(
    Layer.provide(ReservationHolds.Default),
    Layer.provideMerge(services)
  );

  const grantFor = (clientId: CustomerAgentClientId): CustomerAgentGrant => ({
    accountId,
    clientId,
    scopes: new Set(["reservations:create"]),
  });
  const assistant = customerAgentClientIdSchema.make(
    "https://assistant.example/client.json"
  );
  const otherAssistant = customerAgentClientIdSchema.make(
    "https://other-assistant.example/client.json"
  );

  const request = ({
    reservationDate,
    clientId = assistant,
    phone = contact.phone,
    marketingConsent = false,
    locale = "en-US",
  }: {
    readonly reservationDate: string;
    readonly clientId?: CustomerAgentClientId;
    readonly phone?: string;
    readonly marketingConsent?: boolean;
    readonly locale?: Locale;
  }) =>
    advertisedPriceToken(reservationDate, locale).pipe(
      Effect.flatMap((token) =>
        prepareAgentPayState({
          grant: grantFor(clientId),
          reservation: meetingRoom(reservationDate),
          contact: { ...contact, phone },
          advertisedPriceToken: token,
          marketingConsent,
          locale,
        })
      ),
      Effect.provide(booking)
    );

  /** Books a request with the clock at an instant, now by default. */
  const book = (
    input: Parameters<typeof request>[0],
    at = Temporal.Now.instant()
  ) => request(input).pipe(atInstant(at), Effect.runPromise);

  const readyOrderId = (prepared: Awaited<ReturnType<typeof book>>) => {
    if (prepared.status === "error") {
      throw new Error("Expected a held reservation");
    }
    return prepared.orderId;
  };

  const rows = () =>
    database.db
      .select()
      .from(workspaceReservations)
      .where(eq(workspaceReservations.authorAccountId, accountId))
      .orderBy(asc(workspaceReservations.createdAt))
      .pipe(Effect.runPromise);
  const rowOf = async (orderId: string) =>
    (await rows()).find(({ id }) => id === orderId);

  test("holds a first request under the identifiers derived for it", async () => {
    const reservationDate = "2099-06-10";

    const prepared = await book({ reservationDate });

    expect(prepared.status).toBe("ready");
    const row = await rowOf(readyOrderId(prepared));
    const identifiers = deriveAgentCheckoutIdentifiers({
      grant: grantFor(assistant),
      reservation: meetingRoom(reservationDate),
    });
    expect(row).toMatchObject({
      reservationState: "held",
      agentClientId: assistant,
      agentSelectionKey: identifiers.selectionKey,
      dotyposReservationId: expect.any(String),
    });
  });

  test("returns the same hold and Pay link for an identical repeat", async () => {
    const reservationDate = "2099-06-12";
    const creates = dotypos.createReservation.mock.calls.length;
    // The request has no time component: a repeat a few minutes later, on
    // the other side of a 10-minute boundary, is the same request.
    const boundary = Temporal.Instant.fromEpochMilliseconds(
      Math.ceil(Date.now() / 600_000) * 600_000
    );

    const first = await book(
      { reservationDate },
      boundary.subtract({ seconds: 1 })
    );
    const repeat = await book(
      { reservationDate },
      boundary.add({ minutes: 2 })
    );

    expect(repeat).toEqual(first);
    expect(dotypos.createReservation.mock.calls.length).toBe(creates + 1);
    const row = await rowOf(readyOrderId(first));
    expect(row?.reservationState).toBe("held");
  });

  test("replaces the client's previous hold when it books another selection", async () => {
    const previous = await book({ reservationDate: "2099-06-14" });
    const other = await book({
      reservationDate: "2099-06-14",
      clientId: otherAssistant,
    });
    const next = await book({ reservationDate: "2099-06-15" });

    const previousRow = await rowOf(readyOrderId(previous));
    const otherRow = await rowOf(readyOrderId(other));
    const nextRow = await rowOf(readyOrderId(next));
    expect(readyOrderId(next)).not.toBe(readyOrderId(previous));
    expect(nextRow?.reservationState).toBe("held");
    expect(previousRow?.reservationState).toBe("cancelled");
    expect(dotypos.cancelReservation).toHaveBeenCalledWith(
      previousRow?.dotyposReservationId
    );
    // Another assistant's hold for the same account is left alone.
    expect(otherRow?.reservationState).toBe("held");
    expect(dotypos.cancelReservation).not.toHaveBeenCalledWith(
      otherRow?.dotyposReservationId
    );
  });

  test("records a marketing grant on the agent channel only when the customer asked for one", async () => {
    recordMarketingConsent.mockClear();

    await book({ reservationDate: "2099-06-16" });
    expect(recordMarketingConsent).not.toHaveBeenCalled();

    await book({ reservationDate: "2099-06-17", marketingConsent: true });
    expect(recordMarketingConsent.mock.calls).toEqual([
      [
        {
          customerId: dotyposCustomerId,
          locale: "en-US",
          choice: "grant",
          mode: "initial",
          channel: "mcp_tool",
        },
      ],
    ]);
  });

  test("reads the profile phone in the region of the request's locale", async () => {
    // A German mobile number in national format.
    const phone = "0151 23456789";

    const german = await book({
      reservationDate: "2099-06-18",
      phone,
      locale: "de-DE",
    });
    const czech = await request({
      reservationDate: "2099-06-19",
      phone,
      locale: "cs-CZ",
    }).pipe(Effect.result, Effect.runPromise);

    expect(german.status).toBe("ready");
    expect(Result.isFailure(czech)).toBe(true);
    expect(Result.isFailure(czech) && czech.failure._tag).toBe("SchemaError");
  });

  test("the funded tool reuses the persisted claim and Pay link for the same OAuth client", async () => {
    const passId = orderIdSchema.make(crypto.randomUUID());
    await database.pool.query(
      `insert into orders
        (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at, fulfilled_at)
        values ($1, 'pass-purchase', $2, 'paid', 'fulfilled', now(), now())`,
      [passId, dotyposCustomerId]
    );
    await database.pool.query(
      `insert into pass_purchases
        (id, buyer_account_id, holder_account_id, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
        values ($1, $2, $2, 'entry-pack', 'open-space', 5, 'active', '2099-06-01', '2099-07-01', '{}', 'en-US', now())`,
      [passId, accountId]
    );

    const toolServices = Layer.mergeAll(
      booking,
      CoworkPassesReleaseGate.fromDecision(true)
    );
    const input = {
      family: "cowork",
      tier: "open-space",
      date: "2099-06-22",
      pass_id: passId,
    };
    const now = Temporal.Instant.from("2099-06-20T08:00:00Z");
    const start = (clientId: CustomerAgentClientId) =>
      CustomerAccountSections.pipe(
        Effect.flatMap((sections) =>
          startReservationTool
            .call(
              input,
              Option.some({
                grant: {
                  accountId,
                  clientId,
                  scopes: new Set(["reservations:create", "passes:manage"]),
                },
                accessToken: "synthetic-agent-token",
              })
            )
            .pipe(
              Effect.provide(
                inMemoryCustomerAgentCallServices(() => ({
                  currentAccount: account,
                  contact: accountContact,
                  sections,
                }))
              )
            )
        ),
        Effect.provide(toolServices),
        atInstant(now)
      );

    const creates = dotypos.createReservation.mock.calls.length;
    const first = await Effect.runPromise(start(assistant));
    expect(first).toMatchObject({
      order_id: expect.any(String),
      pay_url: expect.any(String),
    });
    const claims = () =>
      database.db
        .select()
        .from(passEntryClaims)
        .where(eq(passEntryClaims.passId, passId))
        .pipe(Effect.runPromise);
    const firstClaims = await claims();
    expect(firstClaims).toEqual([
      expect.objectContaining({ date: input.date, status: "reserved" }),
    ]);
    await expect(Effect.runPromise(start(assistant))).resolves.toEqual(first);

    const other = await start(otherAssistant).pipe(
      Effect.result,
      Effect.runPromise
    );
    expect(other).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "selection_unavailable" } },
    });
    expect(await claims()).toEqual(firstClaims);
    expect(dotypos.createReservation.mock.calls.length).toBe(creates + 1);
  });
});
