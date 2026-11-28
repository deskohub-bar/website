import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import type { NexiService as NexiServiceTag } from "@deskohub/nexi";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Effect, Layer } from "effect";
import { PaidFulfillmentQueueError } from "../fulfillment/paid-fulfillment-queue.service";
import {
  type IReservationFulfillment,
  ReservationFulfillment,
} from "../fulfillment/reservation-fulfillment.service";
import {
  type IPaymentLifecycleRepository,
  PaymentLifecycleRepository,
} from "../repositories/payment-lifecycle.repository";
import {
  type NexiVerification,
  nexiVerificationFixture,
} from "./nexi-verification.test-utils";
import { withReservationPaymentHandlers } from "./order-payment-handlers.test-utils";
import { PaymentProvidersFromNexi } from "./payment-providers";
import type { ProviderPaymentFinalizationResult } from "./provider-payment-finalization.service";
import {
  attemptCreatedAt,
  orderId,
  paidReservation,
  paymentAttemptId,
  pendingAttempt,
  pendingReservation,
  providerOrderId,
  reservationId,
  unattachedAttempt,
} from "./provider-payment-finalization.test-utils";

type NexiServiceType = typeof NexiServiceTag.Service;

const paymentLifecycleLayer = (
  overrides: Partial<IPaymentLifecycleRepository> = {}
) =>
  Layer.mock(PaymentLifecycleRepository, {
    attachProviderSession: () => Effect.die("not used"),
    markPaid: () => Effect.die("not used"),
    markTerminal: () => Effect.die("not used"),
    ...overrides,
  });

const paidFulfillmentLayer = (
  fulfillPaidOrder: IReservationFulfillment["run"] = () =>
    Effect.die("not used")
) => Layer.mock(ReservationFulfillment, { run: fulfillPaidOrder });

const emptyPendingVerification = nexiVerificationFixture("pending", {
  operationId: undefined,
  operationCount: 0,
  authorizedAmount: "0",
  capturedAmount: "0.00",
  orderStatus: "PENDING",
});

