import { afterAll, afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { m } from "@/features/i18n";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();

const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
  "./dialog"
);

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("the localized close action dismisses the dialog", () => {
  const openChanges: boolean[] = [];
  const view = render(
    <Dialog onOpenChange={(open) => openChanges.push(open)} open>
      <DialogContent locale="cs-CZ">
        <DialogTitle>Smazat účet</DialogTitle>
        <DialogDescription>Tuto akci nelze vrátit.</DialogDescription>
      </DialogContent>
    </Dialog>
  );
  const close = view.getByRole("button", {
    name: m.closeDialogLabel({}, { locale: "cs-CZ" }),
  });

  expect(close.getAttribute("type")).toBe("button");
  fireEvent.click(close);
  expect(openChanges).toEqual([false]);
});
