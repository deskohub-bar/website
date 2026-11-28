import assert from "node:assert/strict";
import type { RenderResult } from "@testing-library/react";

export function getProfileForm(view: Pick<RenderResult, "container">) {
  const form = view.container.querySelector("#account-profile-form");
  assert(form instanceof HTMLFormElement, "Expected the account profile form");
  return form;
}

export function getProfileInput(
  view: Pick<RenderResult, "getByLabelText">,
  label: string
) {
  const input = view.getByLabelText(label);
  assert(input instanceof HTMLInputElement, `Expected an input for "${label}"`);
  return input;
}
