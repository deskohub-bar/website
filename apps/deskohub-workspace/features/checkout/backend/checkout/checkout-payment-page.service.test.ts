import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import { DotyposReservationIdSchema } from "@deskohub/dotypos";
import { type Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { LatePaymentRecovery } from "@/db/schema";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import {
  type IReservationAuthorizationService,
  ReservationAuthorizationService,
  ReservationAuthorizationUnavailableError,
} from "@/features/reservation/backend/reservation-authorization.service";
import { WorkspaceReservationDetailsMalformedError } from "@/features/reservation/backend/stored-reservation-details.server";
import {
  type WorkspaceReservation,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import {
  type PaymentAttempt,
  PaymentAttemptRepository,
} from "../repositories/payment-attempt.repository";
import { paymentAbandonedAfterProviderCutoffFailureCode } from "../repositories/payment-lifecycle-state";
import {
  CheckoutPaymentPageService,
  type PaymentPageReopeningInput,
} from "./checkout-payment-page.service";
import type { PaymentPageProviderObservation } from "./payment-page-provider-status";
import {
  observePaymentPagesAs,
  testReservationPaymentWindow,
} from "./payment-page-provider-status.test-utils";

import {
  checkoutDotyposReservationId,
  latePaymentRecoveryFixture,
  paymentAttemptWithPageFixture,
} from "./testing/checkout-payment-fixture";

const instant = (value: string) => Temporal.Instant.from(value);

const providerOrderCreatedAt = instant("2026-06-01T10:00:00Z");
const providerRedirectUrl = "https://sandbox.example/hpp/order-page";

const input: PaymentPageReopeningInput = {
  orderId: workspaceReservationIdSchema.make(
    "0198c1a2-c6ac-7bc9-83a6-7a5f8af36183"
  ),
  locale: "cs-CZ",
  accessCookie: "access-cookie",
};
const attemptId = paymentAttemptIdSchema.make("attempt-reopen");
const reservationCreatedAt = instant("2026-06-01T09:52:00Z");

const makeReservation = (overrides: Partial<WorkspaceReservation> = {}) =>
  workspaceReservationFixture({
    id: input.orderId,
    dotyposReservationId: checkoutDotyposReservationId,
    reservationState: "held",
    // The ten-minute hold from 09:52 expired; the pending provider order
    // keeps it held.
    reservationHoldExpiresAt: instant("2026-06-01T10:02:00Z"),
    paymentState: "pending",
    fulfillmentState: "not_started",
    activePaymentAttemptId: attemptId,
    reservationCreatedAt,
    reservationConfirmedAt: null,
    paidAt: null,
    fulfilledAt: null,
    createdAt: reservationCreatedAt,
    updatedAt: providerOrderCreatedAt,
    ...overrides,
  });

const makeAttempt = (
  overrides: Partial<Parameters<typeof paymentAttemptWithPageFixture>[0]> = {}
) =>
  paymentAttemptWithPageFixture({
    id: attemptId,
    reservationId: input.orderId,
    providerRedirectUrl,
    providerOrderCreatedAt,
    createdAt: instant("2026-06-01T09:59:58Z"),
    updatedAt: providerOrderCreatedAt,
    ...overrides,
  });

const recoveredDotyposReservationId =
  DotyposReservationIdSchema.make("dotypos-recovered");
const attemptExpiredAt = providerOrderCreatedAt.add({ hours: 1 });
const recoveryVerifiedAt = attemptExpiredAt.add({ minutes: 1 });
const lateRecovery = (state: "pending" | "recovered") =>
  latePaymentRecoveryFixture({
    paymentAttemptId: attemptId,
    workspaceReservationId: input.orderId,
    originalDotyposReservationId: checkoutDotyposReservationId,
    verifiedPaidAt: recoveryVerifiedAt,
    ...(state === "recovered"
      ? {
          state,
          recoveredDotyposReservationId,
        }
      : { state }),
  });

type Harness = {
  /** The authorization's answer, or `"unavailable"` when its read fails. */
  readonly authorized?: boolean | "unavailable";
  readonly reservation?: WorkspaceReservation | null;
  readonly attempt?: PaymentAttempt | null;
  readonly latePaymentRecovery?: LatePaymentRecovery | null;
  readonly now?: Temporal.Instant;
  readonly sharedWindowExpiresAt?: Temporal.Instant;
  /** What the provider's order shows; it can't be asked by default. */
  readonly observation?: PaymentPageProviderObservation;
  /** How long the provider takes to answer, on the test clock. */
  readonly providerAnswersAfter?: Duration.Input;
};

/**
 * The service over fakes that record every call. It is given no payment
 * lifecycle or Nexi, and its reservation repository writes only the return
 * target, so reopening can't create an attempt or call the provider.
 */
const createHarness = (harness: Harness = {}) => {
  const authorize = mock<IReservationAuthorizationService["authorize"]>(() =>
    harness.authorized === "unavailable"
      ? Effect.fail(
          new ReservationAuthorizationUnavailableError({
            orderId: input.orderId,
            cause: new WorkspaceReservationDetailsMalformedError({
              reservationId: input.orderId,
              message: "read failed",
              cause: new Error("read failed"),
            }),
          })
        )
      : Effect.succeed(harness.authorized ?? true)
  );
  const recordPaymentReturnTarget = mock<
    WorkspaceReservationRepository["Service"]["recordPaymentReturnTarget"]
  >(() => Effect.void);
  const findReservation = mock(() =>
    Effect.succeed(
      harness.reservation === undefined
        ? makeReservation()
        : harness.reservation
    )
  );
  const findAttempt = mock(() =>
    Effect.succeed(
      harness.attempt === undefined ? makeAttempt() : harness.attempt
    )
  );
  const findLatePaymentRecovery = mock(() =>
    Effect.succeed(harness.latePaymentRecovery ?? null)
  );
  const provider = observePaymentPagesAs(harness.observation ?? "unknown", {
    answersAfter: harness.providerAnswersAfter,
  });
  const layer = CheckoutPaymentPageService.Default.pipe(
    Layer.provide(provider.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ReservationAuthorizationService, {
          isAuthorized: () =>
            Effect.die("reopening must report a failed read, not deny"),
          authorize,
        }),
        Layer.mock(WorkspaceReservationRepository, {
          findById: findReservation,
          recordPaymentReturnTarget,
        }),
        Layer.mock(PaymentAttemptRepository, { findById: findAttempt }),
        testReservationPaymentWindow(harness.sharedWindowExpiresAt),
        Layer.mock(LatePaymentRecoveryRepository, {
          findLatestByWorkspaceReservationId: findLatePaymentRecovery,
        })
      )
    )
  );
  const reopen = (overrides: Partial<PaymentPageReopeningInput> = {}) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(
          (harness.now ?? instant("2026-06-01T10:03:00Z")).epochMilliseconds
        );
        const service = yield* CheckoutPaymentPageService;
        return yield* service.reopen({ ...input, ...overrides });
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())))
    );

  return {
    observeProvider: provider.observe,
    findAttempt,
    findLatePaymentRecovery,
    findReservation,
    authorize,
    recordPaymentReturnTarget,
    reopen,
  };
};

