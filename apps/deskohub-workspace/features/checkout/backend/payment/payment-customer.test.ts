import { describe, expect, test } from "bun:test";
import { parsePhoneNumber } from "@deskohub/phone-number";
import { testEmailAddress } from "@deskohub/test-email";
import { Option } from "effect";
import { getPaymentCustomer } from "./payment-customer";

const testEmailAddressForAda = testEmailAddress("ada");

describe("getPaymentCustomer", () => {
  test("maps Czech customer details to Nexi's split mobile fields", () => {
    expect(
      getPaymentCustomer({
        id: "dotypos-customer-id",
        name: "Ada Lovelace",
        email: testEmailAddressForAda,
        phone: parsePhoneNumber("+420 777 777 777", "CZ"),
      })
    ).toEqual({
      id: "dotypos-customer-id",
      name: "Ada Lovelace",
      email: testEmailAddressForAda,
      mobilePhone: {
        countryCallingCode: "420",
        nationalNumber: "777777777",
      },
    });
  });

  test("leaves out the mobile phone without a phone number", () => {
    expect(
      getPaymentCustomer({
        id: "dotypos-customer-id",
        name: "Ada Lovelace",
        email: testEmailAddressForAda,
        phone: Option.none(),
      })
    ).toEqual({
      id: "dotypos-customer-id",
      name: "Ada Lovelace",
      email: testEmailAddressForAda,
    });
  });
});
