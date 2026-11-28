import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { orderIdSchema } from "@/features/order";
import { stubFetch } from "@/shared/testing/fetch-stub.test-utils";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { AdminPassFilters } from "./pass-list";
import type { AdminPassPage } from "./pass-list-contract";

const initialPage: AdminPassPage = {
  passes: [],
  total: 0,
  hasNextPage: false,
  searchIncomplete: false,
};
let activeFetchStub: ReturnType<typeof stubFetch> | undefined;

beforeAll(() => registerWorkspaceComponentTestEnv());
afterEach(() => {
  cleanup();
  activeFetchStub?.mockRestore();
  activeFetchStub = undefined;
});
afterAll(() => unregisterWorkspaceComponentTestEnv());

test("posts the private query and selected filters, then shows a linked pass", async () => {
  const email = testEmailAddress("pass-list-holder");
  const id = orderIdSchema.make(crypto.randomUUID());
  const results: AdminPassPage = {
    ...initialPage,
    total: 1,
    passes: [
      {
        id,
        product: "entry-pack",
        tier: "open-space",
        entryCount: 5,
        entriesLeft: 4,
        status: "active",
        validFrom: plainDateStringSchema.make("2026-11-01"),
        validUntil: plainDateStringSchema.make("2026-12-01"),
        accessEndsOn: null,
        day: null,
        complimentary: false,
        claimed: false,
        holder: { customerId: null, name: null, email, deleted: false },
        buyer: null,
        paid: { value: 100000, exponent: 2, currency: "CZK" },
      },
    ],
  };
  const post = stubFetch(() => Promise.resolve(Response.json(results)));
  activeFetchStub = post;
  const view = render(
    <RouteLocaleProvider locale="en-US">
      <AdminPassFilters initialPage={initialPage} locale="en-US" />
    </RouteLocaleProvider>
  );

  fireEvent.change(view.getByRole("searchbox"), { target: { value: email } });
  fireEvent.change(view.getByLabelText("Product"), {
    target: { value: "entry-pack" },
  });
  fireEvent.change(view.getByLabelText("Source"), {
    target: { value: "paid" },
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Search" }));
  });

  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[0]).toBe("/en-US/admin/passes/search");
  expect(post.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({
      product: "entry-pack",
      source: "paid",
      query: email,
    }),
  });
  const links = await view.findAllByRole("link", {
    name: "Entry pack · 5 entries",
  });
  expect(
    links.every(
      (link) => link.getAttribute("href") === `/en-US/admin/passes/${id}`
    )
  ).toBe(true);
  expect(view.getAllByText("Not claimed yet").length).toBeGreaterThan(0);
});
