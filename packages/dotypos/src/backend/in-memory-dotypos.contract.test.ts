import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Logger, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  DotyposRuntimeConfigSchema,
  makeDotyposRuntimeConfigLayer,
} from "../config";
import type { DotyposFailure } from "../errors";
import type { Customer, Reservation } from "../generated/effect.gen";
import {
  DotyposCustomerIdSchema,
  DotyposCustomerSchema,
  DotyposReservationIdSchema,
  DotyposReservationSchema,
  DotyposTableIdSchema,
} from "../types";
import { DotyposAccessToken, DotyposGeneratedClient } from "./api";
import { makeInMemoryDotypos } from "./in-memory-dotypos";
import { DotyposService } from "./service";

/**
 * Runs each case against Live over a fetch mock that answers with the
 * fixture records below in the documented response shapes, and against the
 * in-memory fake seeded with the same records, and expects one outcome.
 * Agreement here shows only that both adapters read these fixture
 * responses alike; it says nothing about how live Dotypos behaves.
 */

const config = Schema.decodeUnknownSync(DotyposRuntimeConfigSchema)({
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  cloudId: "cloud-id",
  branchId: "branch-id",
  employeeId: "employee-id",
  apiUrl: "https://dotypos.example.test",
  apiTimeout: 1000,
  reservationTableIds: ["table-id"],
});

const customerId = Schema.decodeUnknownSync(DotyposCustomerIdSchema);
const reservationId = Schema.decodeUnknownSync(DotyposReservationIdSchema);
const tableId = Schema.decodeUnknownSync(DotyposTableIdSchema);

const customerFixture = (overrides: Partial<Customer>): Customer => ({
  id: "customer-id",
  _cloudId: "cloud-id",
  firstName: "Ada",
  points: null,
  flags: "0",
  display: true,
  deleted: false,
  ...overrides,
});

const reservationFixture = (overrides: Partial<Reservation>): Reservation => ({
  id: "reservation-id",
  _branchId: "branch-id",
  _cloudId: "cloud-id",
  _customerId: "customer-id",
  _tableId: "table-id",
  startDate: "2026-06-20T10:00:00.000Z",
  endDate: "2026-06-20T12:00:00.000Z",
  seats: "2",
  status: "NEW",
  ...overrides,
});

/** The booking every reservation fixture holds. */
const fixtureBooking = {
  customerId: customerId("customer-id"),
  tableId: tableId("table-id"),
  startDate: new Date("2026-06-20T10:00:00.000Z"),
  endDate: new Date("2026-06-20T12:00:00.000Z"),
  seats: 2,
};
const reservationMarker = "Unlimited booking marker";

const fixtures = () => ({
  customers: [
    customerFixture({ id: "customer-id" }),
    customerFixture({ id: "deleted-customer", deleted: true }),
  ],
  reservations: [
    reservationFixture({ id: "new" }),
    reservationFixture({
      id: "confirmed",
      status: "CONFIRMED",
      note: reservationMarker,
    }),
    reservationFixture({ id: "cancelled", status: "CANCELLED" }),
    reservationFixture({ id: "orphan", _customerId: "gone" }),
  ],
});

