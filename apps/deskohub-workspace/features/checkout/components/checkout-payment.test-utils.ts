import type { Mock } from "bun:test";
import assert from "node:assert/strict";
import {
  type WorkspaceActionExecute,
  workspaceActionCallbacks,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";

export const checkoutPaymentActionCallbacks = <Data>(
  execute: Mock<WorkspaceActionExecute>
) => {
  const options = workspaceUseAction.mock.calls.at(-1)?.[1];
  assert(options, "Checkout payment action options missing");
  return workspaceActionCallbacks<Data>(options, execute);
};
