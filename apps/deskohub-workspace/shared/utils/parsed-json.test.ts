import { describe, expect, test } from "bun:test";
import { isParsedJson } from "./parsed-json";

describe("parsed JSON values", () => {
  test("accepts every value JSON.parse returns, non-finite numbers included", () => {
    expect(
      isParsedJson(
        JSON.parse('{"a":[1,"b",true,null],"big":1e400,"neg":-1e400}')
      )
    ).toBe(true);
  });

  test("rejects values JSON.parse can't return", () => {
    expect(isParsedJson(undefined)).toBe(false);
    expect(isParsedJson({ at: undefined })).toBe(false);
    expect(isParsedJson([() => 1])).toBe(false);
  });
});
