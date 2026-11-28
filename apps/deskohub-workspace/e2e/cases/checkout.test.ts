import "@/shared/polyfills/temporal";

import { describe, expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import type { Customer } from "@deskohub/dotypos/generated";
import { testEmailAddress } from "@deskohub/test-email";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { instantStringSchema } from "@/shared/utils/temporal";
import { makeCoworkCheckoutData } from "../checkout/data";
import { preparedReservationForm } from "../checkout/reservation-form-preparation";
import { getDatasourceConfig, type WorkspaceE2EConfig } from "../config";
import { makeWorkspaceE2EHostedPaymentPermitRecorder } from "../coordination/hosted-payment-permit.service.mock";
import { WorkspaceE2EProviderVerificationPermitServiceMock } from "../coordination/provider-verification-permit.service.mock";
import { makeTestE2EEnvironment } from "../e2e-env.test-fixture";
import {
  type WorkspaceE2EError,
  workspaceE2EError,
  workspaceE2ETimeoutError,
} from "../errors";
import { workspaceE2ETimeouts } from "../timeouts";
import type { CheckoutData, CheckoutFlowState, CheckoutRow } from "../types";
import {
  assertFreshPaymentAttempt,
  completeHostedCheckoutPayment,
  executeCheckoutFlow,
} from "./checkout";
import {
  fixtureStep,
  hostedCheckoutRow,
  type ObservedStep,
} from "./checkout.test-utils";
import {
  makeTestE2EConfig,
  unopenedE2EDatabase,
} from "./e2e-fixtures.test-utils";

// The step contract tests fake every step, so no step may open a browser.
const unopenedBrowserSession = Effect.fail(
  workspaceE2EError("the step contract test opens no browser session")
);

const customer: Customer = {
  _cloudId: "customer-id",
  id: "customer-id",
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: null,
  email: testEmailAddress("customer"),
  phone: null,
  points: null,
  flags: "0",
  display: true,
  deleted: false,
};

const checkoutRow = {
  dotypos_customer_id: DotyposCustomerIdSchema.make("dotypos-customer-id"),
  dotypos_reservation_id: DotyposReservationIdSchema.make(
    "dotypos-reservation-id"
  ),
  locale: "en-US",
  reservation_details: {
    kind: "meeting-room",
    duration: { unit: "day", amount: 1 },
  },
  reservation_id: workspaceReservationIdSchema.make("workspace-reservation-id"),
};

const wholeDayData: Pick<
  CheckoutData,
  "expectedReservationDetails" | "meetingRoom"
> = {
  expectedReservationDetails: {
    kind: "meeting-room",
    duration: { unit: "day", amount: 1 },
  },
  meetingRoom: {
    duration: { unit: "day", amount: 1 },
    startsAt: instantStringSchema.make("2027-03-27T23:00:00Z"),
    endsAt: instantStringSchema.make("2027-03-28T22:00:00Z"),
    startDateTime: "2027-03-28T00:00",
  },
};

describe("whole-day meeting-room checkout proof", () => {
  test("renders both shared email detail projections from the confirmed DST calendar day", async () => {
    const { assertWholeDayMeetingRoomEmailPreviews } = await import(
      "./checkout"
    );

    await expect(
      Effect.runPromise(
        assertWholeDayMeetingRoomEmailPreviews({
          checkoutRow,
          data: wholeDayData,
          dotyposReservation: {
            customer,
            reservedFrom: Temporal.Instant.from("2027-03-27T23:00:00Z"),
            reservedUntil: Temporal.Instant.from("2027-03-28T22:00:00Z"),
          },
        })
      )
    ).resolves.toBeUndefined();
  });

  test("rejects a confirmed interval that is not one Prague calendar day", async () => {
    const { assertWholeDayMeetingRoomEmailPreviews } = await import(
      "./checkout"
    );

    await expect(
      Effect.runPromise(
        assertWholeDayMeetingRoomEmailPreviews({
          checkoutRow,
          data: wholeDayData,
          dotyposReservation: {
            customer,
            reservedFrom: Temporal.Instant.from("2027-03-28T00:00:00Z"),
            reservedUntil: Temporal.Instant.from("2027-03-29T00:00:00Z"),
          },
        })
      )
    ).rejects.toThrow(
      "confirmed Dotypos reservation is not one Prague calendar day"
    );
  });
});

const runCheckoutFlowSteps = async (
  options: Pick<
    Parameters<typeof executeCheckoutFlow>[0],
    "verifyPostFulfillmentPaths"
  > = {}
) => {
  const hostedPaymentPermit = makeWorkspaceE2EHostedPaymentPermitRecorder();
  const observedSteps: Array<{
    readonly permit: "provider-verification" | undefined;
    readonly hosted: boolean;
    readonly id: string;
  }> = [];
  const orderId = workspaceReservationIdSchema.make(
    "019f70bd-0131-7f30-9f8a-48e768f00292"
  );
  const row = hostedCheckoutRow("checkout-attempt", "nexi-order", "nexi", {
    reservation_id: orderId,
    dotypos_customer_id: DotyposCustomerIdSchema.make("dotypos-customer-paid"),
  });
  const observe = ({ id, permit }: ObservedStep) => {
    observedSteps.push({ permit, hosted: hostedPaymentPermit.isHolding(), id });
  };
  const check = fixtureStep(observe, () => Effect.void);
  const read = fixtureStep(observe, () => Effect.succeed(row));
  const config = makeTestE2EConfig("https://workspace.example.test");
  const data = makeCoworkCheckoutData(config.baseUrl, "2099-09-01");
  const state: CheckoutFlowState = { data };
  const httpClientLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        Object.assign(
          () =>
            Promise.reject(
              new Error("HTTP must not execute in the step contract test")
            ),
          { preconnect: globalThis.fetch.preconnect }
        )
      )
    )
  );

  await Effect.runPromise(
    executeCheckoutFlow(
      {
        ...options,
        config,
        data,
        datasourceConfig: getDatasourceConfig(makeTestE2EEnvironment()),
        flow: {
          id: "checkout-capacity-contract",
          toReservationPreparation: () => preparedReservationForm,
        },
        payPageSteps: () => [
          {
            execute: Effect.void,
            id: "pay-page-assertion",
            timeoutMs: workspaceE2ETimeouts.uiTransition,
          },
        ],
        openSeparateSession: () => unopenedBrowserSession,
        openSession: unopenedBrowserSession,
        runStep: (step) => step.execute,
        state,
      },
      {
        check,
        checkoutRow: read,
        dotyposReservation: fixtureStep(observe, () =>
          Effect.succeed({
            customer,
            reservedFrom: Temporal.Instant.from("2099-09-01T08:00:00Z"),
            reservedUntil: Temporal.Instant.from("2099-09-01T12:00:00Z"),
          })
        ),
        hostedPayment: {
          check,
          open: fixtureStep(observe, () =>
            Effect.succeed({
              provider: "nexi" as const,
              complete: () => Effect.void,
              restart: () =>
                Effect.die(new Error("unexpected checkout restart")),
            })
          ),
          read,
        },
        preparePayPage: fixtureStep(observe, () => Effect.succeed(orderId)),
        replayWebhook: check,
      }
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          httpClientLayer,
          hostedPaymentPermit.layer,
          unopenedE2EDatabase,
          WorkspaceE2EProviderVerificationPermitServiceMock
        )
      )
    )
  );
  return observedSteps;
};

