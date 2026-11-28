import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { ReservationInvoiceService } from "@/features/accounting/backend/reservation-invoice.service";
import "@/shared/testing/workspace-test-env";
import { describe, expect, test } from "bun:test";
import {
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  DotyposCustomerSchema,
  DotyposReservationIdSchema,
  DotyposReservationSchema,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { ReservationAuthorDirectory } from "@/features/account";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";
import { AdministrationService } from "./administration.service";
import { reservationSummaryRowValues } from "./administration-database.test-utils";
import { PaymentAdministrationServiceMock } from "./payment-administration.service.mock";
import { PostHogReservationHistory } from "./posthog-reservation-history";

type DotyposOverrides = Parameters<typeof DotyposServiceMock>[0];

const instant = Temporal.Instant.from("2026-08-10T08:00:00Z");

const makeRow = (index: number) =>
  workspaceReservationFixture({
    id: workspaceReservationIdSchema.make(`workspace-reservation-${index}`),
    dotyposCustomerId: DotyposCustomerIdSchema.make(
      `dotypos-customer-${index % 3}`
    ),
    dotyposReservationId: DotyposReservationIdSchema.make(
      `dotypos-reservation-${index}`
    ),
    reservationState: "confirmed",
    paymentState: "paid",
    fulfillmentState: "fulfilled",
    reservationPurpose: "business",
    reservationDetails: { kind: "meeting-room" },
    reservationCreatedAt: instant,
    reservationConfirmedAt: instant,
    reservationCancelledAt: null,
    reservationHoldExpiredAt: null,
    paidAt: instant,
    fulfilledAt: instant,
    fulfillmentFailedAt: null,
    failureCode: null,
    createdAt: instant,
    updatedAt: instant,
  });

const makeBooking = (index: number, startDate = "2026-08-20T08:00:00Z") =>
  Schema.decodeSync(DotyposReservationSchema)({
    id: `dotypos-reservation-${index}`,
    _branchId: "test-branch",
    _cloudId: "test-cloud",
    _customerId: `dotypos-customer-${index % 3}`,
    startDate,
    endDate: "2026-08-20T10:00:00Z",
    seats: "1",
    status: "CONFIRMED",
  });

const providerUnavailable = () =>
  Effect.fail(
    new DotyposUnavailable({
      operation: "listReservations",
      reason: "server",
    })
  );

const customerNotFound = () => Effect.succeed(Option.none());

const makeCustomer = (id: DotyposCustomerId, firstName = "Synthetic") =>
  Schema.decodeSync(DotyposCustomerSchema)({
    id,
    _cloudId: "test-cloud",
    points: null,
    flags: "0",
    display: true,
    deleted: false,
    firstName,
    lastName: id,
  });

const customersFor = (ids: Iterable<DotyposCustomerId>) =>
  Effect.succeed(
    new Map(Array.from(ids, (id) => [id, makeCustomer(id)] as const))
  );

const emptyDotypos = makeInMemoryDotypos().service;
const bookingsUnavailable: NonNullable<
  DotyposOverrides["getReservationsByIds"]
> = (ids) =>
  [...ids].length === 0
    ? emptyDotypos.getReservationsByIds(ids)
    : providerUnavailable();

/**
 * Runs one service call over in-memory database reads, answered in call
 * order, and the given Dotypos behaviour.
 */
const runAdministration = async <A, E>(
  {
    dotypos,
    selects,
  }: {
    readonly dotypos: DotyposOverrides;
    readonly selects: readonly (readonly (readonly unknown[])[])[];
  },
  operation: (
    administration: typeof AdministrationService.Service
  ) => Effect.Effect<A, E>
) => {
  const database = await makeRecordingWorkspaceDatabase();
  database.setRows([...selects, []]);
  return Effect.gen(function* () {
    return yield* operation(yield* AdministrationService);
  }).pipe(
    Effect.provide(
      AdministrationService.Default.pipe(
        // Reached only when a restore would reissue an invoice.
        Layer.provide(Layer.mock(ReservationInvoiceService, {})),
        Layer.provide(Layer.mock(WorkspaceReservationRepository, {})),
        Layer.provide(
          Layer.mergeAll(
            database.layer,
            DotyposServiceMock(dotypos),
            Layer.succeed(
              PostHogReservationHistory,
              PostHogReservationHistory.of({
                load: () => Effect.succeed({ kind: "unavailable" } as const),
              })
            ),
            Layer.succeed(
              ReservationAuthorDirectory,
              ReservationAuthorDirectory.of({
                describe: () => Effect.succeed(new Map()),
              })
            ),
            PaymentAdministrationServiceMock({})
          )
        )
      )
    ),
    Effect.runPromise,
    (result) =>
      result.then((value) => ({
        selectCalls: database.statements.length,
        value,
      }))
  );
};

// Rows, then the payment attempts, late payments, and recoveries of the rows.
const exportSelects = (rows: readonly ReturnType<typeof makeRow>[]) => [
  rows.map(reservationSummaryRowValues),
  [],
  [],
  [],
];

describe("AdministrationService.exportReservations", () => {
  test("exports every matching reservation past one page, reading bookings in batches", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => makeRow(index));
    const bookingReads: (readonly string[])[] = [];

    const { value: exported } = await runAdministration(
      {
        dotypos: {
          getCustomersByIds: customersFor,
          listReservations: () =>
            Effect.die("The export must request linked reservations by ID"),
          getReservationsByIds: (ids) => {
            const requested = [...ids];
            const records = requested.map((id) =>
              makeBooking(Number(id.replace("dotypos-reservation-", "")))
            );
            if (requested.length > 0) bookingReads.push(requested);
            return makeInMemoryDotypos({
              reservations: records,
            }).service.getReservationsByIds(requested);
          },
        },
        selects: exportSelects(rows),
      },
      (administration) =>
        administration.exportReservations({
          direction: "desc",
          sort: "created",
        })
    );

    expect(exported.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
    expect(bookingReads.map((ids) => ids.length)).toEqual([60]);
    expect(exported[59]).toMatchObject({
      dotyposReservationId: "dotypos-reservation-59",
      customerId: "dotypos-customer-2",
      customer: { displayName: "Synthetic dotypos-customer-2" },
      startsAt: "2026-08-20T08:00:00Z",
    });
  });

  test("orders a date sort by the Dotypos booking order", async () => {
    const rows = [makeRow(1), makeRow(2), makeRow(3)];

    const { value: exported } = await runAdministration(
      {
        dotypos: {
          getCustomersByIds: customersFor,
          listReservations: () =>
            Effect.succeed([
              makeBooking(3, "2026-08-02T08:00:00Z"),
              makeBooking(1, "2026-08-03T08:00:00Z"),
              makeBooking(2, "2026-08-04T08:00:00Z"),
            ]),
          getReservationsByIds: makeInMemoryDotypos({
            reservations: [
              makeBooking(3, "2026-08-02T08:00:00Z"),
              makeBooking(1, "2026-08-03T08:00:00Z"),
              makeBooking(2, "2026-08-04T08:00:00Z"),
            ],
          }).service.getReservationsByIds,
        },
        selects: [
          rows.map(({ id, dotyposReservationId }) => [
            id,
            dotyposReservationId,
          ]),
          ...exportSelects(rows),
        ],
      },
      (administration) =>
        administration.exportReservations({
          direction: "desc",
          from: "2026-08-01",
          sort: "date",
        })
    );

    expect(exported.map(({ id }) => id)).toEqual([
      workspaceReservationIdSchema.make("workspace-reservation-2"),
      workspaceReservationIdSchema.make("workspace-reservation-1"),
      workspaceReservationIdSchema.make("workspace-reservation-3"),
    ]);
  });

  test("keeps a reservation whose booking or customer Dotypos doesn't have", async () => {
    const { value: exported } = await runAdministration(
      {
        dotypos: {
          getCustomer: customerNotFound,
          getCustomersByIds: emptyDotypos.getCustomersByIds,
          listReservations: () => Effect.succeed([]),
          getReservationsByIds: makeInMemoryDotypos({ reservations: [] })
            .service.getReservationsByIds,
        },
        selects: exportSelects([makeRow(1)]),
      },
      (administration) => administration.exportReservations({})
    );

    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ customer: null, startsAt: null });
  });

  describe("fails instead of degrading when Dotypos is unavailable", () => {
    const cases = [
      {
        name: "the date range",
        input: { from: "2026-08-01" },
        dotypos: {
          listReservations: providerUnavailable,
          getReservationsByIds: bookingsUnavailable,
        },
        source: "booking-dates",
      },
      {
        name: "the date order",
        input: { sort: "date" },
        dotypos: {
          listReservations: providerUnavailable,
          getReservationsByIds: bookingsUnavailable,
        },
        source: "booking-dates",
      },
      {
        name: "booking details",
        input: {},
        dotypos: {
          getCustomersByIds: customersFor,
          listReservations: providerUnavailable,
          getReservationsByIds: bookingsUnavailable,
        },
        source: "booking-details",
      },
      {
        name: "customer details",
        input: {},
        dotypos: {
          getCustomer: () => Effect.die("no single-record fallback"),
          getCustomersByIds: providerUnavailable,
          listReservations: () => Effect.succeed([makeBooking(1)]),
          getReservationsByIds: makeInMemoryDotypos({
            reservations: [makeBooking(1)],
          }).service.getReservationsByIds,
        },
        source: "customer-details",
      },
    ] as const;

    for (const { dotypos, input, name, source } of cases) {
      test(name, async () => {
        const { value: failure } = await runAdministration(
          {
            dotypos,
            selects: exportSelects([makeRow(1)]),
          },
          (administration) =>
            administration.exportReservations(input).pipe(Effect.flip)
        );

        expect(failure).toMatchObject({
          _tag: "AdministrationListSourceUnavailableError",
          source,
        });
      });
    }
  });
});

