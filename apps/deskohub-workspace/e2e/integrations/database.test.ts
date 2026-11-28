import { expect, test } from "bun:test";
import {
  DotyposBranchIdSchema,
  DotyposClientIdSchema,
  DotyposCloudIdSchema,
  DotyposEmployeeIdSchema,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { workspaceReservationIdSchema } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import { sql } from "drizzle-orm";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import type { latePaymentRecoveries } from "@/db/schema";
import {
  checkoutAttemptKeySchema,
  checkoutSessionKeySchema,
  paymentAttemptIdSchema,
} from "@/features/checkout/checkout-identifiers";
import type { DatasourceConfig, WorkspaceE2EConfig } from "../config";
import { workspaceE2ETimeouts } from "../timeouts";
import type { CheckoutRow } from "../types";
import {
  assertDiscountApplications,
  assertInternalDiscountApplications,
  assertLatePaymentRecoveryOutcome,
  assertLegalEvidenceRows,
  getPreviewFulfillmentMarkerDiagnosticCode,
  getProviderSessionRowDiagnosticCode,
  replayPaymentWebhook,
  waitForProviderSessionRowAfterRedirect,
} from "./database";
import { E2EDatabase } from "./database.service";

const originalReservationId = DotyposReservationIdSchema.make(
  "original-reservation"
);
const replacementReservationId = DotyposReservationIdSchema.make(
  "replacement-reservation"
);
const reservationId = workspaceReservationIdSchema.make("reservation-1");

test("accepts a recreated late-payment recovery", async () => {
  await Effect.runPromise(
    assertLatePaymentRecoveryOutcome(
      {
        checkoutRow: makeCheckoutRow({
          dotypos_reservation_id: replacementReservationId,
          fulfillment_state: "processing",
          payment_attempt_state: "paid",
          payment_state: "paid",
          reservation_state: "confirmed",
          webhook_state: "processed",
        }),
        recovery: makeLatePaymentRecovery({
          recoveredDotyposReservationId: replacementReservationId,
          state: "recovered",
        }),
      },
      originalReservationId,
      { state: "recovered" }
    )
  );
});

test("accepts a refund-required late-payment recovery", async () => {
  const failureCode = "late_payment_snapshot_unavailable";

  await Effect.runPromise(
    assertLatePaymentRecoveryOutcome(
      {
        checkoutRow: makeCheckoutRow({
          dotypos_reservation_id: originalReservationId,
          failure_code: failureCode,
          payment_attempt_state: "paid",
          payment_state: "paid",
          reservation_state: "cancelled",
          webhook_state: "processed",
        }),
        recovery: makeLatePaymentRecovery({
          failureCode,
          state: "refund_required",
        }),
      },
      originalReservationId,
      {
        state: "refund_required",
        failureCode,
      }
    )
  );
});

test("accepts reservation terms evidence from payment submission", () => {
  const row = (document_key: string, source: string, accepted = true) => ({
    accepted,
    acknowledgements: {},
    document_key,
    hash_algorithm: "sha256",
    locale: "en-US",
    source,
  });

  expect(() =>
    assertLegalEvidenceRows(
      [
        row("termsAndConditions", "payment_submit"),
        row("operatingRules", "payment_submit"),
      ],
      "en-US"
    )
  ).not.toThrow();
});

test("rejects reservation terms evidence without recorded acknowledgements", () => {
  expect(() =>
    assertLegalEvidenceRows(
      [
        {
          accepted: true,
          acknowledgements: null,
          document_key: "termsAndConditions",
          hash_algorithm: "sha256",
          locale: "en-US",
          source: "payment_submit",
        },
      ],
      "en-US"
    )
  ).toThrow(
    "legal evidence termsAndConditions acknowledgements were not recorded"
  );
});

test("connects the E2E database to the unpooled preview datasource URL", async () => {
  const connections = { pooled: 0, unpooled: 0 };
  const listen = (target: keyof typeof connections) =>
    Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: () => undefined,
        open: (socket) => {
          connections[target] += 1;
          socket.end();
        },
      },
    });
  const pooled = listen("pooled");
  const unpooled = listen("unpooled");

  try {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { db } = yield* E2EDatabase;
        return yield* db.execute(sql`select 1`);
      }).pipe(
        Effect.provide(
          E2EDatabase.layer(
            makeDatasourceConfig({
              databaseUrl: `postgres://e2e:e2e@127.0.0.1:${pooled.port}/workspace`,
              databaseUrlUnpooled: `postgres://e2e:e2e@127.0.0.1:${unpooled.port}/workspace`,
            })
          )
        )
      )
    );

    // Neither listener speaks Postgres, so the query fails after connecting.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(connections.pooled).toBe(0);
    expect(connections.unpooled).toBeGreaterThan(0);
  } finally {
    pooled.stop(true);
    unpooled.stop(true);
  }
});

