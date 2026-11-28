import "@/shared/polyfills/temporal";
import { NoReservationInvitees } from "@/features/reservation-invitees/backend/reservation-invitees.test-utils";
import { withReservationPaymentHandlers } from "../payment/order-payment-handlers.test-utils";
import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import { DotyposService } from "@deskohub/dotypos";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { ReservationRecords } from "@/features/reservation/backend/reservation-records";
import { SeatingMapReleaseGate } from "@/features/reservation/backend/seating-map-release-gate";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { ReviewSandboxMock } from "@/features/review-accounts/backend/review-sandbox.service.mock";
import { makeWorkspaceNexiLayer } from "@/shared/backend/config/nexi.config";
import { CheckoutAnalytics } from "../analytics/checkout-analytics.service";
import { PaidFulfillmentQueueService } from "../fulfillment/paid-fulfillment-queue.service";
import { ReservationFulfillment } from "../fulfillment/reservation-fulfillment.service";
import { LatePaymentRecoveryQueueService } from "../payment/late-payment-recovery-queue.service";
import { LatePaymentVerificationService } from "../payment/late-payment-verification.service";
import { getNexiCurrencyOverride } from "../payment/nexi-currency";
import { PaymentProvidersFromNexi } from "../payment/payment-providers";
import { ProviderPaymentFinalizationService } from "../payment/provider-payment-finalization.service";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import { PaymentAttemptRepository } from "../repositories/payment-attempt.repository";
import { PaymentLifecycleRepository } from "../repositories/payment-lifecycle.repository";
import { PaymentLifecycleStateError } from "../repositories/payment-lifecycle-state";
import { CheckoutStatusService } from "./checkout-status.service";
import { loadCheckoutStatusPage } from "./checkout-status-page.server";
import {
  observePaymentPagesAs,
  testReservationPaymentWindow,
} from "./payment-page-provider-status.test-utils";

import {
  checkoutDotyposReservationId,
  paymentAttemptWithPageFixture,
} from "./testing/checkout-payment-fixture";

import { statusPageAuthorizationFixture } from "./testing/checkout-status-fixture";

mock.module("server-only", () => ({}));

/** The status page route's `maxDuration`. */
const statusPageMaxDurationSeconds = 60;

const orderId = workspaceReservationIdSchema.make(
  "0198c1a2-58cb-72a4-84fd-084db1c4c63b"
);
const createdAt = Temporal.Instant.from("2026-06-01T10:00:00Z");

const attemptId = paymentAttemptIdSchema.make("attempt-stalled-nexi");

const pendingReservation = workspaceReservationFixture({
  id: orderId,
  dotyposReservationId: checkoutDotyposReservationId,
  reservationDetails: {
    kind: "cowork",
    entryTier: "profi",
    coffee: true,
    monitorOption: "2x27-qhd",
  },
  productTier: "profi",
  productCoffee: true,
  productMonitorOption: "2x27-qhd",
  locale: "en-US",
  reservationState: "held",
  paymentState: "pending",
  fulfillmentState: "not_started",
  activePaymentAttemptId: attemptId,
  reservationCreatedAt: createdAt,
  reservationHoldExpiresAt: createdAt.add({ seconds: 600 }),
  reservationConfirmedAt: null,
  paidAt: null,
  fulfilledAt: null,
  createdAt,
  updatedAt: createdAt,
});

const pendingAttempt = paymentAttemptWithPageFixture({
  id: attemptId,
  reservationId: orderId,
  createdAt,
});

type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

/** A Nexi sandbox that accepts connections and never answers. */
const stalledFetch: ProviderFetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

/**
 * Loads the status page on a test clock advanced one second at a time until
 * it renders or reaches the route's `maxDuration`. Dotypos never answers.
 */
