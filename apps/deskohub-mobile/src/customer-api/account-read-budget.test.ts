import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { marketingPreferencesAtom } from "../account/legal/marketing-preferences";
import { referralsAtom } from "../account/referrals/referrals";
import { reservationHistoryAtom } from "../account/reservations/reservations-list-state";
import {
  AccountReadBudget,
  accountReadAllowance,
  allowsAutomaticRefresh,
  automaticRefreshReserve,
  spendRead,
} from "./account-read-budget";
import {
  makeFakeCustomerData,
  remainingAccountReads,
  settle,
} from "./testing/customer-data-test-registry";

describe("the read budget window", () => {
  test("drops expired reads when spending, so the window stays bounded", () => {
    const now = 31 * 60_000;
    expect(spendRead([0, 1, 2], now)).toEqual([now]);
  });
});

describe("allowsAutomaticRefresh", () => {
  test("stops automatic refreshes below the reserve", () => {
    expect(allowsAutomaticRefresh(automaticRefreshReserve)).toBe(true);
    expect(allowsAutomaticRefresh(automaticRefreshReserve - 1)).toBe(false);
  });
});

describe("AccountReadBudget", () => {
  test("never goes below zero", async () => {
    const remaining = await Effect.gen(function* () {
      const budget = yield* AccountReadBudget;
      for (let read = 0; read <= accountReadAllowance.reads; read += 1) {
        yield* budget.spend;
      }
      return yield* budget.remaining;
    }).pipe(Effect.provide(AccountReadBudget.Default), Effect.runPromise);

    expect(remaining).toBe(0);
  });

  test("frees each spent read exactly when its window ends", async () => {
    const remaining = await Effect.gen(function* () {
      const budget = yield* AccountReadBudget;
      yield* budget.spend;
      yield* TestClock.adjust("10 minutes");
      yield* budget.spend;
      yield* TestClock.adjust(Duration.millis(20 * 60_000 - 1));
      const beforeExpiry = yield* budget.remaining;
      yield* TestClock.adjust(Duration.millis(1));
      const atExpiry = yield* budget.remaining;
      return [beforeExpiry, atExpiry];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AccountReadBudget.Default, TestClock.layer())
      ),
      Effect.runPromise
    );

    expect(remaining).toEqual([
      accountReadAllowance.reads - 2,
      accountReadAllowance.reads - 1,
    ]);
  });
});

describe("the account read allowance", () => {
  // The server's `account-read` budget in
  // apps/deskohub-workspace/features/customer-api/customer-request-budget.ts.
  test("mirrors the server's account read budget: 40 reads per 30 minutes", () => {
    expect(accountReadAllowance.reads).toBe(40);
    expect(Duration.toMinutes(accountReadAllowance.window)).toBe(30);
  });

  type Registry = ReturnType<typeof makeFakeCustomerData>["registry"];
  test.each([
    [
      "the reservation history",
      (r: Registry) => settle(r, reservationHistoryAtom),
      1,
    ],
    [
      "marketing consent",
      (r: Registry) => settle(r, marketingPreferencesAtom),
      0,
    ],
    ["referrals", (r: Registry) => settle(r, referralsAtom), 0],
  ] as const)(
    "counts reading %s as %d account reads, as the server does",
    async (_name, read, reads) => {
      const data = makeFakeCustomerData("linked");
      const before = await remainingAccountReads(data.registry);

      await read(data.registry);

      expect(before - (await remainingAccountReads(data.registry))).toBe(reads);
    }
  );
});
