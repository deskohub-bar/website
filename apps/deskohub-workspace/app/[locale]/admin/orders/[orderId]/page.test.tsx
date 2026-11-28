import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import assert from "node:assert/strict";
import { NexiOperationIdSchema, NexiOrderIdSchema } from "@deskohub/nexi";
import { within } from "@testing-library/react";
import { prerender } from "react-dom/static";
import {
  fioDiscrepancy,
  fioPendingRefund,
} from "@/features/administration/fio-settlement.fixtures";
import { m } from "@/features/administration/i18n";
import type { loadAdministrationOrder } from "@/features/administration/page-data.server";
import { getProviderValueLabel } from "@/features/administration/payment-presentation";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { workspaceUseAction } from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

mock.module("server-only", () => ({}));
mock.module("next/root-params", () => ({
  locale: () => Promise.resolve("en-US"),
}));

type Order = Awaited<ReturnType<typeof loadAdministrationOrder>>;

const orderId = NexiOrderIdSchema.make("order-1");
const firstOperationId = NexiOperationIdSchema.make("operation-1");
const secondOperationId = NexiOperationIdSchema.make("operation-2");
const reservationId = workspaceReservationIdSchema.make("reservation-1");
const paymentAttemptId = paymentAttemptIdSchema.make("attempt-1");
const locale = "en-US";

const fullOrder: Order = {
  orderId,
  provider: {
    orderId,
    amount: "12000",
    currency: "CZK",
    authorizedAmount: "12000",
    capturedAmount: "12000",
    lastOperationTime: "2026-08-12T08:05:00.000Z",
    lastOperationType: "CAPTURE",
    operations: [
      {
        orderId,
        operationId: firstOperationId,
        operationType: "AUTHORIZATION",
      },
      { orderId, operationId: secondOperationId, operationType: "CAPTURE" },
    ],
  },
  providerAvailable: true,
  providerStatus: "available",
  link: {
    paymentAttemptId,
    reservationId,
    state: "paid",
    refundState: "not_required",
    stateLabel: "Paid",
    failureCode: null,
    amount: { value: 12_000, exponent: 2, currency: "CZK" },
    refundTarget: null,
    refundedAmount: null,
    refundedAt: null,
    attemptCreatedAt: "2026-08-12T08:00:00.000Z",
    providerOrderCreatedAt: "2026-08-12T08:01:00.000Z",
    providerOrderCreatedAtEstimated: true,
    updatedAt: "2026-08-12T08:05:00.000Z",
  },
};

let order: Order = fullOrder;
const administrationPageData = await import(
  "@/features/administration/page-data.server"
);
const loadFioMovements = mock((id: string) =>
  Promise.resolve(
    id !== fioPendingRefund.orderId
      ? []
      : [
          { ...fioPendingRefund, refundTargetValue: 4_567 },
          {
            ...fioPendingRefund,
            id: "01980000-0000-7000-8000-000000000045",
            movementId: "9012345004",
            refundTargetValue: null,
          },
          {
            ...fioDiscrepancy,
            orderId: fioPendingRefund.orderId,
            paymentAttemptId: fioPendingRefund.paymentAttemptId,
            discrepancyReason: "currency_mismatch" as const,
          },
          {
            ...fioPendingRefund,
            id: "01980000-0000-7000-8000-000000000042",
            movementId: "9012345003",
            amountValue: 8_000_000_000_000_001,
            disposition: "discrepancy" as const,
            discrepancyReason: "amount_mismatch" as const,
          },
        ]
  )
);
mock.module(
  "@/features/administration/fio-settlement-page-data.server",
  () => ({
    loadAdministrationFioMovements: loadFioMovements,
  })
);
mock.module("@/features/administration/fio-refund-action", () => ({
  recordFioManualRefund: mock(),
}));
const loadNexiOrder = mock(() => Promise.resolve(order));
mock.module("@/features/administration/page-data.server", () => ({
  ...administrationPageData,
  loadAdministrationOrder: loadNexiOrder,
}));

async function prerenderOrderDetail(routeOrderId: string = orderId) {
  const { OrderAdministrationDetail } = await import("./page");
  const { prelude } = await prerender(
    <RouteLocaleProvider locale={locale}>
      <OrderAdministrationDetail
        locale={locale}
        params={Promise.resolve({ orderId: routeOrderId })}
      />
    </RouteLocaleProvider>,
    { progressiveChunkSize: Number.POSITIVE_INFINITY }
  );
  const container = document.createElement("div");
  container.innerHTML = await new Response(prelude).text();
  return container;
}

const linksTo = (container: HTMLElement, path: string) =>
  [...container.querySelectorAll("a")].filter((link) =>
    link.getAttribute("href")?.endsWith(path)
  );

const facts = (container: HTMLElement) =>
  [...container.querySelectorAll("section dl > div")].map((fact) => ({
    label: fact.querySelector("dt")?.textContent,
    value: fact.querySelector("dd")?.textContent,
  }));

const unreported = new Set<string>([
  m.administrationOrderNotReported({}, { locale }),
  m.administrationPaymentNotReported({}, { locale }),
]);

