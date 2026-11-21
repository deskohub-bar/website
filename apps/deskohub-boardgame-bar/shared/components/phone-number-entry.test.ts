import { describe, expect, test } from "bun:test";
import {
  adoptsControlledPhoneValue,
  phoneInputVariant,
  phoneNumberValidity,
} from "./phone-number-entry";

describe("adoptsControlledPhoneValue", () => {
  test("takes over a changed value while the field isn't focused", () => {
    expect(
      adoptsControlledPhoneValue({
        value: "777123456",
        displayValue: "",
        isFocused: false,
      })
    ).toBe(true);
  });

  test("keeps what is being typed while the field is focused", () => {
    expect(
      adoptsControlledPhoneValue({
        value: "777123456",
        displayValue: "777",
        isFocused: true,
      })
    ).toBe(false);
  });

  test("leaves an unchanged value alone", () => {
    expect(
      adoptsControlledPhoneValue({
        value: "777",
        displayValue: "777",
        isFocused: false,
      })
    ).toBe(false);
  });
});

describe("phoneNumberValidity", () => {
  test("is undecided for a blank field", () => {
    expect(phoneNumberValidity("  ", "CZ")).toEqual({
      normalized: null,
      isValid: null,
    });
  });

  test("normalizes a valid number in the given country", () => {
    expect(phoneNumberValidity("905 123 456", "SK")).toEqual({
      normalized: "+421905123456",
      isValid: true,
    });
  });

  test("marks a number that can't be read as invalid", () => {
    expect(phoneNumberValidity("12", "CZ")).toEqual({
      normalized: null,
      isValid: false,
    });
  });
});

describe("phoneInputVariant", () => {
  test("uses the caller's variant whatever the validity", () => {
    expect(phoneInputVariant("default", false)).toBe("default");
    expect(phoneInputVariant("error", true)).toBe("error");
  });

  test("shows an error only once the number is invalid", () => {
    expect(phoneInputVariant(undefined, false)).toBe("error");
    expect(phoneInputVariant(undefined, true)).toBe("default");
    expect(phoneInputVariant(undefined, null)).toBe("default");
  });
});
