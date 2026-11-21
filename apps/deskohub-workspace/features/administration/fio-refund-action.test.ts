import "@/shared/testing/workspace-test-env";

import { beforeEach, expect, mock, test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import type { FioPaymentSettlement } from "@/db/schema/fio-payment-settlements";
import { mockAdministrationActionRequest } from "@/shared/testing/workspace-action-request.test-utils";
import { fioDiscrepancy, fioPendingRefund } from "./fio-settlement.fixtures";
import type { FioStaffQueue } from "./fio-settlement-page-data.server";

const request = await mockAdministrationActionRequest({
  administrator: "fio-operator",
  referer: "https://deskohub.test/en-US/admin/orders",
});

let settlement: FioPaymentSettlement;
const calls = mock((id: string, refundedAt: Temporal.Instant) => {
  if (id !== settlement.id) return Effect.succeed(null);
  if (settlement.disposition === "refund_required") {
    settlement = { ...settlement, disposition: "refunded", refundedAt };
  }
  return Effect.succeed(
    settlement.disposition === "refunded" ? settlement : null
  );
});

const listForStaff = mock(
  (_input: { kind: FioStaffQueue; beforeId?: string }) =>
    Effect.succeed([fioDiscrepancy])
);
const listForOrder = mock(() => Effect.succeed([fioPendingRefund]));

class SettlementRepository extends Context.Service<
  SettlementRepository,
  {
    readonly listForStaff: typeof listForStaff;
    readonly listForOrder: typeof listForOrder;
    readonly markManualRefunded: typeof calls;
  }
>()("@test/FioPaymentSettlementRepository") {}

mock.module(
  "@/features/checkout/backend/repositories/fio-payment-settlement.repository",
  () => ({
    FioPaymentSettlementRepository: Object.assign(SettlementRepository, {
      Default: Layer.succeed(SettlementRepository, {
        listForOrder,
        listForStaff,
        markManualRefunded: calls,
      }),
    }),
  })
);
const revalidate = mock();
mock.module("@/features/i18n/server/revalidate-localized-path", () => ({
  revalidateLocalizedPath: revalidate,
}));

const { recordFioManualRefund } = await import("./fio-refund-action");
const { loadAdministrationFioQueue, loadAdministrationFioMovements } =
  await import("./fio-settlement-page-data.server");

beforeEach(() => {
  request.reset();
  calls.mockClear();
  listForOrder.mockClear();
  listForStaff.mockClear();
  revalidate.mockClear();
  settlement = fioPendingRefund;
});

test.each(["signed-out", "not-administrator"] as const)(
  "does not touch settlement evidence for a %s caller",
  async (state) => {
    request.access.set(state);
    expect(
      await recordFioManualRefund({ settlementId: settlement.id })
    ).toHaveProperty("serverError");
    expect(calls).not.toHaveBeenCalled();
  }
);

test("rejects a malformed settlement ID and extra client-supplied evidence", async () => {
  expect(
    await recordFioManualRefund({ settlementId: "invalid" })
  ).toHaveProperty("validationErrors");
  const forged = {
    settlementId: settlement.id,
    refundedAt: "1900-01-01T12:00:00Z",
  };
  expect(await recordFioManualRefund(forged)).toHaveProperty(
    "validationErrors"
  );
  expect(calls).not.toHaveBeenCalled();
});

test("refuses to mark a discrepancy as refunded", async () => {
  settlement = fioDiscrepancy;
  expect(
    await recordFioManualRefund({ settlementId: settlement.id })
  ).toHaveProperty("serverError");
  expect(revalidate).not.toHaveBeenCalled();
});

test("records a pending refund and returns the original timestamp on replay", async () => {
  const input = { settlementId: settlement.id };
  const first = await recordFioManualRefund(input);
  expect(first).toEqual({
    data: {
      orderId: settlement.orderId,
      refundedAt: settlement.refundedAt?.toString(),
    },
  });
  expect(settlement.refundedAt).toBeInstanceOf(Temporal.Instant);
  expect(await recordFioManualRefund(input)).toEqual(first);
  expect(revalidate).toHaveBeenCalledWith("/admin/orders");
  expect(revalidate).toHaveBeenCalledWith(
    `/admin/orders/${settlement.orderId}`
  );
  expect(revalidate).toHaveBeenCalledWith(
    `/admin/reservations/${settlement.orderId}`
  );
});

test("guards both Fio detail and queue evidence for accounts without the role", async () => {
  request.access.set("not-administrator");
  await expect(
    loadAdministrationFioQueue("unmatched", undefined)
  ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  await expect(
    loadAdministrationFioMovements(fioPendingRefund.orderId!)
  ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  expect(listForStaff).not.toHaveBeenCalled();
  expect(listForOrder).not.toHaveBeenCalled();
});

test("uses the staff selector and ignores malformed cursors", async () => {
  const first = await loadAdministrationFioQueue("unmatched", "invalid");
  expect(first.movements).toEqual([fioDiscrepancy]);
  expect(listForStaff).toHaveBeenCalledWith({ kind: "unmatched" });
  expect(first.nextCursor).toBeUndefined();
  await loadAdministrationFioQueue("unmatched", fioDiscrepancy.id);
  expect(listForStaff).toHaveBeenLastCalledWith({
    kind: "unmatched",
    beforeId: fioDiscrepancy.id,
  });
});
