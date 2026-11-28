import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import { NexiService } from "@deskohub/nexi";
import { Effect, Layer } from "effect";
import type { LatePaymentRecoveryState, PaymentState } from "@/db/schema";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import { PaymentAttemptRepository } from "../repositories/payment-attempt.repository";
import { LatePaymentRecoveryQueueService } from "./late-payment-recovery-queue.service";
import { LatePaymentVerificationService } from "./late-payment-verification.service";
import {
  expiredAttempt,
  expiredReservation,
  orderId,
  recoveryFixture,
  verification,
} from "./late-payment-verification.test-utils";
import { withReservationPaymentHandlers } from "./order-payment-handlers.test-utils";
import { PaymentProvidersFromNexi } from "./payment-providers";

const makeHarness = (options: {
  readonly paymentState?: PaymentState;
  readonly existingRecoveryState?: LatePaymentRecoveryState;
  readonly verification?: ReturnType<typeof verification>;
}) => {
  const spies = {
    start: mock<LatePaymentRecoveryRepository["Service"]["start"]>((input) =>
      Effect.succeed(recoveryFixture(input))
    ),
    enqueue: mock<LatePaymentRecoveryQueueService["Service"]["enqueue"]>(
      () => Effect.void
    ),
    verifyPaymentOutcome: mock<NexiService["Service"]["verifyPaymentOutcome"]>(
      () => Effect.succeed(options.verification ?? verification("success"))
    ),
  };
  const layer = LatePaymentVerificationService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceReservationRepository, {
          findById: () =>
            Effect.succeed({
              ...expiredReservation,
              paymentState:
                options.paymentState ?? expiredReservation.paymentState,
            }),
        }),
        Layer.mock(PaymentAttemptRepository, {
          findById: () => Effect.succeed(expiredAttempt),
        }),
        Layer.mock(LatePaymentRecoveryRepository, {
          findByPaymentAttemptId: () =>
            Effect.succeed(
              options.existingRecoveryState
                ? recoveryFixture({ state: options.existingRecoveryState })
                : null
            ),
          start: spies.start,
        }),
        Layer.mock(LatePaymentRecoveryQueueService, {
          enqueue: spies.enqueue,
        }),
        PaymentProvidersFromNexi.pipe(
          Layer.provide(
            Layer.mock(NexiService, {
              verifyPaymentOutcome: spies.verifyPaymentOutcome,
            })
          )
        )
      ).pipe(withReservationPaymentHandlers)
    )
  );
  const run = () =>
    Effect.gen(function* () {
      const service = yield* LatePaymentVerificationService;
      return yield* service.startRecoveryIfSettled({ orderId });
    }).pipe(Effect.provide(layer), Effect.runPromise);
  return { run, spies };
};

describe("LatePaymentVerificationService", () => {
  test("starts recovery when Nexi reports a locally expired attempt as paid", async () => {
    const harness = makeHarness({});

    const result = await harness.run();

    expect(result).toBe("recovery_started");
    expect(harness.spies.verifyPaymentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "provider-order-id",
        correlationId: "correlation-id",
        amount: "29000",
        securityToken: "security-token",
      })
    );
    expect(harness.spies.start).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAttemptId: "attempt-id",
        workspaceReservationId: orderId,
        providerOperationId: "operation-id",
        providerStatus: "EXECUTED",
      })
    );
    expect(harness.spies.start.mock.calls[0]?.[0]).not.toHaveProperty(
      "webhookEventId"
    );
    expect(harness.spies.enqueue).toHaveBeenCalledWith({
      paymentAttemptId: "attempt-id",
    });
  });

  test("a Nexi decline with zero funds does not establish that the session is closed", async () => {
    const declined = verification("failure");
    const harness = makeHarness({
      verification: {
        ...declined,
        provider: {
          ...declined.provider,
          authorizedAmount: "0",
          capturedAmount: "0",
        },
      },
    });

    expect(await harness.run()).toBe("not_settled");
    expect(harness.spies.start).not.toHaveBeenCalled();
    expect(harness.spies.enqueue).not.toHaveBeenCalled();
  });

  test("does not authorize retry when Nexi still reports authorized funds", async () => {
    const declined = verification("failure");
    const harness = makeHarness({
      verification: {
        ...declined,
        provider: { ...declined.provider, authorizedAmount: "29000" },
      },
    });
    expect(await harness.run()).toBe("not_settled");
  });

  test("does not start recovery from a mismatching provider verification", async () => {
    const harness = makeHarness({
      verification: verification("success", ["amount"]),
    });

    expect(await harness.run()).toBe("verification_mismatch");
    expect(harness.spies.start).not.toHaveBeenCalled();
  });

  test("does not query Nexi again once recovery has started", async () => {
    const harness = makeHarness({ existingRecoveryState: "processing" });

    expect(await harness.run()).toBe("recovery_started");
    expect(harness.spies.verifyPaymentOutcome).not.toHaveBeenCalled();
    expect(harness.spies.start).not.toHaveBeenCalled();
  });

  for (const paymentState of ["not_started", "pending", "paid"] as const) {
    test(`ignores a ${paymentState} reservation`, async () => {
      const harness = makeHarness({ paymentState });

      expect(await harness.run()).toBe("not_applicable");
      expect(harness.spies.verifyPaymentOutcome).not.toHaveBeenCalled();
    });
  }
});
