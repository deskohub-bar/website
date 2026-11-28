import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { NexiOrderIdSchema } from "@deskohub/nexi";
import { within } from "@testing-library/react";
import { prerender } from "react-dom/static";
import {
  fioDiscrepancy,
  fioPendingRefund,
} from "@/features/administration/fio-settlement.fixtures";
import type { FioStaffQueue } from "@/features/administration/fio-settlement-page-data.server";
import { m } from "@/features/administration/i18n";
import { orderListQuery } from "@/features/administration/order-list-query";
import type { loadAdministrationOrdersPage } from "@/features/administration/page-data.server";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

mock.module("server-only", () => ({}));
mock.module("next/root-params", () => ({
  locale: () => Promise.resolve("en-US"),
}));

type ListResult = Awaited<
  ReturnType<typeof loadAdministrationOrdersPage>["result"]
>;

const locale = "en-US";
const orderIds = [
  NexiOrderIdSchema.make("order-1"),
  NexiOrderIdSchema.make("order-2"),
];

const listedResult: ListResult = {
  items: orderIds.map((orderId) => ({
    orderId,
    provider: null,
    providerAvailable: true,
    providerStatus: "not_returned" as const,
    link: null,
  })),
  providerAvailable: true,
  truncated: false,
};

let result: ListResult = listedResult;
const administrationPageData = await import(
  "@/features/administration/page-data.server"
);
const loadNexiOrders = mock(() => ({
  range: Promise.resolve(orderListQuery.parse({})),
  result: Promise.resolve(result),
}));
mock.module("@/features/administration/page-data.server", () => ({
  ...administrationPageData,
  loadAdministrationOrdersPage: loadNexiOrders,
}));

const loadFioQueue = mock((kind: FioStaffQueue, _cursor: string | undefined) =>
  Promise.resolve({
    movements: [kind === "unmatched" ? fioDiscrepancy : fioPendingRefund],
    beforeId: undefined,
    nextCursor: fioDiscrepancy.id,
  })
);
mock.module(
  "@/features/administration/fio-settlement-page-data.server",
  () => ({
    loadAdministrationFioQueue: loadFioQueue,
  })
);
mock.module("@/features/administration/fio-refund-action", () => ({
  recordFioManualRefund: mock(),
}));

async function prerenderListPage(searchParams: Record<string, string> = {}) {
  const { default: OrdersAdministrationPage } = await import("./page");
  const { prelude } = await prerender(
    <RouteLocaleProvider locale={locale}>
      <OrdersAdministrationPage searchParams={Promise.resolve(searchParams)} />
    </RouteLocaleProvider>,
    { progressiveChunkSize: Number.POSITIVE_INFINITY }
  );
  const container = document.createElement("div");
  container.innerHTML = await new Response(prelude).text();
  return within(container);
}

const providerUnavailable = m.administrationOrderListProviderUnavailable(
  {},
  { locale }
);
const truncated = m.administrationOrderListTruncated({}, { locale });

describe("OrdersAdministrationPage", () => {
  beforeAll(() => registerWorkspaceComponentTestEnv());
  afterEach(() => {
    result = listedResult;
    loadNexiOrders.mockClear();
    loadFioQueue.mockClear();
  });
  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await unregisterWorkspaceComponentTestEnv();
  });

  test("lists each order without notices when the provider returned the whole list", async () => {
    const view = await prerenderListPage();

    for (const id of orderIds) {
      expect(
        view
          .getAllByRole("link")
          .filter((link) =>
            link.getAttribute("href")?.endsWith(`/admin/orders/${id}`)
          )
      ).not.toHaveLength(0);
    }
    expect(view.queryByText(providerUnavailable)).toBeNull();
    expect(view.queryByText(truncated)).toBeNull();
  });

  test("warns when the provider is unavailable and notes a truncated list", async () => {
    result = { ...listedResult, providerAvailable: false, truncated: true };
    const view = await prerenderListPage();

    expect(view.getByText(providerUnavailable)).toBeDefined();
    expect(view.getByText(truncated)).toBeDefined();
  });

  test("lists unmatched Fio evidence without attaching it to an order or calling Nexi", async () => {
    const view = await prerenderListPage({ fio: "unmatched" });
    expect(
      view.getByRole("heading", { name: "Unmatched Fio transfers" })
    ).toBeTruthy();
    expect(view.getByText("Invalid payment reference")).toBeTruthy();
    expect(view.getByText("100.2500 EUR")).toBeTruthy();
    expect(view.queryByRole("link", { name: "View order" })).toBeNull();
    expect(
      view.queryByRole("button", { name: "Record manual refund" })
    ).toBeNull();
    expect(
      view.getByRole("link", { name: "Older movements" }).getAttribute("href")
    ).toBe(`/en-US/admin/orders?fio=unmatched&fioBefore=${fioDiscrepancy.id}`);
    expect(loadNexiOrders).not.toHaveBeenCalled();
    expect(loadFioQueue).toHaveBeenCalledWith("unmatched", undefined);
  });

  test("links pending refund work to the relevant order and forwards pagination", async () => {
    const view = await prerenderListPage({
      fio: "refund_required",
      fioBefore: fioPendingRefund.id,
    });
    expect(view.getByText("Manual refund required")).toBeTruthy();
    expect(
      view.getByRole("link", { name: "View order" }).getAttribute("href")
    ).toBe(`/en-US/admin/orders/${fioPendingRefund.orderId}`);
    expect(loadNexiOrders).not.toHaveBeenCalled();
    expect(loadFioQueue).toHaveBeenCalledWith(
      "refund_required",
      fioPendingRefund.id
    );
  });
});
