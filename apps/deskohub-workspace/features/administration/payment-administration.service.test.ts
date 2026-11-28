import "@/shared/testing/workspace-test-env";
import { describe, expect, test } from "bun:test";
import {
  ExternalAPIError,
  NetworkError,
  NexiOperationIdSchema,
  NexiOrderIdSchema,
} from "@deskohub/nexi";
import { NexiServiceMock } from "@deskohub/nexi/backend/service.mock";
import { Effect, Layer } from "effect";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  makeRecordingWorkspaceDatabase,
  type RecordingWorkspaceDatabase,
} from "@/shared/testing/workspace-recording-database.test-utils";
import {
  type IPaymentAdministrationService,
  PaymentAdministrationService,
} from "./payment-administration.service";

const makeLocalOrder = (
  providerOrderId: string,
  reservationId: string,
  createdAt: string,
  options?: {
    readonly providerOrderCreatedAt?: string | null;
    readonly providerSessionAttached?: boolean;
  }
) => ({
  paymentAttemptId: `attempt-${providerOrderId}`,
  providerOrderId,
  reservationId,
  state: "pending" as const,
  refundState: "not_required" as const,
  refundTargetValue: null,
  refundedAmountValue: null,
  refundedAt: null,
  amountValue: 5000,
  amountExponent: 2,
  currency: "CZK",
  attemptCreatedAt: Temporal.Instant.from(createdAt),
  providerOrderCreatedAt:
    options?.providerOrderCreatedAt === null
      ? null
      : Temporal.Instant.from(options?.providerOrderCreatedAt ?? createdAt),
  providerSessionAttached: options?.providerSessionAttached ?? true,
  updatedAt: Temporal.Instant.from(createdAt),
});

const makeDatabase = async (
  ...selections: readonly (readonly ReturnType<typeof makeLocalOrder>[])[]
) => {
  const database = await makeRecordingWorkspaceDatabase();
  database.setRows([
    ...selections.map((rows) =>
      rows.map((row) => [
        row.paymentAttemptId,
        row.providerOrderId,
        row.reservationId,
        row.state,
        row.refundState,
        row.refundTargetValue,
        row.refundedAmountValue,
        row.refundedAt,
        null, // failureCode
        row.amountValue,
        row.amountExponent,
        row.currency,
        row.attemptCreatedAt.toString(),
        row.providerOrderCreatedAt?.toString() ?? null,
        row.providerSessionAttached,
        row.updatedAt.toString(),
      ])
    ),
    [],
  ]);
  return database;
};

const runAdministration = <A, E>(
  database: RecordingWorkspaceDatabase,
  nexi: Parameters<typeof NexiServiceMock>[0],
  use: (administration: IPaymentAdministrationService) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    return yield* use(yield* PaymentAdministrationService);
  }).pipe(
    Effect.provide(
      PaymentAdministrationService.Default.pipe(
        Layer.provide(Layer.merge(database.layer, NexiServiceMock(nexi)))
      )
    ),
    Effect.runPromise
  );

const orderId = (value: string) => NexiOrderIdSchema.make(value);
const operationId = (value: string) => NexiOperationIdSchema.make(value);

const nexiError = (statusCode: number) =>
  new ExternalAPIError({
    operation: "lookup",
    service: "nexi",
    statusCode,
  });

const networkError = () => new NetworkError({ message: "Nexi timed out" });

