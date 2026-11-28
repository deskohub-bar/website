import { afterAll, afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();

const { UnstyledButton } = await import("./unstyled-button");

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("defaults to a non-submitting button", () => {
  const view = render(
    <form>
      <UnstyledButton aria-label="Show slide 2" />
    </form>
  );
  const button = view.getByRole("button", { name: "Show slide 2" });

  expect(button.getAttribute("type")).toBe("button");
});

test("keeps an explicit submit type", () => {
  const view = render(<UnstyledButton type="submit">Send</UnstyledButton>);
  expect(view.getByRole("button").getAttribute("type")).toBe("submit");
});