describe("ProviderPaymentFinalizationService", () => {
  for (const fulfillmentState of [
    "not_started",
    "processing",
    "awaiting_delivery",
    "fulfilled",
  ] as const) {
    test(`${fulfillmentState === "not_started" || fulfillmentState === "processing" ? "enqueues" : "skips"} fulfillment for already-paid ${fulfillmentState} provider returns`, async () => {
      const { ProviderPaymentFinalizationService } = await import(
        "./provider-payment-finalization.service"
      );
      const { PaymentAttemptRepository } = await import(
        "../repositories/payment-attempt.repository"
      );
      const { PaidFulfillmentQueueService } = await import(
        "../fulfillment/paid-fulfillment-queue.service"
      );
      const { WorkspaceReservationRepository } = await import(
        "@/features/reservation/backend/workspace-reservation.repository"
      );
      const { recordCheckoutAnalytics } = await import(
        "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
      );
      const { NexiService } = await import("@deskohub/nexi");

      const enqueue = mock(() => Effect.void);
      const reservations = {
        findById: mock(() => Effect.succeed(paidReservation(fulfillmentState))),
      };

      const result = await Effect.gen(function* () {
        const service = yield* ProviderPaymentFinalizationService;
        return yield* service.finalizePendingProviderPayment({
          orderId,
          paymentAttemptId,
        });
      }).pipe(
        Effect.provide(
          ProviderPaymentFinalizationService.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(WorkspaceReservationRepository, reservations),
                paidFulfillmentLayer(),
                Layer.mock(PaidFulfillmentQueueService, { enqueue }),
                Layer.mock(PaymentAttemptRepository, {}),
                paymentLifecycleLayer(),
                recordCheckoutAnalytics().layer,
                PaymentProvidersFromNexi.pipe(
                  Layer.provide(Layer.mock(NexiService, {}))
                )
              ).pipe(withReservationPaymentHandlers)
            )
          )
        ),
        Effect.runPromise
      );

      expect(result).toBe("paid");
      if (
        fulfillmentState === "not_started" ||
        fulfillmentState === "processing"
      ) {
        expect(enqueue).toHaveBeenCalledWith({ orderId });
      } else {
        expect(enqueue).not.toHaveBeenCalled();
      }
    });
  }

  test("fulfills inline when the paid fulfillment queue is unavailable", async () => {
    const { ProviderPaymentFinalizationService } = await import(
      "./provider-payment-finalization.service"
    );
    const { PaymentAttemptRepository } = await import(
      "../repositories/payment-attempt.repository"
    );
    const { PaidFulfillmentQueueService } = await import(
      "../fulfillment/paid-fulfillment-queue.service"
    );
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );
    const { NexiService } = await import("@deskohub/nexi");

    const fulfillPaidOrder = mock(() => Effect.void);
    const result = await Effect.gen(function* () {
      const service = yield* ProviderPaymentFinalizationService;
      return yield* service.finalizePendingProviderPayment({
        orderId,
        paymentAttemptId,
      });
    }).pipe(
      Effect.provide(
        ProviderPaymentFinalizationService.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() =>
                  Effect.succeed(paidReservation("not_started"))
                ),
              }),
              paidFulfillmentLayer(fulfillPaidOrder),
              Layer.mock(PaidFulfillmentQueueService, {
                enqueue: () =>
                  Effect.fail(
                    new PaidFulfillmentQueueError({
                      message: "queue down",
                    })
                  ),
              }),
              Layer.mock(PaymentAttemptRepository, {}),
              paymentLifecycleLayer(),
              recordCheckoutAnalytics().layer,
              PaymentProvidersFromNexi.pipe(
                Layer.provide(Layer.mock(NexiService, {}))
              )
            ).pipe(withReservationPaymentHandlers)
          )
        )
      ),
      Effect.runPromise
    );

    expect(result).toBe("paid");
    expect(fulfillPaidOrder).toHaveBeenCalledWith(reservationId);
  });

  test("does not retry fulfillment after a paid reservation has failed fulfillment", async () => {
    const { ProviderPaymentFinalizationService } = await import(
      "./provider-payment-finalization.service"
    );
    const { PaymentAttemptRepository } = await import(
      "../repositories/payment-attempt.repository"
    );
    const { PaidFulfillmentQueueService } = await import(
      "../fulfillment/paid-fulfillment-queue.service"
    );
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );
    const { NexiService } = await import("@deskohub/nexi");

    const enqueue = mock(() => Effect.void);
    const reservations = {
      findById: mock(() => Effect.succeed(paidReservation("failed"))),
    };

    const result = await Effect.gen(function* () {
      const service = yield* ProviderPaymentFinalizationService;
      return yield* service.finalizePendingProviderPayment({
        orderId,
        paymentAttemptId,
      });
    }).pipe(
      Effect.provide(
        ProviderPaymentFinalizationService.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(WorkspaceReservationRepository, reservations),
              paidFulfillmentLayer(),
              Layer.mock(PaidFulfillmentQueueService, { enqueue }),
              Layer.mock(PaymentAttemptRepository, {}),
              paymentLifecycleLayer(),
              recordCheckoutAnalytics().layer,
              PaymentProvidersFromNexi.pipe(
                Layer.provide(Layer.mock(NexiService, {}))
              )
            ).pipe(withReservationPaymentHandlers)
          )
        )
      ),
      Effect.runPromise
    );

    expect(result).toBe("not_pending");
    expect(enqueue).not.toHaveBeenCalled();
  });

  for (const scenario of [
    { verificationStatus: "success" as const, expected: "paid" as const },
    { verificationStatus: "failure" as const, expected: "terminal" as const },
  ]) {
    test(`finalizes pending ${scenario.verificationStatus} provider payments`, async () => {
      const { ProviderPaymentFinalizationService } = await import(
        "./provider-payment-finalization.service"
      );
      const { PaymentAttemptRepository } = await import(
        "../repositories/payment-attempt.repository"
      );
      const { PaidFulfillmentQueueService } = await import(
        "../fulfillment/paid-fulfillment-queue.service"
      );
      const { WorkspaceReservationRepository } = await import(
        "@/features/reservation/backend/workspace-reservation.repository"
      );
      const { recordCheckoutAnalytics } = await import(
        "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
      );
      const { NexiService } = await import("@deskohub/nexi");

      const markPaidForReservation = mock(() =>
        Effect.succeed({
          attempt: { ...pendingAttempt, state: "paid" as const },
          changed: true,
          timestamp: Temporal.Now.instant(),
        })
      );
      const markTerminalForReservation = mock(() =>
        Effect.succeed({
          attempt: {
            ...pendingAttempt,
            state: "failed" as const,
            failureCode: "nexi_payment_failed",
            lastProviderStatus: "DECLINED",
          },
          changed: true,
          timestamp: Temporal.Now.instant(),
        })
      );
      const enqueue = mock(() => Effect.void);
      const paymentAttempts = {
        findById: mock(() => Effect.succeed(pendingAttempt)),
      };
      const reservations = {
        findById: mock(() => Effect.succeed(pendingReservation)),
      };
      const nexi = {
        verifyPaymentOutcome: mock(() =>
          Effect.succeed(nexiVerificationFixture(scenario.verificationStatus))
        ),
      };

      const result = await Effect.gen(function* () {
        const service = yield* ProviderPaymentFinalizationService;
        return yield* service.finalizePendingProviderPayment({
          orderId,
          paymentAttemptId,
          webhookEventId: "event-id",
        });
      }).pipe(
        Effect.provide(
          ProviderPaymentFinalizationService.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(WorkspaceReservationRepository, reservations),
                paidFulfillmentLayer(),
                Layer.mock(PaidFulfillmentQueueService, { enqueue }),
                Layer.mock(PaymentAttemptRepository, paymentAttempts),
                paymentLifecycleLayer({
                  markPaid: markPaidForReservation,
                  markTerminal: markTerminalForReservation,
                }),
                recordCheckoutAnalytics().layer,
                PaymentProvidersFromNexi.pipe(
                  Layer.provide(Layer.mock(NexiService, nexi))
                )
              ).pipe(withReservationPaymentHandlers)
            )
          )
        ),
        Effect.runPromise
      );

      expect(result).toBe(scenario.expected);
      expect(nexi.verifyPaymentOutcome).toHaveBeenCalledWith({
        orderId: providerOrderId,
        correlationId: "correlation-id",
        amount: "35000",
        currency: "EUR",
        securityToken: "security-token",
      });

      if (scenario.expected === "paid") {
        expect(markPaidForReservation).toHaveBeenCalledWith(
          expect.objectContaining({
            id: paymentAttemptId,
            orderId,
            webhookEventId: "event-id",
          })
        );
        expect(enqueue).toHaveBeenCalledWith({
          orderId,
        });
        expect(markTerminalForReservation).not.toHaveBeenCalled();
      } else {
        expect(markTerminalForReservation).toHaveBeenCalledWith(
          expect.objectContaining({
            id: paymentAttemptId,
            orderId,
            state: "failed",
            failureCode: "nexi_payment_failed",
            webhookEventId: "event-id",
          })
        );
        expect(markPaidForReservation).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
      }
    });
  }

  test("returns the empty-order abandonment state and keeps orders with activity pending", async () => {
    const { ProviderPaymentDeferral, ProviderPaymentFinalizationService } =
      await import("./provider-payment-finalization.service");
    const { PaymentAttemptRepository } = await import(
      "../repositories/payment-attempt.repository"
    );
    const { PaidFulfillmentQueueService } = await import(
      "../fulfillment/paid-fulfillment-queue.service"
    );
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );
    const { NexiService } = await import("@deskohub/nexi");

    const providerOrderCreatedAt = pendingAttempt.providerOrderCreatedAt;
    const scenarios = [
      {
        name: "before cutoff",
        checkedAt: providerOrderCreatedAt.add({ minutes: 29 }),
        verification: emptyPendingVerification,
        expected: new ProviderPaymentDeferral({
          abandonmentCutoff: providerOrderCreatedAt.add({ minutes: 30 }),
        }),
      },
      {
        name: "at cutoff",
        checkedAt: providerOrderCreatedAt.add({ minutes: 30 }),
        verification: emptyPendingVerification,
        expected: "abandoned",
      },
      {
        name: "with an operation",
        checkedAt: providerOrderCreatedAt.add({ hours: 1 }),
        verification: {
          ...emptyPendingVerification,
          provider: {
            ...emptyPendingVerification.provider,
            operationCount: 1,
          },
        },
        expected: "pending",
      },
    ] satisfies ReadonlyArray<{
      name: string;
      checkedAt: Temporal.Instant;
      verification: NexiVerification;
      expected: ProviderPaymentFinalizationResult;
    }>;

    for (const scenario of scenarios) {
      const result = await Effect.gen(function* () {
        const service = yield* ProviderPaymentFinalizationService;
        return yield* service.finalizePendingProviderPayment({
          orderId,
          paymentAttemptId,
          abandonmentCheckedAt: scenario.checkedAt,
        });
      }).pipe(
        Effect.provide(
          ProviderPaymentFinalizationService.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(WorkspaceReservationRepository, {
                  findById: mock(() => Effect.succeed(pendingReservation)),
                }),
                paidFulfillmentLayer(),
                Layer.mock(PaidFulfillmentQueueService, {
                  enqueue: mock(() => Effect.die("not used")),
                }),
                Layer.mock(PaymentAttemptRepository, {
                  findById: mock(() => Effect.succeed(pendingAttempt)),
                }),
                paymentLifecycleLayer(),
                recordCheckoutAnalytics().layer,
                PaymentProvidersFromNexi.pipe(
                  Layer.provide(
                    Layer.mock(NexiService, {
                      verifyPaymentOutcome: mock(() =>
                        Effect.succeed(scenario.verification)
                      ),
                    })
                  )
                )
              ).pipe(withReservationPaymentHandlers)
            )
          )
        ),
        Effect.runPromise
      );

      expect(result, scenario.name).toEqual(scenario.expected);
    }
  });

  test("propagates lifecycle persistence failures instead of returning not_pending", async () => {
    const { ProviderPaymentFinalizationService } = await import(
      "./provider-payment-finalization.service"
    );
    const { PaymentAttemptRepository } = await import(
      "../repositories/payment-attempt.repository"
    );
    const { PaidFulfillmentQueueService } = await import(
      "../fulfillment/paid-fulfillment-queue.service"
    );
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );
    const { NexiService } = await import("@deskohub/nexi");
    const persistenceFailure = new EffectDrizzleQueryError({
      query: "payment lifecycle paid transition",
      params: [],
      cause: "database unavailable",
    });

    const result = await Effect.gen(function* () {
      const service = yield* ProviderPaymentFinalizationService;
      return yield* service.finalizePendingProviderPayment({
        orderId,
        paymentAttemptId,
      });
    }).pipe(
      Effect.provide(
        ProviderPaymentFinalizationService.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(pendingReservation)),
              }),
              paidFulfillmentLayer(),
              Layer.mock(PaidFulfillmentQueueService, {
                enqueue: mock(() => Effect.void),
              }),
              Layer.mock(PaymentAttemptRepository, {
                findById: mock(() => Effect.succeed(pendingAttempt)),
              }),
              paymentLifecycleLayer({
                markPaid: mock(() => Effect.fail(persistenceFailure)),
              }),
              recordCheckoutAnalytics().layer,
              PaymentProvidersFromNexi.pipe(
                Layer.provide(
                  Layer.mock(NexiService, {
                    verifyPaymentOutcome: mock(() =>
                      Effect.succeed(nexiVerificationFixture("success"))
                    ),
                  })
                )
              )
            ).pipe(withReservationPaymentHandlers)
          )
        )
      ),
      Effect.result,
      Effect.runPromise
    );

    expect(result).toMatchObject({ failure: persistenceFailure });
  });

  test("returns provider_verification_failed when Nexi verification errors", async () => {
    const { ProviderPaymentFinalizationService } = await import(
      "./provider-payment-finalization.service"
    );
    const { PaymentAttemptRepository } = await import(
      "../repositories/payment-attempt.repository"
    );
    const { PaidFulfillmentQueueService } = await import(
      "../fulfillment/paid-fulfillment-queue.service"
    );
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );
    const { NetworkError, NexiService } = await import("@deskohub/nexi");

    const markPaidForReservation = mock(() => Effect.die("not used"));
    const markTerminalForReservation = mock(() => Effect.die("not used"));
    const verifyPaymentOutcome = mock(() =>
      Effect.fail(new NetworkError({ message: "nexi down" }))
    );

    const result = await Effect.gen(function* () {
      const service = yield* ProviderPaymentFinalizationService;
      return yield* service.finalizePendingProviderPayment({
        orderId,
        paymentAttemptId,
      });
    }).pipe(
      Effect.provide(
        ProviderPaymentFinalizationService.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(pendingReservation)),
              }),
              paidFulfillmentLayer(),
              Layer.mock(PaidFulfillmentQueueService, {
                enqueue: mock(() => Effect.void),
              }),
              Layer.mock(PaymentAttemptRepository, {
                findById: mock(() => Effect.succeed(pendingAttempt)),
              }),
              paymentLifecycleLayer({
                markPaid: markPaidForReservation,
                markTerminal: markTerminalForReservation,
              }),
              recordCheckoutAnalytics().layer,
              PaymentProvidersFromNexi.pipe(
                Layer.provide(
                  Layer.mock(NexiService, {
                    verifyPaymentOutcome,
                  })
                )
              )
            ).pipe(withReservationPaymentHandlers)
          )
        )
      ),
      Effect.runPromise
    );

    expect(result).toBe("provider_verification_failed");
    expect(verifyPaymentOutcome).toHaveBeenCalledWith({
      orderId: providerOrderId,
      correlationId: "correlation-id",
      amount: "35000",
      currency: "EUR",
      securityToken: "security-token",
    });
    expect(markPaidForReservation).not.toHaveBeenCalled();
    expect(markTerminalForReservation).not.toHaveBeenCalled();
  });
});

