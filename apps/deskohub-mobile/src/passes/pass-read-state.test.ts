import { expect, test } from "bun:test";
import {
  CustomerPassesUnavailable,
  CustomerServiceUnavailable,
} from "@deskohub/workspace-customer-api";
import { AsyncResult } from "effect/reactivity";
import { cashBookingCoverage } from "./pass-read-state";

const pending = AsyncResult.initial();
const outage = AsyncResult.fail(new CustomerServiceUnavailable());
const closed = AsyncResult.fail(new CustomerPassesUnavailable());
const unlimited = {
  passId: "dd7dea68-2624-4ed3-acf5-7d3f2d4a8427",
  tier: "open-space",
  validFrom: "2026-11-08",
  lastUsableDate: "2026-12-07",
} as const;
const held = AsyncResult.success({
  held: [{ ...unlimited, kind: "unlimited", status: "active" } as const],
  boughtForOthers: [],
});

test("a cash quote is still gated while the cold holder reads resolve", () => {
  expect(cashBookingCoverage(pending, pending, pending, "open-space")).toBe(
    "checking"
  );
  expect(cashBookingCoverage(pending, held, pending, "open-space")).toBe(
    "checking"
  );
  expect(cashBookingCoverage(pending, held, outage, "open-space")).toBe(
    "unknown"
  );
  expect(
    cashBookingCoverage(
      pending,
      held,
      AsyncResult.success({ entryPacks: [], unlimited }),
      "open-space"
    )
  ).toBe("covered");
});

test("the date-specific no-coverage response overrides a stale positive holder list", () => {
  const optionsAfterWithdrawal = AsyncResult.success({ entryPacks: [] });
  expect(
    cashBookingCoverage(pending, held, optionsAfterWithdrawal, "open-space")
  ).toBe("clear");
});

test("closed passes stay quiet and an unreadable account remains retryable", () => {
  expect(cashBookingCoverage(closed, pending, pending, "open-space")).toBe(
    "clear"
  );
  expect(cashBookingCoverage(pending, closed, pending, "open-space")).toBe(
    "clear"
  );
  expect(cashBookingCoverage(pending, outage, pending, "open-space")).toBe(
    "unknown"
  );
});