const loadStatusPageOnTestClock = (options: {
  readonly fetch: ProviderFetch;
  readonly onSecond?: (elapsedSeconds: number) => void;
  readonly paymentState: () => "pending" | "expired";
  readonly markPaid?: () => Effect.Effect<never, PaymentLifecycleStateError>;
  readonly startRecovery: () => Effect.Effect<never>;
}) =>
  Effect.gen(function* () {
    const checkoutStatus = yield* CheckoutStatusService;
    const page = yield* Effect.forkChild(
      loadCheckoutStatusPage(checkoutStatus, statusPageAuthorizationFixture(), {
        locale: "en-US",
        orderId,
        requestHeaders: new Headers(),
        returnOutcome: "success",
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch))
    );
    let elapsedSeconds = 0;
    while (
      page.pollUnsafe() === undefined &&
      elapsedSeconds < statusPageMaxDurationSeconds
    ) {
      yield* TestClock.adjust("1 second");
      elapsedSeconds += 1;
      options.onSecond?.(elapsedSeconds);
    }
    if (page.pollUnsafe() === undefined) {
      yield* Fiber.interrupt(page);
      return { elapsedSeconds, status: undefined };
    }
    return { elapsedSeconds, status: yield* Fiber.join(page) };
  }).pipe(
    Effect.provide(
      CheckoutStatusService.Default.pipe(
        Layer.provide(testReservationPaymentWindow()),
        Layer.provide(NoReservationInvitees),
        Layer.provide(observePaymentPagesAs("unknown").layer),
        Layer.provide(
          Layer.mergeAll(
            ProviderPaymentFinalizationService.Default,
            LatePaymentVerificationService.Default
          )
        ),
        Layer.provide(
          Layer.mergeAll(
            PaymentProvidersFromNexi.pipe(
              Layer.provide(makeWorkspaceNexiLayer("preview"))
            ),
            Layer.mock(PaymentLifecycleRepository, {
              ...(options.markPaid && { markPaid: options.markPaid }),
            }),
            Layer.mock(PaidFulfillmentQueueService, {}),
            Layer.mock(ReservationFulfillment, {}),
            Layer.mock(CheckoutAnalytics, {}),
            Layer.mock(WorkspaceReservationRepository, {
              findById: () =>
                Effect.succeed({
                  ...pendingReservation,
                  paymentState: options.paymentState(),
                }),
            }),
            Layer.mock(PaymentAttemptRepository, {
              findById: () => {
                const state = options.paymentState();
                return Effect.succeed({
                  ...pendingAttempt,
                  state,
                  failureCode: state === "expired" ? "payment_expired" : null,
                });
              },
              findDisplayableForReservation: () => Effect.succeed(null),
            }),
            Layer.mock(LatePaymentRecoveryRepository, {
              findLatestByWorkspaceReservationId: () => Effect.succeed(null),
              findByPaymentAttemptId: () => Effect.succeed(null),
              start: options.startRecovery,
            }),
            Layer.mock(LatePaymentRecoveryQueueService, {}),
            ReservationRecords.Provider.pipe(
              Layer.provideMerge(
                Layer.mock(DotyposService, {
                  getReservationWithoutCustomer: () => Effect.never,
                  getCustomer: () => Effect.never,
                })
              )
            ),
            Layer.mock(AdvisoryAvailabilityInventory, {
              tables: Effect.never,
            }),
            SeatingMapReleaseGate.fromDecision(true),
            ReviewSandboxMock({})
          ).pipe(withReservationPaymentHandlers)
        )
      )
    ),
    Effect.provide(TestClock.layer()),
    Effect.runPromise
  );

test("renders the stored status within the route limit when Nexi and Dotypos stall", async () => {
  const startRecovery = mock(() => Effect.die("unexpected late payment"));

  const { elapsedSeconds, status } = await loadStatusPageOnTestClock({
    fetch: stalledFetch,
    paymentState: () => "pending",
    startRecovery,
  });

  expect(status).toMatchObject({
    orderId,
    status: "pending",
    paymentStatus: "pending",
  });
  // One full 30-second sandbox lookup ran before the deadline stopped retries.
  expect(elapsedSeconds).toBeGreaterThan(30);
  expect(elapsedSeconds).toBeLessThan(statusPageMaxDurationSeconds);
  expect(startRecovery).not.toHaveBeenCalled();
});

test("defers late-payment verification when a slow lookup loses a race with a terminal transition", async () => {
  const currency = getNexiCurrencyOverride() ?? "CZK";
  const settledOrder = {
    orderStatus: {
      order: { orderId: "provider-order-id", amount: "35000", currency },
    },
    operations: [
      {
        operationId: "operation-id",
        operationType: "CAPTURE",
        operationResult: "EXECUTED",
        operationAmount: "35000",
        operationCurrency: currency,
        securityToken: "security-token",
      },
    ],
  };
  // The first lookup times out at 30 seconds; its retry answers at 35.
  const providerLookups: Array<(response: Response) => void> = [];
  const slowThenStalledFetch: ProviderFetch = (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      providerLookups.push(resolve);
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason)
      );
    });
  // Hold cleanup expires the attempt while the lookup is in flight, so the
  // paid transition fails its lifecycle guard.
  let paymentState: "pending" | "expired" = "pending";
  const markPaid = mock(() => {
    paymentState = "expired";
    return Effect.fail(
      new PaymentLifecycleStateError({
        operation: "markPaid",
        paymentReference: {
          type: "paymentAttemptId",
          id: pendingAttempt.id,
        },
        message: "Only a pending attempt can be marked paid.",
      })
    );
  });
  const startRecovery = mock(() => Effect.die("unexpected recovery start"));

  const { elapsedSeconds, status } = await loadStatusPageOnTestClock({
    fetch: slowThenStalledFetch,
    onSecond: (elapsedSeconds) => {
      if (elapsedSeconds === 35) {
        providerLookups.at(-1)?.(Response.json(settledOrder));
      }
    },
    paymentState: () => paymentState,
    markPaid,
    startRecovery,
  });

  expect(markPaid).toHaveBeenCalledTimes(1);
  expect(status).toMatchObject({
    orderId,
    status: "expired",
    paymentStatus: "expired",
  });
  expect(elapsedSeconds).toBeLessThan(statusPageMaxDurationSeconds);
  // Only 5 seconds of the shared budget remained, too little for a full
  // sandbox request, so no late-payment lookup started.
  expect(providerLookups).toHaveLength(2);
  expect(startRecovery).not.toHaveBeenCalled();
});