describe("OrderAdministrationDetail", () => {
  beforeAll(() => {
    registerWorkspaceComponentTestEnv();
    // The detail's refund control reads an idle action.
    workspaceUseAction.mockImplementation(() => ({
      execute: mock(),
      isExecuting: false,
    }));
  });
  afterEach(() => {
    order = fullOrder;
    loadNexiOrder.mockClear();
    loadFioMovements.mockClear();
  });
  afterAll(async () => {
    workspaceUseAction.mockReset();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await unregisterWorkspaceComponentTestEnv();
  });

  test("reports a linked order's facts, operations, reservation, and local attempt", async () => {
    const container = await prerenderOrderDetail();
    const view = within(container);
    const orderFacts = facts(container);

    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(orderId);
    expect(orderFacts).toHaveLength(6);
    expect(
      orderFacts.filter(
        ({ value }) =>
          value !== undefined && value !== null && unreported.has(value)
      )
    ).toEqual([]);
    expect(orderFacts.map(({ label }) => label)).toContain(
      m.administrationOrderFactCreatedEstimated({}, { locale })
    );
    expect(orderFacts.map(({ value }) => value)).toContain(
      getProviderValueLabel("CAPTURE", locale)
    );
    expect(
      linksTo(container, `/admin/operations/${firstOperationId}`)
    ).toHaveLength(1);
    expect(
      linksTo(container, `/admin/operations/${secondOperationId}`)
    ).toHaveLength(1);
    // The related-reservation card and each operation row link the reservation.
    expect(
      linksTo(container, `/admin/reservations/${reservationId}`)
    ).toHaveLength(3);
    expect(view.getByText(paymentAttemptId)).toBeDefined();
    expect(
      view.queryByText(m.administrationOrderDetailNotFound({}, { locale }))
    ).toBeNull();
    expect(
      view.queryByText(m.administrationOrderDetailUnavailable({}, { locale }))
    ).toBeNull();
  });

  test("labels an exactly recorded creation time without the estimate", async () => {
    const link = fullOrder.link;
    assert(link);
    order = {
      ...fullOrder,
      link: { ...link, providerOrderCreatedAtEstimated: false },
    };
    const labels = facts(await prerenderOrderDetail()).map(
      ({ label }) => label
    );

    expect(labels).toContain(m.administrationOrderFactCreated({}, { locale }));
    expect(labels).not.toContain(
      m.administrationOrderFactCreatedEstimated({}, { locale })
    );
  });

  test("reports an order the provider does not know and no attempt links", async () => {
    order = {
      ...fullOrder,
      provider: null,
      providerAvailable: true,
      providerStatus: "not_found",
      link: null,
    };
    const container = await prerenderOrderDetail();
    const view = within(container);
    const orderFacts = facts(container);

    expect(
      view.getByText(m.administrationOrderDetailNotFound({}, { locale }))
    ).toBeDefined();
    // Amount, authorized, captured, last operation, and last activity.
    expect(
      orderFacts.filter(
        ({ value }) =>
          value !== undefined && value !== null && unreported.has(value)
      )
    ).toHaveLength(5);
    expect(orderFacts.map(({ value }) => value)).toContain(
      m.administrationOrderNotRecorded({}, { locale })
    );
    expect(container.querySelectorAll("aside section")).toHaveLength(1);
    expect(container.querySelectorAll("aside a")).toHaveLength(0);
    expect(
      linksTo(container, `/admin/operations/${firstOperationId}`)
    ).toHaveLength(0);
  });

  test("warns that the provider is unavailable while still showing the local attempt", async () => {
    order = {
      ...fullOrder,
      provider: null,
      providerAvailable: false,
      providerStatus: "unavailable",
    };
    const container = await prerenderOrderDetail();
    const view = within(container);

    expect(
      view.getByText(m.administrationOrderDetailUnavailable({}, { locale }))
    ).toBeDefined();
    expect(container.querySelectorAll("aside section")).toHaveLength(2);
    expect(view.getByText(paymentAttemptId)).toBeDefined();
  });

  test("shows Fio evidence and a manual refund control on a local order without looking it up in Nexi", async () => {
    const fioOrderId = fioPendingRefund.orderId;
    assert(fioOrderId);
    const container = await prerenderOrderDetail(fioOrderId);
    const view = within(container);
    expect(view.getByText("9012345001")).toBeTruthy();
    expect(view.getByText("100.2500 EUR")).toBeTruthy();
    expect(view.getByText(/80,000,000,000,000\.01$/)).toBeTruthy();
    expect(view.getByText("Currency differs from the quote")).toBeTruthy();
    expect(view.getAllByText("Manual refund required")).toHaveLength(2);
    const partialItem = view.getByText("9012345001").closest("li");
    const duplicateItem = view.getByText("9012345004").closest("li");
    assert(partialItem);
    assert(duplicateItem);
    const partial = within(partialItem);
    const duplicate = within(duplicateItem);
    expect(
      partial.getByText("Amount to refund").nextElementSibling?.textContent
    ).toMatch(/45\.67$/);
    expect(
      duplicate.getByText("Amount to refund").nextElementSibling?.textContent
    ).toMatch(/123\.45$/);
    expect(
      view.getByRole("heading", { level: 1 }).parentElement?.textContent
    ).toBe(fioOrderId);
    expect(
      view.getAllByRole("button", { name: "Record manual refund" })
    ).toHaveLength(2);
    expect(loadNexiOrder).not.toHaveBeenCalled();
  });
});