describe("PaymentAdministrationService", () => {
  test("links returned provider orders beyond the truncated local page", async () => {
    const newestLocalOrder = makeLocalOrder(
      "newest-local-order",
      "newest-reservation",
      "2026-08-06T11:00:00Z"
    );
    const linkedOlderOrder = makeLocalOrder(
      "provider-order",
      "linked-reservation",
      "2026-08-06T10:00:00Z",
      { providerOrderCreatedAt: null }
    );
    const database = await makeDatabase([newestLocalOrder], [linkedOlderOrder]);

    const result = await runAdministration(
      database,
      {
        listOrders: () =>
          Effect.succeed([
            {
              orderId: orderId("provider-order"),
              operations: [],
            },
          ]),
      },
      (administration) => administration.listOrders({ maxRecords: 1 })
    );

    expect(database.statements).toHaveLength(2);
    expect(database.statements[1]?.params).toContain("provider-order");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      orderId: "newest-local-order",
      providerStatus: "not_returned",
      link: { reservationId: "newest-reservation" },
    });
    expect(result.items[1]).toMatchObject({
      orderId: "provider-order",
      providerStatus: "available",
      link: {
        reservationId: "linked-reservation",
        providerOrderCreatedAt: "2026-08-06T10:00:00Z",
        providerOrderCreatedAtEstimated: true,
        refundState: "not_required",
        refundedAmount: null,
        refundedAt: null,
      },
    });
  });

  test("orders the list by latest Nexi activity, then order and attempt creation", async () => {
    const attemptOnly = makeLocalOrder(
      "attempt-only",
      "attempt-reservation",
      "2026-08-06T09:00:00Z",
      { providerOrderCreatedAt: null, providerSessionAttached: false }
    );
    const database = await makeDatabase([attemptOnly]);

    const result = await runAdministration(
      database,
      {
        listOrders: () =>
          Effect.succeed([
            {
              lastOperationTime: "2026-08-06T12:00:00Z",
              operations: [],
              orderId: orderId("recent-activity"),
            },
            { operations: [], orderId: orderId("no-activity") },
          ]),
      },
      (administration) => administration.listOrders({})
    );

    expect(result.items.map((item) => item.orderId)).toEqual([
      orderId("recent-activity"),
      orderId("attempt-only"),
      orderId("no-activity"),
    ]);
    expect(result.providerAvailable).toBe(true);
  });

  test("loads one order with its local attempt and Nexi details", async () => {
    const local = makeLocalOrder(
      "single-order",
      "single-reservation",
      "2026-08-06T10:00:00Z"
    );
    const database = await makeDatabase([local]);
    const provider = {
      operations: [],
      orderId: orderId("single-order"),
    };

    const order = await runAdministration(
      database,
      { getOrder: () => Effect.succeed(provider) },
      (administration) => administration.loadOrder(orderId("single-order"))
    );

    expect(order).toMatchObject({
      orderId: "single-order",
      provider,
      providerAvailable: true,
      providerStatus: "available",
      link: { reservationId: "single-reservation" },
    });
  });

  test("tells a missing Nexi order from an unreachable one when loading an order", async () => {
    const statuses = await Promise.all(
      [nexiError(404), nexiError(502), networkError()].map(async (failure) =>
        runAdministration(
          await makeDatabase(),
          { getOrder: () => Effect.fail(failure) },
          (administration) => administration.loadOrder(orderId("lost-order"))
        )
      )
    );

    expect(statuses).toEqual([
      {
        orderId: orderId("lost-order"),
        provider: null,
        providerAvailable: false,
        providerStatus: "not_found",
        link: null,
      },
      {
        orderId: orderId("lost-order"),
        provider: null,
        providerAvailable: false,
        providerStatus: "unavailable",
        link: null,
      },
      {
        orderId: orderId("lost-order"),
        provider: null,
        providerAvailable: false,
        providerStatus: "unavailable",
        link: null,
      },
    ]);
  });

  test("links listed Nexi operations to the reservations that opened their orders", async () => {
    const linked = makeLocalOrder(
      "linked-order",
      "linked-reservation",
      "2026-08-06T10:00:00Z"
    );
    const database = await makeDatabase([linked]);
    const operations = [
      {
        operationId: operationId("op-linked"),
        orderId: orderId("linked-order"),
      },
      {
        operationId: operationId("op-unlinked"),
        orderId: orderId("foreign-order"),
      },
      { operationId: operationId("op-orderless") },
    ];

    const result = await runAdministration(
      database,
      { listOperations: () => Effect.succeed(operations) },
      (administration) => administration.listOperations({ maxRecords: 3 })
    );

    expect(result).toEqual({
      items: [
        {
          ...operations[0],
          linkedReservationId:
            workspaceReservationIdSchema.make("linked-reservation"),
        },
        { ...operations[1], linkedReservationId: null },
        { ...operations[2], linkedReservationId: null },
      ],
      providerAvailable: true,
      truncated: true,
    });
  });

  test("lists no operations while Nexi is unreachable", async () => {
    const database = await makeDatabase();

    const result = await runAdministration(
      database,
      { listOperations: () => Effect.fail(networkError()) },
      (administration) => administration.listOperations({})
    );

    expect(result).toEqual({
      items: [],
      providerAvailable: false,
      truncated: false,
    });
    expect(database.statements).toEqual([]);
  });

  test("loads one Nexi operation with the reservation that opened its order", async () => {
    const linked = makeLocalOrder(
      "operation-order",
      "operation-reservation",
      "2026-08-06T10:00:00Z"
    );
    const database = await makeDatabase([linked]);
    const operation = {
      operationId: operationId("op-1"),
      orderId: orderId("operation-order"),
    };

    const result = await runAdministration(
      database,
      { getOperation: () => Effect.succeed(operation) },
      (administration) => administration.loadOperation(operationId("op-1"))
    );

    expect(result).toEqual({
      operationId: operationId("op-1"),
      operation,
      providerAvailable: true,
      providerStatus: "available",
      linkedReservationId: workspaceReservationIdSchema.make(
        "operation-reservation"
      ),
    });
  });

  test("skips the reservation lookup for an operation without a Nexi order", async () => {
    const database = await makeDatabase();
    const operation = { operationId: operationId("op-orderless") };

    const result = await runAdministration(
      database,
      { getOperation: () => Effect.succeed(operation) },
      (administration) =>
        administration.loadOperation(operationId("op-orderless"))
    );

    expect(result.linkedReservationId).toBeNull();
    expect(result.operation).toEqual(operation);
    expect(database.statements).toEqual([]);
  });

  test("tells a missing Nexi operation from an unreachable one", async () => {
    const results = await Promise.all(
      [nexiError(404), nexiError(500), networkError()].map(async (failure) => {
        const database = await makeDatabase();
        return runAdministration(
          database,
          { getOperation: () => Effect.fail(failure) },
          (administration) =>
            administration.loadOperation(operationId("op-lost"))
        ).then((result) => ({ result, statements: database.statements }));
      })
    );

    expect(
      results.map(({ result }) => [
        result.providerStatus,
        result.providerAvailable,
        result.operation,
        result.linkedReservationId,
      ])
    ).toEqual([
      ["not_found", false, null, null],
      ["unavailable", false, null, null],
      ["unavailable", false, null, null],
    ]);
    expect(results.every(({ statements }) => statements.length === 0)).toBe(
      true
    );
  });

  test("keeps local orders listed while Nexi is unreachable", async () => {
    const local = makeLocalOrder(
      "local-only",
      "local-reservation",
      "2026-08-06T10:00:00Z"
    );
    const database = await makeDatabase([local]);

    const result = await runAdministration(
      database,
      { listOrders: () => Effect.fail(networkError()) },
      (administration) => administration.listOrders({})
    );

    expect(result).toMatchObject({
      providerAvailable: false,
      truncated: false,
      items: [
        {
          orderId: "local-only",
          provider: null,
          providerAvailable: false,
          providerStatus: "unavailable",
          link: { reservationId: "local-reservation" },
        },
      ],
    });
  });

  test("loads each of a reservation's orders with its own Nexi status", async () => {
    const first = makeLocalOrder(
      "first-order",
      "shared-reservation",
      "2026-08-06T10:00:00Z"
    );
    const second = makeLocalOrder(
      "second-order",
      "shared-reservation",
      "2026-08-06T11:00:00Z"
    );
    const database = await makeDatabase([first, second]);

    const orders = await runAdministration(
      database,
      {
        getOrder: ({ orderId: requested }) =>
          requested === "first-order"
            ? Effect.succeed({ operations: [], orderId: requested })
            : Effect.fail(nexiError(404)),
      },
      (administration) =>
        administration.loadReservationOrders(
          workspaceReservationIdSchema.make("shared-reservation")
        )
    );

    expect(
      orders.map((order) => [
        order.orderId,
        order.providerStatus,
        order.link?.paymentAttemptId,
      ])
    ).toEqual([
      [
        orderId("first-order"),
        "available",
        paymentAttemptIdSchema.make("attempt-first-order"),
      ],
      [
        orderId("second-order"),
        "not_found",
        paymentAttemptIdSchema.make("attempt-second-order"),
      ],
    ]);
  });
});