/** A fetch mock serving the fixture records the way the OpenAPI contract documents. */
const fixtureFetch = (): typeof globalThis.fetch => {
  const { customers, reservations } = fixtures();
  const versions = new Map<string, number>();
  const notFound = () => new Response(null, { status: 404 });
  const answer = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/signin/token") {
      return Response.json({ accessToken: "access-token" });
    }
    const [, , , collection, id] = url.pathname.split("/");
    if (collection === "customers" && id === undefined) {
      const ids = /^id\|in\|([^;]*)/.exec(url.searchParams.get("filter") ?? "");
      const selected = customers.filter((record) =>
        ids?.[1]?.split(",").includes(record.id)
      );
      return selected.length === 0
        ? notFound()
        : Response.json({ data: selected, currentPage: "1", lastPage: "1" });
    }
    const records = collection === "customers" ? customers : reservations;
    const index = records.findIndex((record) => record.id === id);
    const record = records[index];
    if (id === undefined || record === undefined) return notFound();
    const version = versions.get(id) ?? 0;
    const etag = `"v${version}"`;
    if (request.method === "PATCH") {
      if (request.headers.get("If-Match") !== etag) {
        return new Response(null, { status: 412 });
      }
      const patched = { ...record, ...(await request.json()) };
      records[index] = patched;
      versions.set(id, version + 1);
      return Response.json(patched, { headers: { ETag: `"v${version + 1}"` } });
    }
    return Response.json(record, { headers: { ETag: etag } });
  };
  return Object.assign(answer, { preconnect: globalThis.fetch.preconnect });
};

const liveLayer = () =>
  DotyposService.Default.pipe(
    Layer.provide(DotyposGeneratedClient.Default),
    Layer.provide(DotyposAccessToken.Default),
    Layer.provide(
      Layer.merge(
        makeDotyposRuntimeConfigLayer(config),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fixtureFetch()))
        )
      )
    )
  );

const inMemoryLayer = () => {
  const { customers, reservations } = fixtures();
  return makeInMemoryDotypos({
    customers: customers.map((record) =>
      Schema.decodeUnknownSync(DotyposCustomerSchema)(record)
    ),
    reservations: reservations.map((record) =>
      Schema.decodeUnknownSync(DotyposReservationSchema)(record)
    ),
  }).layer;
};

/** The outcome a caller can branch on: the value, or the failure's tag, reason and request. */
const outcome = <A>(exit: Exit.Exit<A, DotyposFailure>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => {
      const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
      return failure
        ? {
            failure: {
              _tag: failure._tag,
              reason: "reason" in failure ? failure.reason : undefined,
              operation: "operation" in failure ? failure.operation : undefined,
              request: "request" in failure ? failure.request : undefined,
              reservationId:
                "reservationId" in failure ? failure.reservationId : undefined,
            },
          }
        : { defect: String(cause) };
    },
  });

const agree = async <A, E extends DotyposFailure>(
  scenario: Effect.Effect<A, E, DotyposService>,
  normalize: (value: A) => unknown = (value) => value
) => {
  const runOn = (layer: Layer.Layer<DotyposService>) =>
    Effect.runPromise(
      Effect.exit(
        scenario.pipe(
          Effect.map(normalize),
          Effect.provide(Layer.merge(layer, Logger.layer([])))
        )
      )
    ).then(outcome);
  const [live, inMemory] = await Promise.all([
    runOn(liveLayer()),
    runOn(inMemoryLayer()),
  ]);
  expect(inMemory).toEqual(live);
  return live;
};

const withService = <A, E>(
  use: (service: DotyposService["Service"]) => Effect.Effect<A, E>
) => Effect.flatMap(DotyposService, use);

