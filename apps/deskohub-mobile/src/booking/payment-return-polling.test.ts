import { describe, expect, test } from "bun:test";
import type { CustomerOrderStatus } from "@deskohub/workspace-customer-api";
import { Duration, Option } from "effect";
import { nextPaymentReturnPoll } from "./payment-return-polling";

const enoughBudget = 20;

const delaysUntilStop = (status: CustomerOrderStatus) => {
  const delays: Array<number> = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const next = nextPaymentReturnPoll(attempt, enoughBudget, status);
    if (Option.isNone(next)) return delays;
    delays.push(Duration.toSeconds(next.value));
  }
  throw new Error("the schedule never stopped");
};

describe("nextPaymentReturnPoll", () => {
  test("polls a waiting order nine times before stopping", () => {
    expect(delaysUntilStop("paid_waiting_fulfillment")).toEqual([
      3, 3, 5, 5, 10, 15, 20, 30, 60,
    ]);
  });

  test("also schedules a read while payment or delivery is pending", () => {
    for (const status of [
      "late_payment_checking",
      "paid_awaiting_delivery",
      "pending",
    ] as const) {
      expect(nextPaymentReturnPoll(0, enoughBudget, status)).toEqual(
        Option.some(Duration.seconds(3))
      );
    }
  });

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
  ] as const)("stops on %s", (status) => {
    expect(nextPaymentReturnPoll(0, enoughBudget, status)).toEqual(
      Option.none()
    );
  });

  test("stops once fewer than eight status reads remain in the budget", () => {
    expect(Option.isSome(nextPaymentReturnPoll(2, 8, "pending"))).toBe(true);
    expect(nextPaymentReturnPoll(2, 7, "pending")).toEqual(Option.none());
  });
});
