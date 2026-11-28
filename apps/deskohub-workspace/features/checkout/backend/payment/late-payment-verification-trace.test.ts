import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { NetworkError, NexiService } from "@deskohub/nexi";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, type Duration, Effect, Exit, Layer, Predicate } from "effect";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { unavailableQueue } from "@/shared/backend/queue/memory-queue.test-utils";
import {
  type EffectTrace,
  recordEffectTrace,
  startEffectTrace,
} from "@/shared/testing/effect-trace.test-utils";
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

interface Collaborators {
  readonly reservations: Pick<
    WorkspaceReservationRepository["Service"],
    "findById"
  >;
  readonly paymentAttempts: Pick<
    PaymentAttemptRepository["Service"],
    "findById"
  >;
  readonly recoveries: Pick<
    LatePaymentRecoveryRepository["Service"],
    "findByPaymentAttemptId" | "start"
  >;
  readonly recoveryQueue: Layer.Layer<LatePaymentRecoveryQueueService>;
  readonly nexi: Pick<NexiService["Service"], "verifyPaymentOutcome">;
}

const succeed =
  <A>(value: A) =>
  () =>
    Effect.succeed(value);

const databaseUnavailable = new EffectDrizzleQueryError({
  query: "late payment verification",
  params: [],
  cause: new Error("db down"),
});

const minutesAgo = (minutes: number) =>
  Temporal.Now.instant().subtract({ minutes });

/** Collaborators of a verification that reaches Nexi and starts recovery. */
const settledCollaborators = (
  overrides: Partial<Omit<Collaborators, "recoveries">> & {
    readonly recoveries?: Partial<Collaborators["recoveries"]>;
  } = {}
): Collaborators => ({
  reservations: { findById: succeed(expiredReservation) },
  paymentAttempts: { findById: succeed(expiredAttempt) },
  recoveryQueue: Layer.mock(LatePaymentRecoveryQueueService, {
    enqueue: () => Effect.void,
  }),
  nexi: { verifyPaymentOutcome: succeed(verification("success")) },
  ...overrides,
  recoveries: {
    findByPaymentAttemptId: succeed(null),
    start: (input) => Effect.succeed(recoveryFixture(input)),
    ...overrides.recoveries,
  },
});

