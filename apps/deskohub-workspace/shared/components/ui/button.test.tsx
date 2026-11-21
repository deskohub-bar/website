import { afterAll, afterEach, expect, expectTypeOf, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import type { ButtonProps } from "./button";

registerWorkspaceComponentTestEnv();

const { Button } = await import("./button");

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("prevents another activation until the pending action finishes", () => {
  let activations = 0;
  const save = (pending: boolean) => (
    <Button onClick={() => activations++} pending={pending}>
      Save
    </Button>
  );
  const view = render(save(true));
  const button = view.getByRole("button", { name: "Save" });

  expect(button).toHaveProperty("disabled", true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button);
  expect(activations).toBe(0);

  view.rerender(save(false));
  expect(button).toHaveProperty("disabled", false);
  expect(button.hasAttribute("aria-busy")).toBe(false);
  fireEvent.click(button);
  expect(activations).toBe(1);
});

test("asChild keeps the link's destination and native semantics", () => {
  const view = render(
    <Button asChild variant="secondary">
      <a href="/en-US/contact">Contact</a>
    </Button>
  );
  const link = view.getByRole("link", { name: "Contact" });

  expect(link.getAttribute("href")).toBe("/en-US/contact");
  expect(view.queryByRole("button")).toBeNull();
});

test("only a native Button accepts a pending prop", () => {
  expectTypeOf<ButtonProps<true>["pending"]>().toEqualTypeOf<undefined>();
  expectTypeOf<ButtonProps["pending"]>().toEqualTypeOf<boolean | undefined>();
});