describe("AdministrationService.exportCustomers", () => {
  const customerRow = (id: string) =>
    [id, "active", 2, instant.toString()] as const;

  const exportTwo = (
    dotypos: Pick<DotyposOverrides, "getCustomer" | "getCustomersByIds">
  ) =>
    runAdministration(
      {
        dotypos: {
          listReservations: () => Effect.die("no date range"),
          getReservationsByIds: (ids) =>
            [...ids].length === 0
              ? emptyDotypos.getReservationsByIds(ids)
              : Effect.die("no date range"),
          ...dotypos,
        },
        selects: [
          [
            customerRow("dotypos-customer-1"),
            customerRow("dotypos-customer-2"),
          ],
        ],
      },
      (administration) =>
        administration
          .exportCustomers({ marketingConsent: "active" })
          .pipe(Effect.result)
    ).then(({ value }) => value);

  // The batch answers for the first customer only.
  const firstCustomerOnly: DotyposOverrides["getCustomersByIds"] = (ids) =>
    customersFor([...ids].filter((id) => id === "dotypos-customer-1"));

  test("reads a customer the batch left out on its own", async () => {
    const result = await exportTwo({
      getCustomer: (id) =>
        Effect.succeed(Option.some(makeCustomer(id, "Single"))),
      getCustomersByIds: firstCustomerOnly,
    });

    expect(
      Result.getOrThrow(result).map(({ customer, customerId }) => [
        customerId,
        customer?.displayName,
      ])
    ).toEqual([
      ["dotypos-customer-1", "Synthetic dotypos-customer-1"],
      ["dotypos-customer-2", "Single dotypos-customer-2"],
    ]);
  });

  test("keeps a customer Dotypos doesn't have, without details", async () => {
    const result = await exportTwo({
      getCustomer: customerNotFound,
      getCustomersByIds: firstCustomerOnly,
    });

    expect(
      Result.getOrThrow(result).map(({ customer }) => customer?.id ?? null)
    ).toEqual([DotyposCustomerIdSchema.make("dotypos-customer-1"), null]);
  });

  for (const { name, dotypos } of [
    {
      name: "the customer batch fails",
      dotypos: {
        getCustomer: () => Effect.die("no single-record fallback"),
        getCustomersByIds: providerUnavailable,
      },
    },
    {
      name: "the single read of a left-out customer fails",
      dotypos: {
        getCustomer: providerUnavailable,
        getCustomersByIds: firstCustomerOnly,
      },
    },
  ] as const) {
    test(`fails when ${name}`, async () => {
      const result = await exportTwo(dotypos);

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "AdministrationListSourceUnavailableError",
        source: "customer-details",
      });
    });
  }
});

