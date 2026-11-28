import { afterAll, afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { testEmailAddress } from "@deskohub/test-email";
import { m } from "@/features/i18n";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();
const { cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { EntryPackDetails } = await import("./entry-pack-details");

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

const locale = "en-US";
const product = { kind: "entry-pack", tier: "open-space", size: 5 } as const;
const buyerEmail = testEmailAddress("entry-pack-test-buyer");
const holderEmail = testEmailAddress("entry-pack-test-holder");
const base = { locale, product, onChangeSelection: () => {} } as const;

test("sign-in returns to Details with the selected tier and size", () => {
  const view = render(
    <EntryPackDetails
      {...base}
      buyer={{ kind: "signed-out" }}
      onSubmit={async () => {}}
    />
  );
  const href = view
    .getByRole("link", { name: m.accountSignInTitle({}, { locale }) })
    .getAttribute("href");
  assert(href);
  const link = new URL(href, "https://deskohub.example");
  expect(link.pathname).toBe("/en-US/auth/sign-in");
  expect([...link.searchParams.values()]).toContain(
    "/en-US/passes/entry-pack?tier=open-space&size=5&step=details"
  );
  expect(view.queryByRole("checkbox")).toBeNull();
});

test("submits the gift holder independently of the authenticated buyer", async () => {
  const submissions: unknown[] = [];
  const view = render(
    <EntryPackDetails
      {...base}
      buyer={{ kind: "linked", name: "Fixture Buyer", email: buyerEmail }}
      onSubmit={async (details) => {
        submissions.push(details);
      }}
    />
  );
  expect(view.getByText(buyerEmail)).toBeDefined();
  const fieldName = m.entryPackCheckoutHolderEmail({}, { locale });
  expect(view.queryByLabelText(fieldName)).toBeNull();
  const gift = view.getByRole("checkbox", {
    name: m.entryPackCheckoutGift({}, { locale }),
  });
  fireEvent.click(gift);
  expect(
    view.getByText(
      "After you pay, we email the recipient an invitation. Only they can claim and use the gift with their email address."
    )
  ).toBeDefined();
  fireEvent.change(view.getByLabelText(fieldName), {
    target: { value: holderEmail },
  });
  const submit = view.getByRole("button", { name: /continue/i });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(submissions).toEqual([
      { holderEmail, billing: { purpose: "personal", invoice: "none" } },
    ])
  );
  fireEvent.click(gift);
  expect(view.queryByLabelText(fieldName)).toBeNull();
  fireEvent.click(submit);
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1]).toEqual({
    billing: { purpose: "personal", invoice: "none" },
  });
});