test("holds the hosted-payment permit from Nexi submission through the status page", async () => {
  const observedSteps = await runCheckoutFlowSteps();

  expect(
    observedSteps.filter(({ hosted }) => hosted).map(({ id }) => id)
  ).toEqual([
    "start-checkout-payment",
    "read-provider-session-row",
    "complete-hosted-payment",
    "reach-checkout-status-page",
  ]);
  // The two permits never nest, so neither can wait while holding the other.
  expect(
    observedSteps.find(({ id }) => id === "replay-payment-webhook")?.hosted
  ).toBe(false);
});

test("holds the provider-verification permit only for the webhook replay", async () => {
  const observedSteps = await runCheckoutFlowSteps({
    verifyPostFulfillmentPaths: true,
  });

  expect(
    observedSteps.flatMap(({ id, permit }) =>
      permit === undefined ? [] : [{ id, permit }]
    )
  ).toEqual([
    {
      permit: "provider-verification",
      id: "replay-payment-webhook",
    },
  ]);
});

test("runs the post-fulfillment paths only for an opted-in case, after every fulfilled assertion", async () => {
  const defaultSteps = (await runCheckoutFlowSteps()).map(({ id }) => id);
  const optedInSteps = (
    await runCheckoutFlowSteps({ verifyPostFulfillmentPaths: true })
  ).map(({ id }) => id);
  const postFulfillmentSteps = optedInSteps.slice(defaultSteps.length);

  expect(optedInSteps.slice(0, defaultSteps.length)).toEqual(defaultSteps);
  expect(postFulfillmentSteps).toContain(
    "restart-reservation-after-fulfillment"
  );
  expect(postFulfillmentSteps).toContain(
    "mark-fulfillment-failed-for-support-path"
  );
  expect(defaultSteps).not.toContain("restart-reservation-after-fulfillment");
  expect(defaultSteps).not.toContain(
    "mark-fulfillment-failed-for-support-path"
  );
  // Status isolation starts from the support path's failed-fulfillment state.
  expect(optedInSteps.indexOf("assert-reservation-status-isolation")).toBe(
    optedInSteps.length - 1
  );
  expect(
    optedInSteps.indexOf("mark-fulfillment-failed-for-support-path")
  ).toBeGreaterThan(
    optedInSteps.indexOf("restart-reservation-after-fulfillment")
  );
});