describe("AdministrationService.listReservations under the same Dotypos failures", () => {
  test("still shows the date filter as unavailable", async () => {
    const { value: page } = await runAdministration(
      {
        dotypos: {
          listReservations: providerUnavailable,
          getReservationsByIds: bookingsUnavailable,
        },
        selects: [[[0]], []],
      },
      (administration) =>
        administration.listReservations({ from: "2026-08-01" })
    );

    expect(page).toMatchObject({ dateFilterUnavailable: true, total: 0 });
  });

  test("still shows rows without booking details", async () => {
    const { value: page } = await runAdministration(
      {
        dotypos: {
          getCustomersByIds: customersFor,
          listReservations: providerUnavailable,
          getReservationsByIds: bookingsUnavailable,
        },
        selects: [[[1]], ...exportSelects([makeRow(1)])],
      },
      (administration) => administration.listReservations({})
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      liveDetailsAvailable: false,
      customer: { displayName: "Synthetic dotypos-customer-1" },
    });
  });

  test("still reads customers one by one when a batch fails", async () => {
    const singleReads: string[] = [];
    const { value: page } = await runAdministration(
      {
        dotypos: {
          getCustomer: (id) =>
            Effect.sync(() => {
              singleReads.push(id);
              return Option.some(makeCustomer(id, "Single"));
            }),
          getCustomersByIds: providerUnavailable,
          listReservations: () => Effect.succeed([makeBooking(1)]),
          getReservationsByIds: makeInMemoryDotypos({
            reservations: [makeBooking(1)],
          }).service.getReservationsByIds,
        },
        selects: [[[1]], ...exportSelects([makeRow(1)])],
      },
      (administration) => administration.listReservations({})
    );

    expect(singleReads).toEqual(["dotypos-customer-1"]);
    expect(page.items[0]?.customer).toMatchObject({
      displayName: "Single dotypos-customer-1",
    });
  });

  test("still shows a row without customer details when the single read fails too", async () => {
    const { value: page } = await runAdministration(
      {
        dotypos: {
          getCustomer: providerUnavailable,
          getCustomersByIds: emptyDotypos.getCustomersByIds,
          listReservations: () => Effect.succeed([makeBooking(1)]),
          getReservationsByIds: makeInMemoryDotypos({
            reservations: [makeBooking(1)],
          }).service.getReservationsByIds,
        },
        selects: [[[1]], ...exportSelects([makeRow(1)])],
      },
      (administration) => administration.listReservations({})
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.customer).toBeNull();
  });
});