test("classifies provider session rows after the hosted redirect barrier", () => {
  expect(getProviderSessionRowDiagnosticCode(undefined)).toBe(
    "provider_session_reservation_missing_after_redirect"
  );
  expect(getProviderSessionRowDiagnosticCode(makeCheckoutRow())).toBe(
    "provider_session_active_attempt_missing_after_redirect"
  );
  expect(
    getProviderSessionRowDiagnosticCode(
      makeHostedCheckoutRow({
        provider_redirect_url: null,
        security_token: null,
      })
    )
  ).toBe("provider_session_fields_missing_after_redirect");
  expect(
    getProviderSessionRowDiagnosticCode(
      makeHostedCheckoutRow({ security_token: "" })
    )
  ).toBe("provider_session_fields_missing_after_redirect");
  expect(
    getProviderSessionRowDiagnosticCode(makeHostedCheckoutRow())
  ).toBeUndefined();
});

test("stops waiting for the preview fulfillment marker once the order cannot fulfill", () => {
  expect(getPreviewFulfillmentMarkerDiagnosticCode(undefined)).toBeUndefined();
  expect(
    getPreviewFulfillmentMarkerDiagnosticCode(makeCheckoutRow())
  ).toBeUndefined();
  expect(
    getPreviewFulfillmentMarkerDiagnosticCode(
      makeCheckoutRow({
        fulfillment_state: "processing",
        payment_state: "paid",
      })
    )
  ).toBeUndefined();
  for (const payment_state of ["failed", "cancelled", "expired"] as const) {
    expect(
      getPreviewFulfillmentMarkerDiagnosticCode(
        makeCheckoutRow({ payment_state })
      )
    ).toBe("checkout_payment_terminal_before_fulfillment");
  }
  expect(
    getPreviewFulfillmentMarkerDiagnosticCode(
      makeCheckoutRow({ fulfillment_state: "failed", payment_state: "paid" })
    )
  ).toBe("checkout_fulfillment_failed_before_marker");
});

