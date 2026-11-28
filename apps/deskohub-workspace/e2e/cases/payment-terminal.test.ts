import { expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { makeCoworkCheckoutData } from "../checkout/data";
import { preparedReservationForm } from "../checkout/reservation-form-preparation";
import { makeWorkspaceE2EHostedPaymentPermitRecorder } from "../coordination/hosted-payment-permit.service.mock";
import { workspaceE2EError } from "../errors";
import type { CheckoutFlowState, PaymentTerminalScenario } from "../types";
import {
  fixtureStep,
  hostedCheckoutRow,
  type ObservedStep,
} from "./checkout.test-utils";
import {
  makeTestE2EConfig,
  unopenedE2EDatabase,
} from "./e2e-fixtures.test-utils";
import { assertPaymentTerminalPath } from "./payment-terminal";

const injectedFailure: PaymentTerminalScenario = {
  failureCode: "workspace_e2e_nexi_failed",
  id: "payment-injected-failure",
  providerStatus: "DECLINED",
  state: "failed",
  titlePattern: /failed/,
  trigger: "injected",
};

const hostedAuthenticationFailure: PaymentTerminalScenario = {
  ...injectedFailure,
  failureCode: "nexi_payment_failed",
  id: "payment-authentication-failed",
  providerStatus: "THREEDS_FAILED",
  trigger: "hosted_failure",
};

const runUntilStatusPage = async (scenario: PaymentTerminalScenario) => {
  const hostedPaymentPermit = makeWorkspaceE2EHostedPaymentPermitRecorder();
  const observedSteps: Array<{
    readonly permit: "provider-verification" | undefined;
    readonly hosted: boolean;
    readonly id: string;
  }> = [];
  const orderId = workspaceReservationIdSchema.make(
    "019f7082-1bec-7ab4-8fcd-2f0fdfd9dd71"
  );
  const stop = workspaceE2EError("stop after the terminal status page");
  const observe = ({ id, permit }: ObservedStep) => {
    observedSteps.push({ permit, hosted: hostedPaymentPermit.isHolding(), id });
  };
  const check = fixtureStep(observe, (id) =>
    id === "assert-failed-status-page" ? Effect.fail(stop) : Effect.void
  );
  const config = makeTestE2EConfig("https://workspace.example.test");
  const data = makeCoworkCheckoutData(config.baseUrl, "2099-09-01");
  const state: CheckoutFlowState = { data };

  const exit = await Effect.runPromiseExit(
    assertPaymentTerminalPath(
      {
        config,
        data,
        openSession: Effect.fail(
          workspaceE2EError("the step contract test opens no browser session")
        ),
        runStep: (step) => step.execute,
        scenario,
        state,
        preparation: preparedReservationForm,
      },
      {
        check,
        preparePayPage: fixtureStep(observe, () => Effect.succeed(orderId)),
        startHostedPayment: fixtureStep(observe, () =>
          Effect.succeed("nexi" as const)
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
          read: fixtureStep(observe, () =>
            Effect.succeed(
              hostedCheckoutRow("terminal-attempt", "nexi-terminal-order")
            )
          ),
        },
      }
    ).pipe(
      Effect.provide(
        Layer.mergeAll(unopenedE2EDatabase, hostedPaymentPermit.layer)
      )
    )
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(hostedPaymentPermit.isHolding()).toBe(false);
  expect(state.orderId).toBe(orderId);
  return observedSteps;
};

test("holds the hosted-payment permit from submission through the injected terminal state", async () => {
  expect(await runUntilStatusPage(injectedFailure)).toEqual([
    { permit: undefined, hosted: false, id: "prepare-checkout-pay-page" },
    { permit: undefined, hosted: true, id: "start-hosted-payment" },
    { permit: undefined, hosted: true, id: "prepare-failed-payment-state" },
    { permit: undefined, hosted: false, id: "assert-failed-status-page" },
  ]);
});

test("holds the hosted-payment permit through the real Nexi return of a failed authentication", async () => {
  expect(await runUntilStatusPage(hostedAuthenticationFailure)).toEqual([
    { permit: undefined, hosted: false, id: "prepare-checkout-pay-page" },
    { permit: undefined, hosted: true, id: "start-checkout-payment" },
    { permit: undefined, hosted: true, id: "read-provider-session-row" },
    { permit: undefined, hosted: true, id: "complete-hosted-payment" },
    { permit: undefined, hosted: true, id: "reach-checkout-status-page" },
    { permit: undefined, hosted: false, id: "assert-failed-status-page" },
  ]);
});