describe("Nexi sandbox payment restart", () => {
  const firstRow = hostedCheckoutRow("first-attempt", "first-nexi-order");
  const retryRow = hostedCheckoutRow("retry-attempt", "retry-nexi-order");
  const mockRow = hostedCheckoutRow("mock-attempt", "mock-order", "mock");
  const sandboxRejection = () =>
    workspaceE2EError("Nexi rejected the card-data save", {
      diagnosticCode: "nexi_hosted_continue_card_submission_rejected",
      operation: "Nexi control",
    });

  const payWithSteps = ({
    hostedPaymentFailures,
    mode = "nexi",
    initialProvider = "nexi",
    restarted = true,
    fellBack = true,
    reuseRejectedAttempt = false,
  }: {
    readonly hostedPaymentFailures: Record<string, WorkspaceE2EError>;
    readonly mode?: WorkspaceE2EConfig["paymentProvider"];
    readonly initialProvider?: "nexi" | "mock";
    readonly restarted?: boolean;
    readonly fellBack?: boolean;
    readonly reuseRejectedAttempt?: boolean;
  }) => {
    const hostedPaymentPermit = makeWorkspaceE2EHostedPaymentPermitRecorder();
    const stepIds: string[] = [];
    const stepsOutsidePermit: string[] = [];
    const observe = ({ id }: { readonly id: string }) => {
      stepIds.push(id);
      if (!hostedPaymentPermit.isHolding()) stepsOutsidePermit.push(id);
    };
    const paymentStep = <A>(
      execute: (id: string) => Effect.Effect<A, WorkspaceE2EError>
    ) =>
      fixtureStep(observe, (id) => {
        const failure = hostedPaymentFailures[id];
        return failure ? Effect.fail(failure) : execute(id);
      });
    const config = {
      ...makeTestE2EConfig("https://workspace.example.test"),
      paymentProvider: mode,
    };
    const data = makeCoworkCheckoutData(config.baseUrl, "2099-09-01");
    const result = Effect.runPromiseExit(
      completeHostedCheckoutPayment(
        {
          config,
          data,
          orderId: workspaceReservationIdSchema.make("order-id"),
          openSession: unopenedBrowserSession,
          runStep: (step) => step.execute,
          state: { data },
        },
        {
          check: paymentStep(() => Effect.void),
          open: paymentStep((id) =>
            Effect.succeed({
              provider: id.endsWith("-mock-fallback")
                ? "mock"
                : initialProvider,
              complete: () => Effect.void,
              restart: (_, fallback) =>
                Effect.succeed(fallback ? fellBack : restarted),
            })
          ),
          read: paymentStep((id) => {
            if (id.endsWith("-retry"))
              return Effect.succeed(reuseRejectedAttempt ? firstRow : retryRow);
            if (id.endsWith("-mock-fallback")) return Effect.succeed(mockRow);
            return Effect.succeed(
              initialProvider === "mock" ? mockRow : firstRow
            );
          }),
          restart: (step) => {
            observe(step);
            const failure = hostedPaymentFailures[step.id];
            return failure ? Effect.fail(failure) : step.execute;
          },
        }
      ).pipe(
        Effect.provide(
          Layer.mergeAll(unopenedE2EDatabase, hostedPaymentPermit.layer)
        )
      )
    );
    return { result, stepIds, stepsOutsidePermit };
  };

  const failureOf = (exit: Exit.Exit<CheckoutRow, WorkspaceE2EError>) =>
    Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;

  test("restarts a card-data rejection once and continues with the fresh attempt", async () => {
    const { result, stepIds, stepsOutsidePermit } = payWithSteps({
      hostedPaymentFailures: { "complete-hosted-payment": sandboxRejection() },
    });

    expect(await result).toEqual(Exit.succeed(retryRow));
    // One hosted-payment permit covers the rejected attempt and its restart.
    expect(stepsOutsidePermit).toEqual([]);
    expect(stepIds).toEqual([
      "start-checkout-payment",
      "read-provider-session-row",
      "complete-hosted-payment",
      "restart-sandbox-rejected-payment",
      "start-checkout-payment-retry",
      "read-provider-session-row-retry",
      "complete-hosted-payment-retry",
      "reach-checkout-status-page-retry",
    ]);
  });

  test("fails with the original rejection when the restart is declined", async () => {
    const rejection = sandboxRejection();
    const { result, stepIds } = payWithSteps({
      hostedPaymentFailures: { "complete-hosted-payment": rejection },
      restarted: false,
    });

    expect(failureOf(await result)).toEqual(Option.some(rejection));
    expect(stepIds.at(-1)).toBe("restart-sandbox-rejected-payment");
  });

  test("never restarts the restarted attempt", async () => {
    const retryRejection = sandboxRejection();
    const { result, stepIds } = payWithSteps({
      hostedPaymentFailures: {
        "complete-hosted-payment": sandboxRejection(),
        "complete-hosted-payment-retry": retryRejection,
      },
    });

    expect(failureOf(await result)).toEqual(Option.some(retryRejection));
    expect(
      stepIds.filter((id) => id === "restart-sandbox-rejected-payment")
    ).toHaveLength(1);
    expect(stepIds.at(-1)).toBe("complete-hosted-payment-retry");
  });

  test("uses a single mock payment after the Nexi restart also rejects", async () => {
    const { result, stepIds, stepsOutsidePermit } = payWithSteps({
      mode: "fallback",
      hostedPaymentFailures: {
        "complete-hosted-payment": sandboxRejection(),
        "complete-hosted-payment-retry": sandboxRejection(),
      },
    });
    expect(await result).toEqual(Exit.succeed(mockRow));
    expect(stepsOutsidePermit).toEqual([]);
    expect(
      stepIds.filter((id) => id.startsWith("start-checkout-payment"))
    ).toEqual([
      "start-checkout-payment",
      "start-checkout-payment-retry",
      "start-checkout-payment-mock-fallback",
    ]);
    expect(stepIds.slice(-5)).toEqual([
      "restart-sandbox-rejected-payment-with-mock",
      "start-checkout-payment-mock-fallback",
      "read-provider-session-row-mock-fallback",
      "complete-hosted-payment-mock-fallback",
      "reach-checkout-status-page-mock-fallback",
    ]);
  });

  test("keeps a fresh checkout on Nexi in fallback mode", async () => {
    const { result, stepIds } = payWithSteps({
      mode: "fallback",
      hostedPaymentFailures: {},
    });
    expect(await result).toEqual(Exit.succeed(firstRow));
    expect(
      stepIds.filter((id) => id.startsWith("start-checkout-payment"))
    ).toEqual(["start-checkout-payment"]);
  });

  test("stops at the second Nexi rejection when fallback is denied", async () => {
    const rejection = sandboxRejection();
    const { result, stepIds } = payWithSteps({
      mode: "fallback",
      fellBack: false,
      hostedPaymentFailures: {
        "complete-hosted-payment": sandboxRejection(),
        "complete-hosted-payment-retry": rejection,
      },
    });
    expect(failureOf(await result)).toEqual(Option.some(rejection));
    expect(stepIds.at(-1)).toBe("restart-sandbox-rejected-payment-with-mock");
  });

  test.each([
    "start-checkout-payment",
    "start-checkout-payment-retry",
    "start-checkout-payment-mock-fallback",
  ])("does not reissue ambiguous creation at %s", async (stepId) => {
    const failure = workspaceE2EError("creation response could not be decoded");
    const { result, stepIds } = payWithSteps({
      mode: "fallback",
      hostedPaymentFailures: {
        "complete-hosted-payment": sandboxRejection(),
        "complete-hosted-payment-retry": sandboxRejection(),
        [stepId]: failure,
      },
    });
    expect(failureOf(await result)).toEqual(Option.some(failure));
    expect(stepIds.at(-1)).toBe(stepId);
    expect(stepIds.filter((id) => id === stepId)).toHaveLength(1);
  });

  test("never restarts timeouts or failures that are not sandbox rejections", async () => {
    for (const failure of [
      workspaceE2ETimeoutError("Nexi continue timed out", {
        diagnosticCode: "nexi_hosted_continue_card_submission_rejected",
      }),
      workspaceE2EError("Nexi Pay control stayed disabled", {
        diagnosticCode: "nexi_hosted_pay_pay_disabled",
      }),
      workspaceE2EError("checkout row assertion failed"),
    ]) {
      const { result, stepIds } = payWithSteps({
        hostedPaymentFailures: { "complete-hosted-payment": failure },
      });

      expect(failureOf(await result)).toEqual(Option.some(failure));
      expect(stepIds).not.toContain("restart-sandbox-rejected-payment");
    }
  });

  test("leaves a mock checkout failure outside the Nexi restart path", async () => {
    const rejection = sandboxRejection();
    const { result, stepIds } = payWithSteps({
      mode: "mock",
      initialProvider: "mock",
      hostedPaymentFailures: { "complete-hosted-payment": rejection },
    });
    expect(failureOf(await result)).toEqual(Option.some(rejection));
    expect(stepIds.at(-1)).toBe("complete-hosted-payment");
  });

  test("requires a fresh payment attempt and Nexi order", async () => {
    expect(() => assertFreshPaymentAttempt(firstRow, retryRow)).not.toThrow();
    expect(() =>
      assertFreshPaymentAttempt(firstRow, {
        ...retryRow,
        payment_attempt_id: firstRow.payment_attempt_id,
      })
    ).toThrow("restarted payment reused the rejected payment attempt");
    expect(() =>
      assertFreshPaymentAttempt(firstRow, {
        ...retryRow,
        provider_order_id: firstRow.provider_order_id,
      })
    ).toThrow("restarted payment reused the rejected provider order");
    const { result, stepIds } = payWithSteps({
      hostedPaymentFailures: { "complete-hosted-payment": sandboxRejection() },
      reuseRejectedAttempt: true,
    });
    expect(failureOf(await result)).toMatchObject({
      value: { operation: "assert fresh payment attempt" },
    });
    expect(stepIds.at(-1)).toBe("read-provider-session-row-retry");
  });
});