test("waits briefly for the provider session row to converge after redirect", async () => {
  const incompleteRow = makeCheckoutRow();
  const completeRow = makeHostedCheckoutRow();
  const rows = [undefined, incompleteRow, completeRow];
  const observedRows: CheckoutRow[] = [];
  let reads = 0;

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const waited = yield* Effect.forkChild(
        waitForProviderSessionRowAfterRedirect(
          Effect.sync(() => rows[reads++]),
          {
            intervalMs: 1,
            onRow: (row) => observedRows.push(row),
            timeoutMs: 2_000,
          }
        )
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 millis");
      yield* TestClock.adjust("1 millis");
      return yield* Fiber.join(waited);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(completeRow).toBe(result);
  expect(reads).toBe(3);
  expect(observedRows).toEqual([incompleteRow, completeRow]);
});

test("retains the last provider session diagnostic after convergence times out", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const waited = yield* Effect.forkChild(
        waitForProviderSessionRowAfterRedirect(
          Effect.succeed(makeCheckoutRow()),
          { intervalMs: 1, timeoutMs: 5 }
        )
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 millis");
      return yield* Fiber.join(waited);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  expect(Cause.squash(exit.cause)).toMatchObject({
    diagnosticCode: "provider_session_active_attempt_missing_after_redirect",
    reason: "timeout",
  });
});

test("replays Nexi notification against the exact protected preview", async () => {
  const requests: Array<{
    body: string;
    headers: Headers;
    method: string | undefined;
    url: string;
  }> = [];
  const httpClientLayer = makeWebhookHttpClient(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push({
        body: await request.clone().text(),
        headers: request.headers,
        method: request.method,
        url: request.url,
      });
      return new Response(null, { status: 200 });
    }
  );
  await Effect.runPromise(
    replayPaymentWebhook(makeConfig(), makeWebhookCheckoutRow()).pipe(
      Effect.andThen(
        replayPaymentWebhook(
          { ...makeConfig(), paymentProvider: "fallback" },
          makeWebhookCheckoutRow()
        )
      ),
      Effect.provide(httpClientLayer)
    )
  );

  expect(requests).toHaveLength(2);
  expect(requests[1]?.url).toBe(requests[0]?.url);
  expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({
    operation: { orderId: "provider-order-1" },
  });
  const request = requests[0];
  expect(request?.url).toBe(
    "https://deskohub-workspace-a1b2c3d4e-deskohub-bar.vercel.app/api/webhooks/nexi"
  );
  expect(request?.method).toBe("POST");
  expect(request?.headers.get("content-type")).toBe("application/json");
  expect(request?.headers.get("x-vercel-protection-bypass")).toBe(
    "test-protection-bypass"
  );
  expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
    operation: {
      operationCurrency: "EUR",
      operationResult: "EXECUTED",
      orderId: "provider-order-1",
    },
    securityToken: "test-security-token",
  });
});

test.each([
  [
    "nexi_webhook_fulfillment_failed",
    "nexi_webhook_fulfillment_failed",
    "nexi_webhook_fulfillment_failed",
  ],
  [
    "postgres_checkout_row_assertion_failed",
    "postgres_checkout_row_assertion_failed",
    undefined,
  ],
  ["provider-payload-value", "provider-payload-value", undefined],
  ["a non-string code", 123, undefined],
] as const)(
  "keeps webhook failure diagnostics on the fixed allowlist for %s",
  async (_label, responseCode, expectedDiagnosticCode) => {
    const httpClientLayer = makeWebhookHttpClient(async () =>
      Response.json(
        { code: responseCode, payload: "provider payload must stay private" },
        { status: 500 }
      )
    );
    const exit = await Effect.runPromiseExit(
      replayPaymentWebhook(makeConfig(), makeWebhookCheckoutRow()).pipe(
        Effect.provide(httpClientLayer)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(error).toMatchObject({
      message: "Nexi webhook replay failed with 500",
    });
    expect(error.diagnosticCode).toBe(expectedDiagnosticCode);
    expect(JSON.stringify(error)).not.toContain(
      "provider payload must stay private"
    );
  }
);

test("replays mock payment on the protected preview with a stable event ID", async () => {
  const requests: { request: Request; body: unknown }[] = [];
  const httpClientLayer = makeWebhookHttpClient(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ request, body: await request.json() });
      return new Response(null, { status: 200 });
    }
  );
  const config = { ...makeConfig(), paymentProvider: "mock" } as const;
  const row = makeWebhookCheckoutRow({ provider: "mock" });

  await Effect.runPromise(
    replayPaymentWebhook(config, row).pipe(
      Effect.andThen(
        replayPaymentWebhook({ ...config, paymentProvider: "fallback" }, row)
      ),
      Effect.provide(httpClientLayer)
    )
  );
  const rejectedReplay = await Effect.runPromiseExit(
    replayPaymentWebhook(config, makeWebhookCheckoutRow()).pipe(
      Effect.provide(httpClientLayer)
    )
  );

  expect(Exit.isFailure(rejectedReplay)).toBe(true);
  expect(requests).toHaveLength(2);
  for (const { request, body } of requests) {
    expect(request.url).toBe(
      new URL("/api/webhooks/mock-payment", config.baseUrl).href
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-vercel-protection-bypass")).toBe(
      "test-protection-bypass"
    );
    expect(body).toEqual({
      eventId: expect.any(String),
      paymentId: row.provider_order_id,
      token: row.security_token,
    });
  }
  expect(requests[0]?.body).toEqual(requests[1]?.body);
});

