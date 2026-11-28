import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { ok } from "node:assert/strict";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { m } from "@/features/i18n";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

beforeAll(registerWorkspaceComponentTestEnv);
afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test.each(["en-US", "cs-CZ"] as const)(
  "labels the focusable wrapper in the visitor’s language and preserves the disabled child for %s",
  async (locale) => {
    const { FutureFeatureTooltip } = await import("./future-feature-tooltip");
    const message = m.account_future_feature_tooltip({}, { locale });
    let activationCount = 0;
    const view = render(
      <FutureFeatureTooltip locale={locale}>
        <button
          aria-label="Disabled action"
          disabled
          onClick={() => {
            activationCount += 1;
          }}
          type="button"
        >
          <span aria-hidden="true">Icon</span>
        </button>
      </FutureFeatureTooltip>
    );
    const child = view.getByRole("button", { name: "Disabled action" });
    const trigger = view.container.querySelector<HTMLElement>('[tabindex="0"]');

    ok(trigger instanceof HTMLSpanElement);
    expect(trigger.getAttribute("role")).toBe("group");
    const childLabelId = trigger.getAttribute("aria-labelledby");
    expect(childLabelId).not.toBeNull();
    expect(childLabelId).toBe(child.id);
    expect(document.getElementById(childLabelId ?? "")).toBe(child);
    expect(view.getByRole("group", { name: "Disabled action" })).toBe(trigger);
    ok(child instanceof HTMLButtonElement);
    expect(child.disabled).toBe(true);
    const tooltip = view.getByRole("tooltip", { hidden: true });
    expect(tooltip.hidden).toBe(true);
    expect(tooltip.textContent).toBe(message);
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(
      view.getByRole("group", { description: message, name: "Disabled action" })
    ).toBe(trigger);

    fireEvent.click(child);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(child.disabled).toBe(true);
    expect(activationCount).toBe(0);
  }
);