describe("in-memory Dotypos agrees with Live on recorded response shapes", () => {
  test("reads a reservation with its customer", async () => {
    const result = await agree(
      withService((service) => service.getReservation(reservationId("new")))
    );
    expect(result).toHaveProperty("value._tag", "Some");
  });

  test("reads a missing reservation as none and a missing customer as none", async () => {
    await agree(
      withService((service) =>
        Effect.all([
          service.getReservation(reservationId("missing")),
          service.getCustomer(customerId("missing")),
        ])
      )
    );
  });

  test("fails a reservation whose linked customer is gone", async () => {
    const result = await agree(
      withService((service) => service.getReservation(reservationId("orphan")))
    );
    expect(result).toMatchObject({
      failure: {
        _tag: "DotyposRejected",
        operation: "getReservation",
        reason: "not-found",
        request: "customer.get",
      },
    });
  });

  test("fails a missing reservation's status read as not found", async () => {
    const result = await agree(
      withService((service) =>
        service.getReservationStatus(reservationId("missing"))
      )
    );
    expect(result).toHaveProperty("failure.reason", "not-found");
  });

  test("reads customers by ID, deleted included and missing omitted", async () => {
    const result = await agree(
      withService((service) =>
        service.getCustomersByIds([
          customerId("customer-id"),
          customerId("deleted-customer"),
          customerId("missing"),
        ])
      ),
      (read) => [...read.keys()].sort()
    );
    expect(result).toEqual({ value: ["customer-id", "deleted-customer"] });
  });

  test("confirms a NEW reservation and reads it back confirmed", async () => {
    await agree(
      withService((service) =>
        service
          .confirmReservation(reservationId("new"))
          .pipe(
            Effect.flatMap((confirmed) =>
              service
                .getReservationStatus(confirmed.id)
                .pipe(Effect.map((status) => [confirmed.status, status]))
            )
          )
      )
    );
  });

  test("keeps a CONFIRMED reservation and refuses to confirm a CANCELLED one", async () => {
    const results = await Promise.all([
      agree(
        withService((service) =>
          service.confirmReservation(reservationId("confirmed"))
        ),
        (confirmed) => confirmed.status
      ),
      agree(
        withService((service) =>
          service.confirmReservation(reservationId("cancelled"))
        )
      ),
    ]);
    expect(results).toEqual([
      { value: "CONFIRMED" },
      {
        failure: expect.objectContaining({
          _tag: "DotyposReservationCancelledError",
        }),
      },
    ]);
  });

  test("restores a CANCELLED reservation and reads it back confirmed", async () => {
    const result = await agree(
      withService((service) =>
        service
          .restoreCancelledReservation({
            reservationId: reservationId("cancelled"),
            expectedBooking: fixtureBooking,
          })
          .pipe(
            Effect.flatMap((restored) =>
              service
                .getReservationStatus(restored.reservation.id)
                .pipe(
                  Effect.map((status) => [
                    restored._tag,
                    restored.reservation.status,
                    status,
                  ])
                )
            )
          )
      )
    );
    expect(result).toEqual({ value: ["Restored", "CONFIRMED", "CONFIRMED"] });
  });

  test("reassigns and replays a confirmed booking without changing its details", async () => {
    const input = {
      reservationId: reservationId("confirmed"),
      expectedBooking: fixtureBooking,
      expectedNoteLine: reservationMarker,
      customerId: customerId("new-holder"),
    };
    const result = await agree(
      withService((service) =>
        service.reassignReservationCustomerIfMatches(input).pipe(
          Effect.flatMap((written) =>
            service.reassignReservationCustomerIfMatches(input).pipe(
              Effect.map((replayed) => ({
                sameVersion: replayed.versionDate === written.versionDate,
                status: replayed.status,
                customerId: replayed._customerId,
                note: replayed.note,
              }))
            )
          )
        )
      )
    );
    expect(result).toEqual({
      value: {
        sameVersion: true,
        status: "CONFIRMED",
        customerId: input.customerId,
        note: input.expectedNoteLine,
      },
    });
  });

  test("keeps a CONFIRMED reservation and refuses a NEW or changed one", async () => {
    const restore = (id: string, expectedBooking = fixtureBooking) =>
      agree(
        withService((service) =>
          service.restoreCancelledReservation({
            reservationId: reservationId(id),
            expectedBooking,
          })
        ),
        (restored) => restored._tag
      );
    const results = await Promise.all([
      restore("confirmed"),
      restore("new"),
      restore("cancelled", { ...fixtureBooking, seats: 3 }),
    ]);
    expect(results).toEqual([
      { value: "AlreadyConfirmed" },
      {
        failure: expect.objectContaining({
          _tag: "DotyposReservationNotRestorable",
          reason: "not-cancelled",
        }),
      },
      {
        failure: expect.objectContaining({
          _tag: "DotyposReservationNotRestorable",
          reason: "booking-changed",
        }),
      },
    ]);
  });
});
