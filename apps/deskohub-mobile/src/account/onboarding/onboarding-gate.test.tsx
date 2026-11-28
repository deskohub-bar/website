import { expect, mock, test } from "bun:test";
import { RegistryContext } from "@effect/atom-react";
import { Effect } from "effect";
import type { ReactElement } from "react";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import {
  makeCustomerDataRegistry,
  makeFakeCustomerData,
  settle,
} from "../../customer-api/testing/customer-data-test-registry";
import { fakeCustomerDataLayer } from "../../customer-api/testing/fake-customer-data";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import {
  elementTree,
  findAll,
  hostTree,
  textOf,
} from "../../ui/testing/element-tree";
import { Text } from "../../ui/text";
import { setOnboardingSession } from "./onboarding-edits";

mock.module("expo-router", () => expoRouterStandIn());
mock.module("../../auth/use-session-reads", () => ({
  useSessionReads: () => 0,
}));

const { OnboardingGate } = await import("./onboarding-gate");

test.each(["About you", "Billing details"])(
  "%s offers an account retry while recovering after reauthentication",
  async (step) => {
    const { workspace, device } = makeFakeCustomerData("completion-required");
    let sessionId = "first";
    const registry = makeCustomerDataRegistry(
      fakeCustomerDataLayer({
        workspace,
        device,
        onboardingSession: Effect.sync(() => sessionId),
      })
    );
    const within = (node: ReactElement) => (
      <RegistryContext value={registry}>
        <AppLocaleProvider locale="en-US">{node}</AppLocaleProvider>
      </RegistryContext>
    );
    const screen = () =>
      hostTree(
        elementTree(
          OnboardingGate,
          { children: () => <Text>{step}</Text> },
          within
        ),
        within
      );
    const labels = (tree: ReturnType<typeof screen>) =>
      findAll(tree, "Text").map(textOf);
    try {
      setOnboardingSession(registry, sessionId);
      await settle(registry, accountAtom);
      expect(labels(screen())).toContain(step);

      sessionId = "second";
      setOnboardingSession(registry, sessionId);
      workspace.fail("getAccount", "service-unavailable");
      registry.refresh(accountAtom);
      expect((await settle(registry, accountAtom))._tag).toBe("Failure");

      const unavailable = screen();
      expect(labels(unavailable)).not.toContain(step);
      const retry = findAll(unavailable, "Pressable").find((button) =>
        labels(button).includes("Try again")
      );
      const press = retry?.props.onPress;
      if (typeof press !== "function") throw new Error("Try again is missing");
      press();

      expect((await settle(registry, accountAtom))._tag).toBe("Success");
      expect(labels(screen())).toContain(step);
    } finally {
      registry.dispose();
    }
  }
);
