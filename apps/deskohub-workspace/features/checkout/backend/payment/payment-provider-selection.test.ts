import { expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE } from "@/features/checkout/payment-fallback";
import type { RetriedPaymentAttempt } from "./payment-provider";
import { selectCheckoutPaymentProvider } from "./payment-provider-selection";

const syntheticCustomer = {
  name: "Synthetic customer",
  email: testEmailAddress("delivered+provider-selection"),
};

const eligibleAttempt = {
  id: paymentAttemptIdSchema.make("retried-attempt-id"),
  provider: "nexi",
  state: "failed",
  failureCode: NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE,
} satisfies RetriedPaymentAttempt;

test("fallback selects mock for a synthetic retry of a marked terminal Nexi attempt", () => {
  expect(
    selectCheckoutPaymentProvider(
      "fallback",
      syntheticCustomer,
      eligibleAttempt
    )
  ).toBe("mock");
});

test.each([
  ["a fresh checkout", undefined],
  ["an unmarked attempt", { ...eligibleAttempt, failureCode: "nexi_rejected" }],
  ["a pending Nexi attempt", { ...eligibleAttempt, state: "pending" }],
  ["a paid Nexi attempt", { ...eligibleAttempt, state: "paid" }],
  ["a mock attempt", { ...eligibleAttempt, provider: "mock" }],
] satisfies Array<[string, RetriedPaymentAttempt | undefined]>)(
  "fallback keeps Nexi for %s",
  (_name, retriedAttempt) => {
    expect(
      selectCheckoutPaymentProvider(
        "fallback",
        syntheticCustomer,
        retriedAttempt
      )
    ).toBe("nexi");
  }
);

test("fallback keeps Nexi for a non-synthetic checkout", () => {
  expect(
    selectCheckoutPaymentProvider(
      "fallback",
      { name: "Customer", email: testEmailAddress("customer") },
      eligibleAttempt
    )
  ).toBe("nexi");
});

test.each(["nexi", "mock"] as const)("keeps direct %s selection", (mode) => {
  expect(selectCheckoutPaymentProvider(mode, syntheticCustomer)).toBe(mode);
  expect(
    selectCheckoutPaymentProvider(mode, syntheticCustomer, eligibleAttempt)
  ).toBe(mode);
});
