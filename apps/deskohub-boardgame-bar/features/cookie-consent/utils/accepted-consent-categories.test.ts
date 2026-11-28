import { describe, expect, test } from "bun:test";
import { acceptedConsentCategories } from "./accepted-consent-categories";

describe("acceptedConsentCategories", () => {
  test("lists none when the banner has no stored preferences", () => {
    expect(acceptedConsentCategories(undefined)).toEqual([]);
  });
});
