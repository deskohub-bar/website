import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { PassProductMarks } from "./pass-product-marks";

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);

const renderMarks = (element: ReactElement) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  const marks = container.firstElementChild;
  if (!marks) throw new Error("PassProductMarks rendered nothing.");
  return marks;
};

describe("PassProductMarks", () => {
  for (const surface of ["light", "dark"] as const) {
    test(`draws both product marks as decoration on a ${surface} surface`, () => {
      const marks = renderMarks(<PassProductMarks surface={surface} />);

      expect(marks.getAttribute("aria-hidden")).toBe("true");
      expect(marks.querySelectorAll("svg")).toHaveLength(2);
      expect(marks.textContent).toBe("");
      expect(
        [...marks.querySelectorAll("svg")].map((svg) =>
          svg.getAttribute("focusable")
        )
      ).toEqual(["false", "false"]);
    });
  }

  test("takes the caller's size class", () => {
    const marks = renderMarks(<PassProductMarks className="text-lg" />);

    expect(marks.classList.contains("text-lg")).toBe(true);
  });
});