test("accepts automatic discounts stacked before the redeemed zero-total code", () => {
  expect(() =>
    assertInternalDiscountApplications([
      {
        applied_amount_value: 100,
        redemption_state: null,
        redeemed_at: null,
        subtotal_after_value: 900,
        subtotal_before_value: 1000,
      },
      {
        applied_amount_value: 900,
        redemption_state: "redeemed",
        redeemed_at: new Date("2099-07-24T12:00:00.000Z"),
        subtotal_after_value: 0,
        subtotal_before_value: 900,
      },
    ])
  ).not.toThrow();
});

test("accepts the catalog money exponent in persisted discount applications", () => {
  expect(() =>
    assertDiscountApplications(
      [
        {
          adjustment: { kind: "percentage", basisPoints: 1000 },
          applied_amount_currency: "CZK",
          applied_amount_exponent: 2,
          applied_amount_value: 3500,
          countdown_starts_at: null,
          expires_at: null,
          label: "Customer discount",
          redeemed_at: null,
          redemption_state: null,
          sequence: 0,
          subtotal_after_currency: "CZK",
          subtotal_after_exponent: 2,
          subtotal_after_value: 31_500,
          subtotal_before_currency: "CZK",
          subtotal_before_exponent: 2,
          subtotal_before_value: 35_000,
        },
      ],
      [
        {
          adjustment: { kind: "percentage", basisPoints: 1000 },
          label: "Customer discount",
        },
      ],
      "CZK"
    )
  ).not.toThrow();
});

test("accepts a fixed voucher that leaves a positive payment balance", () => {
  expect(() =>
    assertDiscountApplications(
      [
        {
          adjustment: {
            kind: "fixed",
            amount: { value: 10_000, exponent: 2, currency: "CZK" },
          },
          applied_amount_currency: "CZK",
          applied_amount_exponent: 2,
          applied_amount_value: 10_000,
          countdown_starts_at: null,
          expires_at: null,
          label: "Voucher",
          redeemed_at: new Date("2099-07-24T12:00:00.000Z"),
          redemption_state: "redeemed",
          sequence: 0,
          subtotal_after_currency: "CZK",
          subtotal_after_exponent: 2,
          subtotal_after_value: 18_000,
          subtotal_before_currency: "CZK",
          subtotal_before_exponent: 2,
          subtotal_before_value: 28_000,
        },
      ],
      [
        {
          adjustment: {
            kind: "fixed",
            amount: { value: 10_000, exponent: 2, currency: "CZK" },
          },
          label: "Voucher",
          redemptionState: "redeemed",
        },
      ],
      "CZK"
    )
  ).not.toThrow();
});

const makeConfig = (): WorkspaceE2EConfig => ({
  baseUrl: "https://deskohub-workspace-a1b2c3d4e-deskohub-bar.vercel.app",
  bypassSecret: "test-protection-bypass",
  expectedHost: "deskohub-workspace-a1b2c3d4e-deskohub-bar.vercel.app",
  paymentProvider: "nexi",
  timeouts: workspaceE2ETimeouts,
});

const makeDatasourceConfig = (
  urls: Pick<DatasourceConfig, "databaseUrl" | "databaseUrlUnpooled">
): DatasourceConfig => ({
  ...urls,
  dotypos: {
    apiTimeout: 1_000,
    apiUrl: "http://127.0.0.1:1",
    branchId: DotyposBranchIdSchema.make("11111111"),
    clientId: DotyposClientIdSchema.make("e2e-client"),
    clientSecret: "e2e-client-secret",
    cloudId: DotyposCloudIdSchema.make("cloud-id"),
    employeeId: DotyposEmployeeIdSchema.make("22222222"),
    refreshToken: "e2e-refresh-token",
  },
  expectedCurrency: "CZK",
  fixtureCapacityTarget: {
    baseUrl: makeConfig().baseUrl,
    githubRunAttempt: undefined,
    githubRunId: undefined,
    targetSha: undefined,
  },
  nexiApiOrigin: "https://xpaysandbox.nexigroup.com",
  timeouts: { ...workspaceE2ETimeouts, datasource: 2_000 },
});