describe("ProviderPaymentFinalizationService unattached provider sessions", () => {
  // Hosted payment page creation timed out or failed ambiguously: the attempt
  // never received a hosted page or security token, so no customer could
  // have been sent to pay it.
  const afterCutoff = attemptCreatedAt.add({ minutes: 30 });

  const finalizeUnattached = async (input: {
    readonly abandonmentCheckedAt?: Temporal.Instant;
    readonly getOrder?: ReturnType<typeof mock<NexiServiceType["getOrder"]>>;
    readonly markTerminal?: ReturnType<
      typeof mock<IPaymentLifecycleRepository["markTerminal"]>
    >;
  }) => {
    const { ProviderPaymentFinalizationService } = await import(
      "./provider-payment-finalization.service"
    );
    const { PaymentAttemptRepository } = await import(
      "../repositories/payment-attempt.repository"
    );
    const { PaidFulfillmentQueueService } = await import(
      "../fulfillment/paid-fulfillment-queue.service"
    );
    const { WorkspaceReservationRepository } = await import(
      "@/features/reservation/backend/workspace-reservation.repository"
    );
    const { recordCheckoutAnalytics } = await import(
      "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
    );
    const { NexiService } = await import("@deskohub/nexi");

    const getOrder =
      input.getOrder ??
      mock(() => Effect.succeed({ orderId: providerOrderId, operations: [] }));
    const markTerminal =
      input.markTerminal ??
      mock(() =>
        Effect.succeed({
          attempt: { ...unattachedAttempt, state: "failed" as const },
          changed: true,
          timestamp: afterCutoff,
        })
      );
    const verifyPaymentOutcome = mock(() => Effect.die("not used"));

    const result = await Effect.gen(function* () {
      const service = yield* ProviderPaymentFinalizationService;
      return yield* service.finalizePendingProviderPayment({
        orderId,
        paymentAttemptId,
        ...(input.abandonmentCheckedAt && {
          abandonmentCheckedAt: input.abandonmentCheckedAt,
        }),
      });
    }).pipe(
      Effect.provide(
        ProviderPaymentFinalizationService.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(pendingReservation)),
              }),
              paidFulfillmentLayer(),
              Layer.mock(PaidFulfillmentQueueService, {
                enqueue: mock(() => Effect.die("not used")),
              }),
              Layer.mock(PaymentAttemptRepository, {
                findById: mock(() => Effect.succeed(unattachedAttempt)),
              }),
              paymentLifecycleLayer({ markTerminal }),
              recordCheckoutAnalytics().layer,
              PaymentProvidersFromNexi.pipe(
                Layer.provide(
                  Layer.mock(NexiService, { getOrder, verifyPaymentOutcome })
                )
              )
            ).pipe(withReservationPaymentHandlers)
          )
        )
      ),
      Effect.runPromise
    );

    return { result, getOrder, markTerminal, verifyPaymentOutcome };
  };

  test("leaves an unattached attempt unresolved outside hold cleanup", async () => {
    const { result, getOrder, markTerminal } = await finalizeUnattached({});

    expect(result).toBe("not_verifiable");
    expect(getOrder).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();
  });

  test("defers an unattached attempt until the abandonment cutoff", async () => {
    const { result, getOrder, markTerminal } = await finalizeUnattached({
      abandonmentCheckedAt: attemptCreatedAt.add({ minutes: 29, seconds: 59 }),
    });

    const { ProviderPaymentDeferral } = await import(
      "./provider-payment-finalization.service"
    );
    expect(result).toEqual(
      new ProviderPaymentDeferral({ abandonmentCutoff: afterCutoff })
    );
    expect(getOrder).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();
  });

  test("fails an unattached attempt whose provider order was never created", async () => {
    const { ExternalAPIError } = await import("@deskohub/nexi");
    const { result, getOrder, markTerminal } = await finalizeUnattached({
      abandonmentCheckedAt: afterCutoff,
      getOrder: mock(() =>
        Effect.fail(
          new ExternalAPIError({
            service: "Nexi",
            operation: "Get order",
            statusCode: 404,
          })
        )
      ),
    });

    expect(result).toBe("terminal");
    expect(getOrder).toHaveBeenCalledWith({
      orderId: providerOrderId,
      correlationId: "correlation-id",
    });
    expect(markTerminal).toHaveBeenCalledWith({
      id: paymentAttemptId,
      orderId,
      state: "failed",
      failureCode: "nexi_hpp_create_unconfirmed",
      providerStatus: "hpp_create_unconfirmed",
      fromAttemptStates: ["created"],
    });
  });

  test("fails an unattached attempt whose provider order has no payment activity", async () => {
    const { result, markTerminal } = await finalizeUnattached({
      abandonmentCheckedAt: afterCutoff,
      getOrder: mock(() =>
        Effect.succeed({
          orderId: providerOrderId,
          authorizedAmount: "0",
          capturedAmount: "0",
          operations: [],
        })
      ),
    });

    expect(result).toBe("terminal");
    expect(markTerminal).toHaveBeenCalledTimes(1);
  });

  test("keeps an unattached attempt for review when its provider order shows payment activity", async () => {
    const { result, markTerminal } = await finalizeUnattached({
      abandonmentCheckedAt: afterCutoff,
      getOrder: mock(() =>
        Effect.succeed({
          orderId: providerOrderId,
          operations: [{ operationType: "AUTHORIZATION" }],
        })
      ),
    });

    expect(result).toBe("not_verifiable");
    expect(markTerminal).not.toHaveBeenCalled();
  });

  test("keeps an unattached attempt when the provider lookup is inconclusive", async () => {
    const { NetworkError } = await import("@deskohub/nexi");
    const { result, markTerminal } = await finalizeUnattached({
      abandonmentCheckedAt: afterCutoff,
      getOrder: mock(() =>
        Effect.fail(new NetworkError({ message: "Failed to connect to Nexi" }))
      ),
    });

    expect(result).toBe("provider_verification_failed");
    expect(markTerminal).not.toHaveBeenCalled();
  });

  test("yields to a provider session attached concurrently", async () => {
    const { PaymentLifecycleStateError } = await import(
      "../repositories/payment-lifecycle-state"
    );
    const { result } = await finalizeUnattached({
      abandonmentCheckedAt: afterCutoff,
      markTerminal: mock(() =>
        Effect.fail(
          new PaymentLifecycleStateError({
            operation: "markTerminal",
            paymentReference: {
              type: "paymentAttemptId",
              id: paymentAttemptId,
            },
            message: "Only a created attempt can fail an unattached session.",
          })
        )
      ),
    });

    expect(result).toBe("not_pending");
  });
});
