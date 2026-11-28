import { describe, expect, test } from "bun:test";
import type { PaymentVerification } from "./payment-provider";
import { paymentVerificationLogFields } from "./payment-verification-log-fields";

const verification: PaymentVerification = {
  status: "success",
  providerOperationId: "operation-id",
  providerOrderStatus: "EXECUTED",
  hasActivity: true,
  mismatches: ["amount", "currency"],
};

describe("paymentVerificationLogFields", () => {
  test("keeps the outcome as scalars, never the provider facts", () => {
    const fields = paymentVerificationLogFields(verification);

    expect(fields).toEqual({
      verificationStatus: "success",
      verificationMismatches: "amount,currency",
      providerOrderStatus: "EXECUTED",
    });
  });

  test("leaves every field empty without a verification", () => {
    expect(Object.values(paymentVerificationLogFields(undefined))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