const makeWebhookHttpClient = (
  respond: (...args: Parameters<typeof fetch>) => Promise<Response>
) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        Object.assign(respond, { preconnect: () => undefined })
      )
    )
  );

const makeCheckoutRow = (
  overrides: Partial<CheckoutRow> = {}
): CheckoutRow => ({
  reservation_id: reservationId,
  checkout_session_key: checkoutSessionKeySchema.make("checkout-session-1"),
  checkout_attempt_key: checkoutAttemptKeySchema.make("checkout-attempt-1"),
  correlation_id: "correlation-1",
  dotypos_customer_id: null,
  dotypos_reservation_id: null,
  reservation_state: "held",
  payment_state: "pending",
  fulfillment_state: "not_started",
  active_payment_attempt_id: null,
  reservation_details: null,
  locale: "en-US",
  reservation_created_at: null,
  reservation_hold_expires_at: null,
  reservation_confirmed_at: null,
  reservation_cancelled_at: null,
  reservation_hold_expired_at: null,
  paid_at: null,
  fulfilled_at: null,
  fulfillment_failed_at: null,
  failure_code: null,
  fulfillment_failure_code: null,
  payment_attempt_id: null,
  provider: null,
  provider_order_id: null,
  security_token: null,
  payment_attempt_state: null,
  amount_value: null,
  amount_exponent: null,
  currency: null,
  provider_redirect_url: null,
  last_webhook_event_id: null,
  last_provider_operation_id: null,
  last_provider_status: null,
  payment_failure_code: null,
  webhook_id: null,
  webhook_provider: null,
  webhook_event_id: null,
  webhook_provider_order_id: null,
  webhook_processed_at: null,
  webhook_state: null,
  webhook_error_code: null,
  ...overrides,
});

const makeHostedCheckoutRow = (overrides: Partial<CheckoutRow> = {}) => {
  const paymentAttemptId = paymentAttemptIdSchema.make("attempt-1");
  return makeCheckoutRow({
    active_payment_attempt_id: paymentAttemptId,
    amount_value: 100,
    amount_exponent: 2,
    currency: "EUR",
    payment_attempt_id: paymentAttemptId,
    provider: "nexi",
    provider_order_id: "provider-order-1",
    provider_redirect_url: "https://provider.example/hosted",
    security_token: "security-token",
    ...overrides,
  });
};

const makeWebhookCheckoutRow = (overrides: Partial<CheckoutRow> = {}) => {
  const paymentAttemptId = paymentAttemptIdSchema.make("payment-attempt-1");
  return makeHostedCheckoutRow({
    active_payment_attempt_id: paymentAttemptId,
    last_provider_operation_id: "provider-operation-1",
    payment_attempt_id: paymentAttemptId,
    provider_redirect_url: null,
    security_token: "test-security-token",
    ...overrides,
  });
};

type LatePaymentRecoveryRow = typeof latePaymentRecoveries.$inferSelect;

const makeLatePaymentRecovery = (
  outcome: Pick<LatePaymentRecoveryRow, "state"> &
    Partial<
      Pick<
        LatePaymentRecoveryRow,
        "failureCode" | "recoveredDotyposReservationId"
      >
    >
): LatePaymentRecoveryRow => {
  const completedAt = Temporal.Instant.from("2099-07-24T12:00:00Z");
  return {
    paymentAttemptId: paymentAttemptIdSchema.make("attempt-1"),
    workspaceReservationId: reservationId,
    webhookEventId: null,
    providerOperationId: null,
    providerStatus: null,
    originalDotyposReservationId: originalReservationId,
    recoveredDotyposReservationId: null,
    failureCode: null,
    verifiedPaidAt: completedAt,
    claimedAt: completedAt,
    completedAt,
    createdAt: completedAt,
    updatedAt: completedAt,
    ...outcome,
  };
};
