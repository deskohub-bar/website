import { describe, expect, test } from "bun:test";
import {
  decodeProviderRejection,
  readProviderHttpCode,
} from "./provider-rejection";

describe("decodeProviderRejection", () => {
  test("reads the top-level fields of an SDK rejection", () => {
    const rejection = decodeProviderRejection({
      http_code: 404,
      message: "Resource not found",
    });

    expect(rejection).toEqual({
      http_code: 404,
      message: "Resource not found",
    });
    expect(readProviderHttpCode(rejection)).toBe(404);
  });

  test("falls back to the nested error when a top-level field has another type", () => {
    const rejection = decodeProviderRejection({
      http_code: "500",
      message: 42,
      error: { http_code: 503, message: "Service unavailable" },
    });

    expect(rejection).toEqual({
      error: { http_code: 503, message: "Service unavailable" },
    });
    expect(readProviderHttpCode(rejection)).toBe(503);
  });

  test("reads an Error instance carrying an HTTP code", () => {
    const rejection = decodeProviderRejection(
      Object.assign(new Error("Rate limited"), { http_code: 420 })
    );

    expect(rejection).toEqual({ http_code: 420, message: "Rate limited" });
  });

  test.each([
    ["a string", "rejected"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 500],
  ])("reads %s as a rejection without provider fields", (_, value) => {
    const rejection = decodeProviderRejection(value);

    expect(rejection).toEqual({});
    expect(readProviderHttpCode(rejection)).toBeUndefined();
  });
});
