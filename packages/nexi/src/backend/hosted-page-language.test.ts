import { describe, expect, test } from "bun:test";
import { getLocaleDefinition } from "@deskohub/i18n/locale-registry";
import { toHostedPageLanguage } from "./hosted-page-language";

describe("toHostedPageLanguage", () => {
  test("shows English for a language Nexi doesn't offer", () => {
    expect(toHostedPageLanguage("ukr")).toBe("ENG");
  });

  test("shows each supported locale's hosted page language", () => {
    for (const [locale, language] of [
      ["cs-CZ", "CZE"],
      ["en-US", "ENG"],
      ["de-DE", "DEU"],
      ["sk-SK", "SLK"],
      // Nexi offers no Ukrainian, Vietnamese or Hindi.
      ["uk-UA", "ENG"],
      ["vi-VN", "ENG"],
      ["hi-IN", "ENG"],
    ] as const) {
      expect(
        toHostedPageLanguage(getLocaleDefinition(locale).nexiLanguage)
      ).toBe(language);
    }
  });
});
