import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { CustomerTeamTableQuote } from "@deskohub/workspace-customer-api";
import { Effect, Layer, Schema } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import {
  peeking,
  testPeekedStandings,
} from "@/features/account/backend/current-customer-account.test-utils";
import { CustomerReservationHistoryWithAccessService } from "@/features/account/backend/customer-reservation-history-with-access.service";
import { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import {
  CheckoutStatusService,
  type CheckoutStatusViewModel,
} from "@/features/checkout/backend/checkout/checkout-status.service";
import { PayableCheckout } from "@/features/checkout/backend/checkout/payable-checkout.service";
import { ReservationQuoteError } from "@/features/checkout/reservation-quote-error";
import { discountAdvertisementQuoteCodec } from "@/features/discounts/contracts";
import { DiscountServiceMock } from "@/features/discounts/discount.service.mock";
import { releaseGateForRunOverFlags } from "@/features/feature-flags/backend/release-cohorts.test-utils";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { ReservationAccessService } from "@/features/reservation/backend/reservation-access.service";
import { ReservationAuthorizationService } from "@/features/reservation/backend/reservation-authorization.service";
import {
  WorkspaceAvailabilityService,
  WorkspaceTableUnavailableError,
} from "@/features/reservation/backend/workspace-availability.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceReservationService } from "@/features/reservation/backend/workspace-reservation.service";
import {
  workspaceReservationDetailsFixture,
  workspaceReservationFixture,
} from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { getTableReservationInterval } from "@/features/reservation/table-reservation-time";
import {
  getWorkspaceAvailabilityRange,
  tableSlotsAvailabilitySchema,
} from "@/features/reservation/workspace-availability";
import { ReservationInviteeEmailKeys } from "@/features/reservation-invitees/backend/reservation-invitee-email-keys.service";
import { ReservationInviteeNoticeWorker } from "@/features/reservation-invitees/backend/reservation-invitee-notice-worker";
import { ReservationInvitees } from "@/features/reservation-invitees/backend/reservation-invitees.service";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import { WithdrawalRepository } from "@/features/withdrawal/backend/withdrawal.repository";
import { moneyWithValue } from "@/shared/money/money";
import { TestSealedStateKeys } from "@/shared/testing/sealed-state-keys.test-utils";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";
import {
  answerInEachReleaseCohort,
  type CustomerApiCall,
  customerApiRequest,
  expectEachCohortAnsweredAlone,
  inReleaseCohort,
  makeCustomerApiTestServer,
  readInEachReleaseCohort,
  testCustomerEndpointGuards,
} from "./customer-api.test-utils";
import { CustomerCheckoutOperations } from "./customer-checkout-operations.service";

const date = getCurrentWorkspaceDate().add({ days: 1 }).toString();
const selection = {
  family: "table",
  date,
  seats: 4,
  startTime: "09:00",
  endTime: "10:15",
} as const;
const orderId = workspaceReservationIdSchema.make(
  "019edbcf-5026-7ecc-821b-eda46998eaaa"
);
const tableProduct = { kind: "table", seats: 4, durationMinutes: 75 } as const;

const listOfferings = {
  method: "GET",
  path: "/booking/team-table/offerings?locale=en-US",
} as const satisfies CustomerApiCall;

const bookingCalls = [
  {
    method: "GET",
    path: "/booking/team-table/availability?seats=4",
  },
  {
    method: "GET",
    path: `/booking/team-table/slots?date=${date}&seats=4`,
  },
  {
    method: "GET",
    path: `/booking/team-table/quote?date=${date}&seats=4&startTime=09%3A00&endTime=10%3A15&locale=en-US`,
  },
  {
    method: "POST",
    path: "/booking/team-table/checkouts",
    body: {
      locale: "en-US",
      checkoutSessionId: "session",
      checkoutAttemptId: "attempt",
      advertisedPriceToken: "test-quote",
      selection,
      bookingFor: "someone-else",
      contact: {
        name: "Ada Lovelace",
        email: testEmailAddress("ada"),
        phone: "+420777000111",
      },
      billing: { purpose: "personal", invoice: "none" },
    },
  },
] as const satisfies ReadonlyArray<CustomerApiCall>;

const inventory = Layer.succeed(AdvisoryAvailabilityInventory, {
  tables: Effect.succeed(
    [
      { id: "table-6", seats: "6", enabled: true },
      { id: "table-4", seats: "4", enabled: true },
      { id: "table-4-again", seats: "4", enabled: true },
      { id: "closed-table", seats: "8", enabled: false },
    ].map((table) => ({
      _cloudId: "cloud",
      name: table.id,
      display: true,
      tags: ["reservation:table", "cowork:open-space"],
      ...table,
    }))
  ),
  listActiveReservationsOverlapping: () => Effect.succeed([]),
  listLimitations: () => Effect.succeed([]),
});

const pricing = CheckoutPricingService.Default.pipe(
  Layer.provide(
    DiscountServiceMock({
      discoverAdvertisedDiscounts: ({ product, discountableSubtotal }) =>
        Effect.succeed({
          complete: true,
          quote: discountAdvertisementQuoteCodec.make({
            product,
            discountableSubtotal,
            discounts: [],
            totalDiscount: moneyWithValue(0, discountableSubtotal),
            discountedSubtotal: discountableSubtotal,
          }),
        }),
    })
  )
);

const availabilityWith = (
  methods: Partial<WorkspaceAvailabilityService["Service"]>
) =>
  Layer.mergeAll(
    TestSealedStateKeys,
    Layer.mock(PayableCheckout, {}),
    Layer.mock(WorkspaceAvailabilityService, methods)
  );

const openCatalog = {
  teamTableRelease: TeamTableReleaseGate.fromDecision(true),
  inventory,
  pricing,
  availability: availabilityWith({ ensureAvailable: () => Effect.void }),
};

describe("Team Table booking", () => {
  testCustomerEndpointGuards(listOfferings);
  for (const call of bookingCalls) {
    testCustomerEndpointGuards(call);
  }

  test("hides discovery and rejects direct booking while the release is closed", async () => {
    const api = makeCustomerApiTestServer({
      bookingCatalog: {
        inventory: Layer.effect(
          AdvisoryAvailabilityInventory,
          Effect.die(new Error("Disabled Team Table must not load inventory"))
        ),
      },
    });
    const offerings = await api.handle(customerApiRequest(listOfferings));
    expect(offerings.status).toBe(200);
    expect(await offerings.json()).toMatchObject({ offerings: [] });

    for (const call of bookingCalls) {
      const response = await api.handle(customerApiRequest(call));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        _tag: "CustomerTeamTableUnavailable",
      });
    }
  });

  test("lists exact configured sizes only for requests in the open cohort", async () => {
    const answers = await answerInEachReleaseCohort({
      serve: (flags) =>
        makeCustomerApiTestServer({
          bookingCatalog: {
            ...openCatalog,
            teamTableRelease: releaseGateForRunOverFlags(
              TeamTableReleaseGate,
              flags
            ),
          },
        }),
      send: (cohort) =>
        customerApiRequest(inReleaseCohort(listOfferings, cohort)),
    });
    expectEachCohortAnsweredAlone(answers);
    expect(answers.alone.closed).toMatchObject({
      status: 200,
      body: { offerings: [] },
    });
    expect(answers.alone.open).toMatchObject({
      status: 200,
      body: {
        offerings: [
          {
            product: { kind: "table", seats: 4, durationMinutes: 60 },
            price: { value: 32_000, currency: "CZK", exponent: 2 },
          },
          {
            product: { kind: "table", seats: 6, durationMinutes: 60 },
            price: { value: 48_000, currency: "CZK", exponent: 2 },
          },
        ],
      },
    });
  });

  test("shares one release decision across selection and checkout for each request", async () => {
    const answers = await answerInEachReleaseCohort({
      serve: (flags) =>
        makeCustomerApiTestServer({
          bookingCatalog: {
            ...openCatalog,
            teamTableRelease: releaseGateForRunOverFlags(
              TeamTableReleaseGate,
              flags
            ),
          },
          bookingCheckout: {
            inventory,
            operations: Layer.mock(CustomerCheckoutOperations, {
              preparePayState: () =>
                Effect.fail(
                  new WorkspaceTableUnavailableError({
                    date,
                    reservation: { kind: "table" },
                  })
                ),
            }),
          },
        }),
      send: (cohort) =>
        customerApiRequest(inReleaseCohort(bookingCalls[3], cohort)),
    });
    expectEachCohortAnsweredAlone(answers);
    expect(answers.alone.open.status).toBe(409);
    expect(answers.alone.closed.status).toBe(404);
  });

  test("uses the fixed 503 response for an untagged checkout service error", async () => {
    const api = makeCustomerApiTestServer({
      bookingCatalog: openCatalog,
      bookingCheckout: {
        inventory,
        operations: Layer.mock(CustomerCheckoutOperations, {
          preparePayState: () =>
            Effect.fail(new ReservationQuoteError({ message: "quote failed" })),
        }),
      },
    });
    const response = await api.handle(customerApiRequest(bookingCalls[3]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      _tag: "CustomerServiceUnavailable",
    });
  });

  test("reads the six-month calendar and exact date's available start/end matrix", async () => {
    const range = getWorkspaceAvailabilityRange(
      getCurrentWorkspaceDate().toString()
    );
    const calendar = { ...range, seats: 4, unavailableDates: [date] };
    const slots = {
      date,
      seats: 4,
      slotMinutes: 15,
      usableFrom: "00:00",
      usableUntil: null,
      availableStarts: ["09:00"],
      availableEndsByStart: [
        { startTime: "09:00", endTimes: ["09:15", "10:15"] },
      ],
    };
    const availability = availabilityWith({
      ensureAvailable: () => Effect.void,
      getAvailability: ({ query }) =>
        Effect.sync(() => {
          expect(query).toEqual({ ...range, kind: "table", seats: 4 });
          return {
            ...calendar,
            reservedDeskWorkstationRequiredDates: [],
            unavailableCoworkTiers: [],
            meetingRoomUnavailable: false,
            officeUnavailable: false,
            unavailableMonitorOptions: [],
            notices: [],
          };
        }),
      getTableSlots: ({ query }) =>
        Effect.sync(() => {
          expect(query).toEqual({
            kind: "table",
            mode: "table-slots",
            date,
            seats: 4,
          });
          return Schema.decodeUnknownSync(tableSlotsAvailabilitySchema)(slots);
        }),
    });
    const serve = (flags: Parameters<typeof releaseGateForRunOverFlags>[1]) =>
      makeCustomerApiTestServer({
        bookingCatalog: {
          ...openCatalog,
          availability,
          teamTableRelease: releaseGateForRunOverFlags(
            TeamTableReleaseGate,
            flags
          ),
        },
      });
    for (const [call, expected] of [
      [bookingCalls[0], calendar],
      [bookingCalls[1], slots],
    ] as const) {
      const answers = await answerInEachReleaseCohort({
        serve,
        send: (cohort) => customerApiRequest(inReleaseCohort(call, cohort)),
      });
      expectEachCohortAnsweredAlone(answers);
      expect(answers.alone.open).toEqual({ status: 200, body: expected });
      expect(answers.alone.closed.status).toBe(404);
    }
    const quoteAnswers = await readInEachReleaseCohort({
      serve,
      send: (cohort) =>
        customerApiRequest(inReleaseCohort(bookingCalls[2], cohort)),
      answer: async (response) => response.status,
    });
    expectEachCohortAnsweredAlone(quoteAnswers);
    expect(quoteAnswers.alone).toEqual({ open: 200, closed: 404 });
  });

  test("refuses to sign a quote when live capacity cannot accommodate the exact interval", async () => {
    const checkedIntervals: unknown[] = [];
    const api = makeCustomerApiTestServer({
      bookingCatalog: {
        ...openCatalog,
        pricing: Layer.mock(CheckoutPricingService, {
          quoteAdvertisement: () =>
            Effect.die("must verify capacity before pricing"),
        }),
        availability: availabilityWith({
          ensureAvailable: (reservation) =>
            Effect.sync(() => checkedIntervals.push(reservation)).pipe(
              Effect.andThen(
                Effect.fail(
                  new WorkspaceTableUnavailableError({
                    date,
                    reservation: { kind: "table" },
                  })
                )
              )
            ),
        }),
      },
    });

    const response = await api.handle(customerApiRequest(bookingCalls[2]));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      _tag: "CustomerSelectionUnavailable",
      reason: "availability_changed",
    });
    expect(checkedIntervals).toEqual([
      {
        kind: "table",
        seats: selection.seats,
        ...getTableReservationInterval(
          date,
          selection.startTime,
          selection.endTime
        ),
      },
    ]);
  });

  test("quotes separate base and usage fees and passes the exact selection and people to checkout", async () => {
    const interval = getTableReservationInterval(date, "09:00", "10:15");
    const invitees = [testEmailAddress("guest")];
    let submitted: unknown;
    const api = makeCustomerApiTestServer({
      bookingCatalog: openCatalog,
      bookingCheckout: {
        inventory,
        operations: Layer.mock(CustomerCheckoutOperations, {
          preparePayState: (input) =>
            Effect.sync(() => {
              submitted = input;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new WorkspaceTableUnavailableError({
                    date,
                    reservation: { kind: "table" },
                  })
                )
              )
            ),
        }),
      },
    });
    const quoteResponse = await api.handle(customerApiRequest(bookingCalls[2]));
    expect(quoteResponse.status).toBe(200);
    const { advertisedPriceToken, ...quote } = Schema.decodeUnknownSync(
      CustomerTeamTableQuote
    )(await quoteResponse.json());
    expect(advertisedPriceToken.length).toBeGreaterThan(0);
    expect(quote).toMatchObject({
      product: tableProduct,
      total: { value: 34_000 },
      summary: {
        sections: expect.arrayContaining([
          expect.objectContaining({
            key: "order",
            items: expect.arrayContaining([
              expect.objectContaining({
                seats: 4,
                baseAmount: { value: 24_000, currency: "CZK", exponent: 2 },
                usageAmount: { value: 10_000, currency: "CZK", exponent: 2 },
              }),
            ]),
          }),
        ]),
      },
    });
    const create = bookingCalls[3];
    const body = {
      ...create.body,
      advertisedPriceToken,
      people: { contactAttends: true, invitees },
    };
    const checkout = await api.handle(customerApiRequest({ ...create, body }));
    expect(submitted).toMatchObject({
      reservation: { kind: "table", seats: 4, ...interval },
      people: { contactAttends: true, invitees },
      advertisedPriceToken,
    });
    expect({ status: checkout.status, body: await checkout.json() }).toEqual({
      status: 409,
      body: {
        _tag: "CustomerSelectionUnavailable",
        reason: "availability_changed",
      },
    });
  });
});

