import { describe, expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { findAll, textOf } from "../ui/testing/element-tree";
import { AppSignInContinueStep } from "./app-sign-in-continue-step";
import {
  bottomSpacerIndex,
  inOrder,
  shownTree,
} from "./testing/sign-in-step-tree";

type Props = Parameters<typeof AppSignInContinueStep>[0];

const defaults: Props = {
  email: testEmailAddress("jana.novakova"),
  onContinue: () => undefined,
  continuing: false,
  notice: undefined,
  onUseDifferentEmail: () => undefined,
};

describe("AppSignInContinueStep", () => {
  test("shows the account it continues as, with one bottom action back to the app", () => {
    const onContinue = mock(() => undefined);
    const tree = shownTree(AppSignInContinueStep, { ...defaults, onContinue });
    const elements = inOrder(tree);
    const actions = elements.filter(({ props }) => props.role === "button");
    expect(actions).toHaveLength(1);
    const spacer = bottomSpacerIndex(elements);
    expect(spacer).toBeGreaterThanOrEqual(0);
    expect(
      elements.findIndex(({ props }) => props.role === "button")
    ).toBeGreaterThan(spacer);
    const press = actions[0]?.props.onPress;
    if (typeof press === "function") press();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(elements.some(({ props }) => props.role === "link")).toBe(true);

    const texts = findAll(tree, "Text").map(textOf);
    // The address may carry a break opportunity before the @.
    expect(texts.map((text) => text.replaceAll("\u200B", ""))).toContain(
      defaults.email
    );
  });

  test("while it hands off, the action is busy", () => {
    const elements = inOrder(
      shownTree(AppSignInContinueStep, { ...defaults, continuing: true })
    );
    const action = elements.find(({ props }) => props.role === "button");
    const link = elements.find(({ props }) => props.role === "link");
    expect(action?.props["aria-busy"]).toBe(true);
    expect(action?.props.onPress).toBeUndefined();
    expect(link?.props["aria-disabled"]).toBe(true);
  });

  test("shows initials from the first two parts of the address", () => {
    for (const [address, initials] of [
      ["jana.novakova", "JN"],
      ["jana_novakova-x", "JN"],
      ["jana", "J"],
    ] as const) {
      const tree = shownTree(AppSignInContinueStep, {
        ...defaults,
        email: testEmailAddress(address),
      });
      expect(findAll(tree, "Text").map(textOf)).toContain(initials);
    }
  });
});