/** The success value, or the failure's message. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.squash(exit.cause);
  return Predicate.hasProperty(failure, "message") ? failure.message : failure;
};

const startRecoveryIfSettled = async (
  collaborators: Collaborators,
  input: { readonly verificationDeadline?: Duration.Input } = {}
) => {
  const trace: EffectTrace = startEffectTrace();
  const exit = await Effect.gen(function* () {
    const service = yield* LatePaymentVerificationService;
    return yield* recordEffectTrace(
      trace,
      service.startRecoveryIfSettled({
        orderId,
        ...input,
      })
    );
  }).pipe(
    Effect.provide(
      LatePaymentVerificationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(
              WorkspaceReservationRepository,
              trace.recordCalls("reservations", collaborators.reservations)
            ),
            Layer.mock(
              PaymentAttemptRepository,
              trace.recordCalls(
                "paymentAttempts",
                collaborators.paymentAttempts
              )
            ),
            Layer.mock(
              LatePaymentRecoveryRepository,
              trace.recordCalls("recoveries", collaborators.recoveries)
            ),
            Layer.effect(
              LatePaymentRecoveryQueueService,
              Effect.map(LatePaymentRecoveryQueueService, ({ enqueue }) =>
                trace.recordCalls("recoveryQueue", { enqueue })
              )
            ).pipe(Layer.provide(collaborators.recoveryQueue)),
            PaymentProvidersFromNexi.pipe(
              Layer.provide(
                Layer.mock(
                  NexiService,
                  trace.recordCalls("nexi", collaborators.nexi)
                )
              )
            )
          ).pipe(withReservationPaymentHandlers)
        )
      )
    ),
    Effect.runPromise
  );
  return { outcome: outcomeOf(exit), trace: trace.entries };
};

describe("LatePaymentVerificationService.startRecoveryIfSettled trace", () => {
  test("reports not verifiable when the reservation can't be loaded", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        reservations: { findById: () => Effect.fail(databaseUnavailable) },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "Error Late-payment verification failed (cause=<EffectDrizzleQueryError>) {orderId} in latePaymentVerification.startRecoveryIfSettled",
      ]
    `);
  });

  test("ignores a missing reservation", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({ reservations: { findById: succeed(null) } })
    );

    expect(outcome).toBe("not_applicable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
      ]
    `);
  });

  test("ignores a reservation without an active payment attempt", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        reservations: {
          findById: succeed({
            ...expiredReservation,
            activePaymentAttemptId: null,
          }),
        },
      })
    );

    expect(outcome).toBe("not_applicable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
      ]
    `);
  });

  test("ignores a reservation whose payment isn't terminal", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        reservations: {
          findById: succeed({ ...expiredReservation, paymentState: "paid" }),
        },
      })
    );

    expect(outcome).toBe("not_applicable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
      ]
    `);
  });

  for (const paymentState of ["failed", "cancelled"] as const) {
    test(`verifies a ${paymentState} reservation`, async () => {
      const { outcome } = await startRecoveryIfSettled(
        settledCollaborators({
          reservations: {
            findById: succeed({ ...expiredReservation, paymentState }),
          },
          paymentAttempts: {
            findById: succeed({ ...expiredAttempt, state: paymentState }),
          },
        })
      );

      expect(outcome).toBe("recovery_started");
    });
  }

  test("re-enqueues a stalled pending recovery", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        recoveries: {
          findByPaymentAttemptId: succeed(
            recoveryFixture({
              state: "pending",
              createdAt: minutesAgo(5),
            })
          ),
        },
      })
    );

    expect(outcome).toBe("recovery_started");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call recoveryQueue.enqueue(paymentAttemptId=attempt-id)",
      ]
    `);
  });

  test("leaves a recent pending recovery to its queue message", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        recoveries: {
          findByPaymentAttemptId: succeed(recoveryFixture()),
        },
      })
    );

    expect(outcome).toBe("recovery_started");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
      ]
    `);
  });

  test("leaves an old recovery that is no longer pending alone", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        recoveries: {
          findByPaymentAttemptId: succeed(
            recoveryFixture({
              state: "processing",
              createdAt: minutesAgo(5),
            })
          ),
        },
      })
    );

    expect(outcome).toBe("recovery_started");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
      ]
    `);
  });

  test("reports not verifiable when the stalled recovery can't be enqueued", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        recoveries: {
          findByPaymentAttemptId: succeed(
            recoveryFixture({
              state: "pending",
              createdAt: minutesAgo(5),
            })
          ),
        },
        recoveryQueue: LatePaymentRecoveryQueueService.Default.pipe(
          Layer.provide(unavailableQueue())
        ),
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call recoveryQueue.enqueue(paymentAttemptId=attempt-id)",
        "span latePaymentRecoveryQueue.enqueue",
        "Error Late-payment verification failed (cause=<LatePaymentRecoveryQueueError>) {orderId} in latePaymentVerification.startRecoveryIfSettled",
      ]
    `);
  });

  test("reports not verifiable for a missing payment attempt", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({ paymentAttempts: { findById: succeed(null) } })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
      ]
    `);
  });

  test("reports not verifiable for a non-Nexi payment attempt", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        paymentAttempts: {
          findById: succeed({ ...expiredAttempt, providerOrderId: null }),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
      ]
    `);
  });

  test("reports not verifiable for an attempt without a security token", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        paymentAttempts: {
          findById: succeed({ ...expiredAttempt, securityToken: null }),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
      ]
    `);
  });

  test("reports not verifiable for an attempt that isn't terminal", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        paymentAttempts: {
          findById: succeed({ ...expiredAttempt, state: "pending" }),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
      ]
    `);
  });

  test("reports not verifiable for an attempt with an invalid currency", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        paymentAttempts: {
          findById: succeed({
            ...expiredAttempt,
            amount: { ...expiredAttempt.amount, currency: "XXX" },
          }),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
        "span NexiPaymentProvider.verify",
        "Error Late-payment verification failed (cause=<PaymentProviderError>) {orderId} in latePaymentVerification.startRecoveryIfSettled",
      ]
    `);
  });

  test("reports a failed provider lookup", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        nexi: {
          verifyPaymentOutcome: () =>
            Effect.fail(new NetworkError({ message: "nexi down" })),
        },
      }),
      { verificationDeadline: "5 seconds" }
    );

    expect(outcome).toBe("provider_verification_failed");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=29000, currency=EUR, securityToken=security-token, deadline=5 seconds)",
        "Warn Late-payment verification provider lookup failed (cause=<PaymentProviderError>) {orderId} in latePaymentVerification.startRecoveryIfSettled",
      ]
    `);
  });

  test("reports a provider verification mismatch", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        nexi: {
          verifyPaymentOutcome: succeed(verification("success", ["amount"])),
        },
      })
    );

    expect(outcome).toBe("verification_mismatch");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=29000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Warn Late-payment verification provider facts mismatch (mismatches=<Array>) {orderId} in latePaymentVerification.startRecoveryIfSettled",
      ]
    `);
  });

  test("reports an unsettled provider payment", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        nexi: { verifyPaymentOutcome: succeed(verification("failure")) },
      })
    );

    expect(outcome).toBe("not_settled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=29000, currency=EUR, securityToken=security-token, deadline=undefined)",
      ]
    `);
  });

  test("starts and enqueues recovery for a settled provider payment", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators(),
      { verificationDeadline: "5 seconds" }
    );

    expect(outcome).toBe("recovery_started");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=29000, currency=EUR, securityToken=security-token, deadline=5 seconds)",
        "Warn Provider payment settled after the local payment attempt became terminal {orderId} in latePaymentVerification.startRecoveryIfSettled",
        "call recoveries.start(paymentAttemptId=attempt-id, workspaceReservationId=018f0b50-0000-7000-8000-000000000001, providerOperationId=operation-id, providerStatus=EXECUTED, verifiedPaidAt=<Instant>)",
        "call recoveryQueue.enqueue(paymentAttemptId=attempt-id)",
      ]
    `);
  });

  test("reports not verifiable when recovery can't be started", async () => {
    const { outcome, trace } = await startRecoveryIfSettled(
      settledCollaborators({
        recoveries: {
          start: () => Effect.fail(databaseUnavailable),
        },
      })
    );

    expect(outcome).toBe("not_verifiable");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span latePaymentVerification.startRecoveryIfSettled",
        "call reservations.findById(018f0b50-0000-7000-8000-000000000001)",
        "call recoveries.findByPaymentAttemptId(attempt-id)",
        "call paymentAttempts.findById(attempt-id)",
        "span NexiPaymentProvider.verify",
        "call nexi.verifyPaymentOutcome(orderId=provider-order-id, correlationId=correlation-id, amount=29000, currency=EUR, securityToken=security-token, deadline=undefined)",
        "Warn Provider payment settled after the local payment attempt became terminal {orderId} in latePaymentVerification.startRecoveryIfSettled",
        "call recoveries.start(paymentAttemptId=attempt-id, workspaceReservationId=018f0b50-0000-7000-8000-000000000001, providerOperationId=operation-id, providerStatus=EXECUTED, verifiedPaidAt=<Instant>)",
        "Error Late-payment verification failed (cause=<EffectDrizzleQueryError>) {orderId} in latePaymentVerification.startRecoveryIfSettled",
      ]
    `);
  });
});