const getStatus = {
  method: "GET",
  path: `/reservations/${orderId}/team-table/status`,
} as const satisfies CustomerApiCall;
const addInvitees = {
  method: "POST",
  path: `/reservations/${orderId}/invitations`,
  body: { locale: "en-US", emails: [testEmailAddress("guest")] },
} as const satisfies CustomerApiCall;

describe("Team Table reservation management", () => {
  testCustomerEndpointGuards(getStatus);
  testCustomerEndpointGuards(addInvitees);

  test("keeps authorized status and legacy-decodable history visible while the gate is closed", async () => {
    const startsAt = "2026-12-01T08:00:00Z";
    const endsAt = "2026-12-01T09:15:00Z";
    const state = {
      orderId,
      kind: "table",
      returnOutcome: "unknown",
      status: "fulfilled",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      summary: {
        ...tableProduct,
        reservedFrom: Temporal.Instant.from(startsAt),
        reservedUntil: Temporal.Instant.from(endsAt),
        price: { value: 34_000, currency: "CZK", exponent: 2 },
      },
      table: { mode: "assigned", name: "Table 4" },
      people: { contactAttends: true, invitees: [], resendable: true },
    } satisfies CheckoutStatusViewModel;
    const api = makeCustomerApiTestServer({
      reservations: {
        currentAccount: peeking(testPeekedStandings.linked),
        authorization: Layer.mock(ReservationAuthorizationService, {
          isAuthorized: ({ permission }) =>
            Effect.succeed(permission === "view-status"),
        }),
        checkoutStatus: Layer.mock(CheckoutStatusService, {
          refreshStatus: () => Effect.succeed(state),
        }),
        access: () =>
          Layer.mock(ReservationAccessService, {
            getAccess: () =>
              Effect.succeed({
                state: "available",
                viewer: "invitee",
                code: "0000",
                accessStartsAt: Temporal.Instant.from(startsAt),
                accessEndsAt: Temporal.Instant.from(endsAt),
                teamTable: { name: "Table 4" },
              }),
          }),
        history: () =>
          Layer.mock(CustomerReservationHistoryWithAccessService, {
            load: () =>
              Effect.succeed({
                kind: "available",
                groups: {
                  current: [
                    {
                      id: orderId,
                      workspaceReservationId: orderId,
                      product: { kind: "table" },
                      productName: "Team Table",
                      startsAt,
                      endsAt,
                      seats: 4,
                      status: "confirmed",
                    },
                  ],
                  past: [],
                  unavailable: [
                    {
                      id: "provider-only",
                      product: { kind: "table" },
                      startsAt,
                      endsAt: "2026-12-01T09:14:00Z",
                      seats: 4,
                      status: "requires-attention",
                    },
                  ],
                },
              }),
          }),
      },
    });
    const status = await api.handle(customerApiRequest(getStatus));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      orderId,
      kind: "table",
      product: tableProduct,
      tableName: "Table 4",
      people: { contactAttends: true, invitees: [], resendable: true },
    });
    const legacyStatus = await api.handle(
      customerApiRequest({
        method: "GET",
        path: `/reservations/${orderId}/status`,
      })
    );
    expect(legacyStatus.status).toBe(404);
    expect(await legacyStatus.json()).toEqual({
      _tag: "CustomerReservationNotFound",
    });

    const history = await api.handle(
      customerApiRequest({ method: "GET", path: "/reservations" })
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      current: [
        {
          orderId,
          product: { kind: "other", family: "table", teamTable: tableProduct },
          productName: "Team Table",
        },
      ],
      unavailable: [
        { id: "provider-only", product: { kind: "other", family: "table" } },
      ],
    });
    const access = await api.handle(
      customerApiRequest({
        method: "GET",
        path: `/reservations/${orderId}/access`,
      })
    );
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({ tableName: "Table 4" });
  });

  test("adds an authorized invitee while the release gate is closed", async () => {
    const database = await makeRecordingWorkspaceDatabase();
    database.setRows([[["guest-row"]], [["notice-row"]]]);
    const stored = workspaceReservationFixture({
      id: orderId,
      reservationDetails: tableProduct,
      officeContactAttends: true,
    });
    const api = makeCustomerApiTestServer({
      reservations: {
        authorization: Layer.mock(ReservationAuthorizationService, {
          authorize: (request) =>
            Effect.succeed(
              request.orderId === orderId &&
                request.permission === "add-invitees"
            ),
        }),
        invitationAdd: Layer.mergeAll(
          database.layer,
          makeRecordingAdvisoryLock().layer,
          ReservationInviteeEmailKeys.Live.pipe(
            Layer.provide(TestSealedStateKeys)
          ),
          Layer.mock(WorkspaceReservationRepository, {
            findById: () => Effect.succeed(stored),
          }),
          Layer.mock(WorkspaceReservationService, {
            getReservation: () =>
              Effect.succeed(
                workspaceReservationDetailsFixture({
                  id: orderId,
                  reservationDetails: tableProduct,
                  seats: 4,
                })
              ),
          }),
          Layer.mock(WithdrawalRepository, {
            findByContract: () => Effect.succeedNone,
          }),
          Layer.mock(ReservationInvitees, {
            listForReservation: () => Effect.succeed([]),
          }),
          Layer.mock(ReservationInviteeNoticeWorker, {
            dispatchAddedInvitations: () => Effect.void,
          })
        ),
      },
    });

    const response = await api.handle(customerApiRequest(addInvitees));
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { added: 1 },
    });
  });

  test("hides status and rejects adding invitees when the account lacks order permissions", async () => {
    const permissions: string[] = [];
    const api = makeCustomerApiTestServer({
      reservations: {
        authorization: Layer.mock(ReservationAuthorizationService, {
          isAuthorized: ({ permission }) =>
            Effect.sync(() => {
              permissions.push(permission);
              return false;
            }),
          authorize: ({ permission }) =>
            Effect.sync(() => {
              permissions.push(permission);
              return false;
            }),
        }),
      },
    });
    for (const call of [getStatus, addInvitees]) {
      const response = await api.handle(customerApiRequest(call));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        _tag: "CustomerReservationNotFound",
      });
    }
    expect(permissions).toEqual(["view-status", "add-invitees"]);
  });
});
