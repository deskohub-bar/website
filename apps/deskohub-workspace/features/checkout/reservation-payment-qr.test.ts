import { describe, expect, test } from "bun:test";
import { createReservationPaymentQrPayload } from "./reservation-payment-qr";

describe("reservation QR payment payload", () => {
  test("encodes a Czech account, exact CZK amount and numeric payment reference", () => {
    expect(
      createReservationPaymentQrPayload({
        account: { accountNumber: "123", bankCode: "0600" },
        amount: { value: 45_050, currency: "CZK", exponent: 2 },
        variableSymbol: "0012345678",
      })
    ).toBe(
      "SPD*1.0*ACC:CZ9106000000000000000123*AM:450.50*CC:CZK*X-VS:0012345678"
    );
  });
});
