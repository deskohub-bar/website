import { PaymentProvidersFromNexi } from "../payment/payment-providers";
import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  NetworkError,
  NexiCorrelationIdSchema,
  type NexiOrder,
  NexiOrderIdSchema,
  NexiService,
} from "@deskohub/nexi";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  type PaymentPageProviderObservation,
  PaymentPageProviderStatus,
} from "./payment-page-provider-status";

const reservation = {
  correlationId: NexiCorrelationIdSchema.make("correlation-id"),
};
const providerOrderId = NexiOrderIdSchema.make("provider-order-id");

const observeWith = (
  getOrder: NexiService["Service"]["getOrder"],
  orderId: string | null = providerOrderId
) =>
  PaymentPageProviderStatus.pipe(
    Effect.flatMap((status) =>
      status.observe({
        attempt: { provider: "nexi", providerOrderId: orderId },
        reservation,
      })
    ),
    Effect.provide(
      PaymentPageProviderStatus.Default.pipe(
        Layer.provide(
          PaymentProvidersFromNexi.pipe(
            Layer.provide(Layer.mock(NexiService, { getOrder }))
          )
        )
      )
    )
  );

const order = (overrides: Partial<NexiOrder> = {}): NexiOrder => ({
  orderId: providerOrderId,
  operations: [],
  ...overrides,
});

describe("PaymentPageProviderStatus.observe", () => {
  test.each<
    readonly [string, Partial<NexiOrder>, PaymentPageProviderObservation]
  >([
    ["an order without operations or amounts", {}, "no_activity"],
    [
      "an order with zero amounts",
      { authorizedAmount: "0", capturedAmount: "0" },
      "no_activity",
    ],
    [
      "an order Nexi cancelled",
      {
        operations: [
          { operationType: "AUTHORIZATION", operationResult: "CANCELED" },
        ],
      },
      "activity",
    ],
    [
      "an order with an authorized amount",
      { authorizedAmount: "100" },
      "activity",
    ],
  ])("reads %s as %s", async (_label, overrides, expected) => {
    const getOrder = mock(() => Effect.succeed(order(overrides)));

    expect(await Effect.runPromise(observeWith(getOrder))).toBe(expected);
    expect(getOrder).toHaveBeenCalledWith({
      orderId: "provider-order-id",
      correlationId: "correlation-id",
    });
  });

  test("reads a failed lookup as unknown", async () => {
    const getOrder = mock(() =>
      Effect.fail(new NetworkError({ message: "nexi down" }))
    );

    expect(await Effect.runPromise(observeWith(getOrder))).toBe("unknown");
  });

  test("reads a lookup that outlasts one request as unknown", async () => {
    const getOrder = mock(() => Effect.never);

    const observation = await Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(observeWith(getOrder));
      yield* TestClock.adjust("1 minute");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

    expect(observation).toBe("unknown");
  });

  test("asks nothing for an attempt without a provider order", async () => {
    const getOrder = mock(() => Effect.succeed(order()));

    const observation = await Effect.runPromise(observeWith(getOrder, null));

    expect(observation).toBe("unknown");
    expect(getOrder).not.toHaveBeenCalled();
  });
});
