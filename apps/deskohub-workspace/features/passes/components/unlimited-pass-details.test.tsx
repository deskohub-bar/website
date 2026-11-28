import { afterAll, afterEach, expect, test } from "bun:test";
import { type Locale, m } from "@/features/i18n";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { readPassPurchaseDraft } from "../pass-purchase-draft";
import type { UnlimitedPassOptions } from "../unlimited-pass-checkout";

registerWorkspaceComponentTestEnv();
const { cleanup, render } = await import("@testing-library/react");
const { UnlimitedPassDetails } = await import("./unlimited-pass-details");

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

const locale = "en-US";
const startDate = plainDateStringSchema.make("2099-07-30");

function renderDetails(
  options: UnlimitedPassOptions,
  displayLocale: Locale = locale
) {
  return render(
    <UnlimitedPassDetails
      buyer={{ kind: "signed-out" }}
      locale={displayLocale}
      onChangeSelection={() => {}}
      onSubmit={async () => {}}
      selection={{ ...options, startDate }}
    />
  );
}

test("shows the Open Space price without add-ons when coffee is off", () => {
  const view = renderDetails({ tier: "open-space", coffee: false });

  expect(view.getByText("Open Space")).toBeDefined();
  expect(view.getByText("Jul 30, 2099")).toBeDefined();
  expect(view.getByText("CZK 3,490")).toBeDefined();
  expect(view.queryByText(/coffee|monitor setup/i)).toBeNull();
  expect(view.queryByText("Total")).toBeNull();
});

test("itemizes the Open Space pass and paid coffee before the total", () => {
  const view = renderDetails({ tier: "open-space", coffee: true });

  expect(view.getByText("Open Space")).toBeDefined();
  expect(view.getByText("Jul 30, 2099")).toBeDefined();
  expect(
    view.getByText("Unlimited membership", { selector: "dt" })
      .nextElementSibling?.textContent
  ).toMatch(/^CZK\s3,490$/);
  expect(
    view.getByText("Coffee for 30 days").nextElementSibling?.textContent
  ).toMatch(/^\+CZK\s690$/);
  expect(view.getByText("Total").nextElementSibling?.textContent).toMatch(
    /^CZK\s4,180$/
  );
});

test("shows coffee included in the Reserved Desk price", () => {
  const view = renderDetails({ tier: "reserved-desk" });

  expect(view.getByText("Reserved Desk")).toBeDefined();
  expect(view.getByText("Jul 30, 2099")).toBeDefined();
  expect(view.getByText("Coffee included")).toBeDefined();
  expect(view.getByText("CZK 5,990")).toBeDefined();
  expect(view.queryByText("Coffee for 30 days")).toBeNull();
  expect(view.queryByText("Monitor setup")).toBeNull();
});

test("shows included coffee and the selected monitors for a workstation pass", () => {
  const view = renderDetails({
    tier: "reserved-desk-workstation",
    monitorOption: "2x27-qhd",
  });

  expect(view.getByText("Reserved Desk with workstation")).toBeDefined();
  expect(view.getByText("Jul 30, 2099")).toBeDefined();
  expect(view.getByText("Coffee included")).toBeDefined();
  expect(view.getByText("CZK 8,490")).toBeDefined();
  expect(view.getByText("Monitor setup").nextElementSibling?.textContent).toBe(
    "2x 27″ QHD"
  );
  expect(view.queryByText("Coffee for 30 days")).toBeNull();
});

test("shows a different monitor selection in the checkout locale", () => {
  const view = renderDetails(
    { tier: "reserved-desk-workstation", monitorOption: "2x32-4k" },
    "cs-CZ"
  );

  expect(view.getByText("Rezervovaný stůl s pracovní stanicí")).toBeDefined();
  expect(view.getByText("Káva v ceně")).toBeDefined();
  expect(
    view.getByText("Monitorový setup").nextElementSibling?.textContent
  ).toBe("2x 32″ 4K");
});

test("sign-in returns to Details with the carried tier, coffee and start date, and no contact details", () => {
  const view = renderDetails({ tier: "open-space", coffee: true });
  const signIn = new URL(
    view
      .getByRole("link", { name: m.accountSignInTitle({}, { locale }) })
      .getAttribute("href") ?? "",
    "https://workspace.example"
  );
  expect(signIn.pathname).toBe("/en-US/auth/sign-in");
  const [returnTo] = [...signIn.searchParams.values()];
  const returned = new URL(returnTo ?? "", "https://workspace.example");
  expect(returned.pathname).toBe("/en-US/passes/unlimited");
  expect(returned.searchParams.get("step")).toBe("details");
  expect(
    readPassPurchaseDraft(Object.fromEntries(returned.searchParams))
  ).toEqual({ tier: "open-space", coffee: true, startDate: "2099-07-30" });
  for (const url of [signIn, returned]) {
    for (const key of url.searchParams.keys()) {
      expect(["name", "email", "phone", "billing", "contact"]).not.toContain(
        key
      );
    }
  }
});