describe("CheckoutPaymentPageService.reopen", () => {
  test.each(["2026-06-01T10:03:59Z", "2026-06-01T10:04:00Z"])(
    "denies legacy access-cookie reopening for a shared window at %s",
    async (now) => {
      const harness = createHarness({
        now: instant(now),
        observation: "no_activity",
        sharedWindowExpiresAt: instant("2026-06-01T10:04:00Z"),
      });

      expect(await harness.reopen()).toEqual({
        state: "closed",
        reason: "window_elapsed",
      });
      expect(harness.observeProvider).not.toHaveBeenCalled();
      expect(harness.recordPaymentReturnTarget).not.toHaveBeenCalled();
    }
  );

  test("opens the stored payment page again, the same page each time, past the hold's own expiry", async () => {
    const harness = createHarness();

    const first = await harness.reopen();
    const second = await harness.reopen();

    expect(first).toEqual({ state: "opened", providerRedirectUrl });
    expect(second).toEqual(first);
    expect(harness.authorize).toHaveBeenCalledWith({
      accessCookie: input.accessCookie,
      locale: input.locale,
      orderId: input.orderId,
      permission: "open-payment-page",
    });
    expect(harness.findAttempt).toHaveBeenCalledWith("attempt-reopen");
  });

  test("records where the reopened page's payment returns, as the request asks", async () => {
    const harness = createHarness();

    await harness.reopen({ returnTarget: "native-app" });
    await harness.reopen();

    expect(harness.recordPaymentReturnTarget.mock.calls).toEqual([
      [
        {
          id: input.orderId,
          paymentReturnTarget: "native-app",
        },
      ],
      [
        {
          id: input.orderId,
          paymentReturnTarget: undefined,
        },
      ],
    ]);
  });

  test("records no return for a page it doesn't open", async () => {
    const harness = createHarness({ now: instant("2026-06-01T10:06:00Z") });

    await harness.reopen({ returnTarget: "native-app" });

    expect(harness.recordPaymentReturnTarget).not.toHaveBeenCalled();
  });

  test("fails without reading the order when whether the visitor may open it can't be read", async () => {
    const harness = createHarness({ authorized: "unavailable" });

    await expect(harness.reopen()).rejects.toMatchObject({
      _tag: "ReservationAuthorizationUnavailableError",
    });
    expect(harness.findReservation).not.toHaveBeenCalled();
  });

  test("opens a page stored on a created attempt", async () => {
    const harness = createHarness({
      attempt: makeAttempt({ state: "created" }),
    });

    expect(await harness.reopen()).toEqual({
      state: "opened",
      providerRedirectUrl,
    });
  });

  test("opens the page past the provisional window while the provider's order shows no activity", async () => {
    const harness = createHarness({
      observation: "no_activity",
      now: instant("2026-06-01T10:20:00Z"),
    });

    expect(await harness.reopen()).toEqual({
      state: "opened",
      providerRedirectUrl,
    });
    expect(harness.observeProvider).toHaveBeenCalledWith({
      attempt: makeAttempt(),
      reservation: makeReservation(),
    });
  });

  test("closes the page once the provider's order shows activity, even inside the provisional window", async () => {
    const harness = createHarness({
      observation: "activity",
      now: instant("2026-06-01T10:01:00Z"),
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "window_elapsed",
    });
    expect(harness.recordPaymentReturnTarget).not.toHaveBeenCalled();
  });

  test("closes the page when the abandonment cutoff passes while the provider answers", async () => {
    const harness = createHarness({
      observation: "no_activity",
      now: instant("2026-06-01T10:29:59Z"),
      providerAnswersAfter: "2 seconds",
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "window_elapsed",
    });
    expect(harness.observeProvider).toHaveBeenCalledTimes(1);
    expect(harness.recordPaymentReturnTarget).not.toHaveBeenCalled();
  });

  test("closes the page at the abandonment cutoff without asking the provider", async () => {
    const harness = createHarness({
      observation: "no_activity",
      now: instant("2026-06-01T10:30:00Z"),
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "window_elapsed",
    });
    expect(harness.observeProvider).not.toHaveBeenCalled();
  });

  test("asks the provider about no attempt without a stored page", async () => {
    const harness = createHarness({
      observation: "no_activity",
      attempt: makeAttempt({ state: "failed" }),
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "no_active_attempt",
    });
    expect(harness.observeProvider).not.toHaveBeenCalled();
  });

  test("opens the page until just before its reopening window ends while the provider can't be asked", async () => {
    const harness = createHarness({ now: instant("2026-06-01T10:05:59Z") });

    expect((await harness.reopen()).state).toBe("opened");
  });

  test("closes the page once its reopening window ends while the provider can't be asked, well inside the abandonment window", async () => {
    const harness = createHarness({ now: instant("2026-06-01T10:06:00Z") });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "window_elapsed",
    });
  });

  test("counts the window from the attempt's creation when the provider order's creation time was not stored", async () => {
    const harness = createHarness({
      attempt: makeAttempt({ providerOrderCreatedAt: null }),
      now: instant("2026-06-01T10:05:59Z"),
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "window_elapsed",
    });
  });

  test("answers not found without reading the order for a visitor who may not open its payment page", async () => {
    const harness = createHarness({ authorized: false });

    expect(await harness.reopen()).toEqual({ state: "not_found" });
    expect(harness.findReservation).not.toHaveBeenCalled();
    expect(harness.findAttempt).not.toHaveBeenCalled();
  });

  test("answers not found for an order that doesn't exist", async () => {
    const harness = createHarness({ reservation: null });

    expect(await harness.reopen()).toEqual({ state: "not_found" });
  });

  test("closes the page of a paid order", async () => {
    const harness = createHarness({
      reservation: makeReservation({
        paymentState: "paid",
        paidAt: providerOrderCreatedAt,
      }),
      attempt: makeAttempt({ state: "paid" }),
    });

    expect(await harness.reopen()).toEqual({ state: "closed", reason: "paid" });
    expect(harness.findAttempt).not.toHaveBeenCalled();
  });

  test("closes the page while a late payment of the order is reconciled", async () => {
    const harness = createHarness({
      now: recoveryVerifiedAt,
      reservation: makeReservation({
        paymentState: "expired",
        failureCode: paymentAbandonedAfterProviderCutoffFailureCode,
        updatedAt: attemptExpiredAt,
      }),
      attempt: makeAttempt({
        state: "expired",
        failureCode: paymentAbandonedAfterProviderCutoffFailureCode,
        updatedAt: attemptExpiredAt,
      }),
      latePaymentRecovery: lateRecovery("pending"),
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "late_payment",
    });
    expect(harness.findAttempt).not.toHaveBeenCalled();
  });

  test("closes the page of a paid reservation after late payment recovery", async () => {
    const recovery = lateRecovery("recovered");
    const { completedAt } = recovery;
    if (completedAt === null) throw new Error("Expected recovery completion");
    const harness = createHarness({
      now: completedAt,
      reservation: makeReservation({
        dotyposReservationId: recoveredDotyposReservationId,
        reservationState: "confirmed",
        reservationCreatedAt: completedAt,
        reservationConfirmedAt: completedAt,
        paymentState: "paid",
        paidAt: recovery.verifiedPaidAt,
        updatedAt: completedAt,
      }),
      attempt: makeAttempt({
        state: "paid",
        updatedAt: recovery.verifiedPaidAt,
      }),
      latePaymentRecovery: recovery,
    });

    expect(await harness.reopen()).toEqual({ state: "closed", reason: "paid" });
    expect(harness.findAttempt).not.toHaveBeenCalled();
  });

  test.each(["cancelled", "hold_expired", "confirmed"] as const)(
    "closes the page of an order whose hold is %s",
    async (reservationState) => {
      const harness = createHarness({
        reservation: makeReservation({ reservationState }),
      });

      expect(await harness.reopen()).toEqual({
        state: "closed",
        reason: "released",
      });
      expect(harness.findAttempt).not.toHaveBeenCalled();
    }
  );

  test.each(["failed", "cancelled", "expired"] as const)(
    "closes the page of a %s attempt",
    async (state) => {
      const harness = createHarness({
        reservation: makeReservation({ paymentState: state }),
        attempt: makeAttempt({ state, failureCode: "provider_failed" }),
      });

      expect(await harness.reopen()).toEqual({
        state: "closed",
        reason: "no_active_attempt",
      });
    }
  );

  test.each([
    ["no stored page", { providerRedirectUrl: null }],
    ["no security token", { securityToken: null }],
    [
      "another order",
      {
        reservationId: workspaceReservationIdSchema.make(
          "0198c1a2-c9f4-79ad-8951-ec189deca046"
        ),
      },
    ],
  ] as const)("closes the page of an attempt with %s", async (_, overrides) => {
    const harness = createHarness({
      attempt: makeAttempt(overrides),
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "no_active_attempt",
    });
  });

  test("closes the page of an order without an active attempt", async () => {
    const harness = createHarness({
      reservation: makeReservation({
        paymentState: "not_started",
        activePaymentAttemptId: null,
      }),
    });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "no_active_attempt",
    });
    expect(harness.findAttempt).not.toHaveBeenCalled();
  });

  test("closes the page when the active attempt row is missing", async () => {
    const harness = createHarness({ attempt: null });

    expect(await harness.reopen()).toEqual({
      state: "closed",
      reason: "no_active_attempt",
    });
  });
});
