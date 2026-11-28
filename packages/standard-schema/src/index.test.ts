import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { decodeStandardSchema, parseStandardSchema } from "./index";

describe("standard-schema helpers", () => {
  test("rejects asynchronous schemas", () => {
    const asyncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ value: "later" }),
      },
    };

    expect(() => decodeStandardSchema(asyncSchema, "value")).toThrow(
      "Async Standard Schema validation is not supported here"
    );
  });

  test("returns synchronous results that carry a non-callable then", () => {
    const result = { value: "ok" };
    Reflect.set(result, "then", false);
    const syncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => result,
      },
    };

    expect(decodeStandardSchema(syncSchema, "value")).toBe("ok");
    expect(parseStandardSchema(syncSchema, "value", "invalid")).toBe("ok");
  });

  test("rejects Promises from another realm", () => {
    const foreignResult: Promise<StandardSchemaV1.Result<string>> =
      runInNewContext('Promise.resolve({ value: "later" })');
    const foreignSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => foreignResult,
      },
    };

    expect(() => decodeStandardSchema(foreignSchema, "value")).toThrow(
      "Async Standard Schema validation is not supported here"
    );
    expect(() =>
      parseStandardSchema(foreignSchema, "value", "invalid")
    ).toThrow("Async Standard Schema validation is not supported here");
  });

  test("returns synchronous results whose then only inherits from Function", () => {
    const result = { value: "ok" };
    Reflect.set(result, "then", Object.create(Function.prototype));
    const syncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => result,
      },
    };

    expect(decodeStandardSchema(syncSchema, "value")).toBe("ok");
    expect(parseStandardSchema(syncSchema, "value", "invalid")).toBe("ok");
  });
});
