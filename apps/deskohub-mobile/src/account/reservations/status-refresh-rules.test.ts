import { describe, expect, test } from "bun:test";
import type { CustomerOrderStatus } from "@deskohub/workspace-customer-api";
import {
  AutomaticRefresh,
  nextAutomaticRefresh,
  statusVisitOf,
} from "./status-refresh-rules";

const enoughBudget = 20;

describe("statusVisitOf", () => {
  test("only after=payment marks a visit straight from payment", () => {
    expect(statusVisitOf("payment")).toBe("after-payment");
    expect(statusVisitOf(undefined)).toBe("normal");
    expect(statusVisitOf("")).toBe("normal");
    expect(statusVisitOf("Payment")).toBe("normal");
    expect(statusVisitOf(["payment", "payment"])).toBe("normal");
  });
});

describe("nextAutomaticRefresh", () => {
  test.each([
    "created",
    "fulfilled",
    "payment_failed",
    "cancelled",
    "expired",
    "fulfillment_failed",
    "payment_pending_delayed",
    "paid_fulfillment_delayed",
    "paid_delivery_delayed",
    "late_payment_refund",
    "late_payment_review",
  ] as const satisfies ReadonlyArray<CustomerOrderStatus>)(
    "stops automatic refresh on %s",
    (status) => {
      for (const visit of ["normal", "after-payment"] as const) {
        expect(
          nextAutomaticRefresh({
            visit,
            attempt: 0,
            remainingBudget: enoughBudget,
            status,
          })
        ).toEqual(AutomaticRefresh.Stopped({ reason: "settled" }));
      }
    }
  );

  test.each(["normal", "after-payment"] as const)(
    "a %s visit stops when fewer than 8 reads are left",
    (visit) => {
      const at = (remainingBudget: number) =>
        nextAutomaticRefresh({
          visit,
          attempt: 0,
          remainingBudget,
          status: "pending",
        });

      expect(at(8)._tag).toBe("After");
      expect(at(7)).toEqual(AutomaticRefresh.Stopped({ reason: "budget" }));
      expect(at(0)).toEqual(AutomaticRefresh.Stopped({ reason: "budget" }));
    }
  );
});
