import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import {
  formatPhoneNumber,
  isPhoneNumber,
  isPhoneRegion,
  parsePhoneNumber,
  phoneNumberParts,
  phoneNumberSchema,
} from "./phone-number";

/**
 * Entered text, the E.164 number parsePhoneNumber reads from it in the Czech
 * default region (null for none).
 */
const enteredPhones = [
  ["  777 123 456  ", "+420777123456"],
  ["00420777123456", "+420777123456"],
  ["777123456 ext. 12", "+420777123456"],
  ["777 123 456 (mobile)", "+420777123456"],
  ["tel. 777123456", "+420777123456"],
  ["+420 123 456 789", null],
  ["777 123 4567", null],
  ["++420777123456", null],
  ["+420777123456 / +420777123457", null],
  ["not a phone", null],
  ["   ", null],
] as const;

/**
 * Text entered without a country calling code, the default region it is
 * entered in, and the E.164 number that region reads from it.
 */
const nationalPhones = [
  ["0151 23456789", "DE", "+4915123456789"],
  ["050 123 4567", "UA", "+380501234567"],
  ["0905 123 456", "SK", "+421905123456"],
] as const;

const regions = ["CZ", "DE", "UA", "SK", "US", "VN", "IN"] as const;

describe("the default region", () => {
  test.each(nationalPhones)(
    "reads %p entered in %p as %p",
    (text, region, e164) => {
      expect<string | null>(
        Option.getOrNull(parsePhoneNumber(text, region))
      ).toBe(e164);
      expect(isPhoneNumber(text, region)).toBe(true);
    }
  );

  test("rejects a German national number in the Czech region", () => {
    expect(
      Option.getOrNull(parsePhoneNumber("0151 23456789", "CZ"))
    ).toBeNull();
    expect(isPhoneNumber("0151 23456789", "CZ")).toBe(false);
  });

  test("reads a Czech national number as German in Germany", () => {
    expect<string | null>(
      Option.getOrNull(parsePhoneNumber("777 123 456", "DE"))
    ).toBe("+49777123456");
  });

  test("reads an international number the same way across regions", () => {
    const text = "+49 151 23456789";
    for (const region of ["CZ", "DE", "UA"]) {
      expect<string | null>(
        Option.getOrNull(parsePhoneNumber(text, region))
      ).toBe("+4915123456789");
      expect(isPhoneNumber(text, region)).toBe(true);
    }
  });

  test("reads only international numbers in a region without a numbering plan", () => {
    expect(Option.getOrNull(parsePhoneNumber("777 123 456", "XX"))).toBeNull();
    expect(isPhoneNumber("777 123 456", "XX")).toBe(false);
    expect<string | null>(
      Option.getOrNull(parsePhoneNumber("+420777123456", "XX"))
    ).toBe("+420777123456");
    expect(isPhoneNumber("+420777123456", "XX")).toBe(true);
  });

  test("names the regions that have a numbering plan", () => {
    for (const region of regions) {
      expect(isPhoneRegion(region)).toBe(true);
    }
    for (const region of ["XX", "cz", "", "CZE"]) {
      expect(isPhoneRegion(region)).toBe(false);
    }
  });
});

describe("parsePhoneNumber", () => {
  test.each(enteredPhones)("reads %p as %p", (text, expected) => {
    expect<string | null>(Option.getOrNull(parsePhoneNumber(text, "CZ"))).toBe(
      expected
    );
  });
});

describe("isPhoneNumber", () => {
  test.each([
    ["  777 123 456  ", true],
    ["00420777123456", true],
    ["777123456 ext. 12", true],
    ["777 123 456 (mobile)", false],
    ["tel. 777123456", false],
    ["+420777123456 / +420777123457", false],
    ["+420 123 456 789", false],
    ["   ", false],
  ] as const)("checks the whole of %p", (text, expected) => {
    expect(isPhoneNumber(text, "CZ")).toBe(expected);
  });
});

describe("phoneNumberSchema", () => {
  const czechPhoneNumberSchema = phoneNumberSchema("CZ");
  test("decodes entered text in the configured region", () => {
    const decode = Schema.decodeUnknownSync(phoneNumberSchema("DE"));

    expect<string>(decode("tel. 0151 23456789")).toBe("+4915123456789");
  });

  test("reports an invalid phone number", () => {
    expect(() => Schema.decodeSync(czechPhoneNumberSchema)("abc")).toThrow(
      "Invalid phone number"
    );
  });

  test("encodes a phone number as its E.164 text, which decodes to itself", () => {
    const phone = Option.getOrThrow(parsePhoneNumber("777 123 456", "CZ"));
    const encoded = Schema.encodeSync(czechPhoneNumberSchema)(phone);
    expect(encoded).toBe("+420777123456");
    expect(Schema.decodeSync(czechPhoneNumberSchema)(encoded)).toBe(phone);
  });

  test("holds only a valid number in E.164 form", () => {
    const isPhoneNumberValue = Schema.is(czechPhoneNumberSchema);
    expect(isPhoneNumberValue("+420777123456")).toBe(true);
    for (const value of ["777123456", "+420 777 123 456", "+420123456789"]) {
      expect(isPhoneNumberValue(value)).toBe(false);
    }
  });
});

describe("phoneNumberParts", () => {
  test.each([
    ["777 123 456", { countryCallingCode: "420", nationalNumber: "777123456" }],
    ["+12025550143", { countryCallingCode: "1", nationalNumber: "2025550143" }],
  ] as const)(
    "splits %s into its calling code and national number",
    (text, expected) => {
      expect(
        phoneNumberParts(Option.getOrThrow(parsePhoneNumber(text, "CZ")))
      ).toEqual(expected);
    }
  );
});

describe("formatPhoneNumber", () => {
  test("writes an international display format that reads back in another region", () => {
    const phone = Option.getOrThrow(parsePhoneNumber("777123456", "CZ"));
    const formatted = formatPhoneNumber(phone);

    expect(formatted).toBe("+420 777 123 456");
    expect(parsePhoneNumber(formatted, "DE")).toEqual(Option.some(phone));
  });
});
