import { describe, expect, test } from "bun:test";
import { withEmailSetting } from "./email-structure-blocks";

type LinkedComponent = { readonly href?: string; readonly text: string };

const linkedComponent = (): LinkedComponent => ({
  href: "https://deskohub.cz",
  text: "Book",
});

describe("withEmailSetting", () => {
  test("sets the setting last, as a new key", () => {
    const component = linkedComponent();

    const updated = withEmailSetting(component, "href", "https://deskohub.cz/");

    expect(Object.entries(updated)).toEqual([
      ["text", "Book"],
      ["href", "https://deskohub.cz/"],
    ]);
    expect(component.href).toBe("https://deskohub.cz");
  });

  test("drops the key when the setting is unset", () => {
    const component = linkedComponent();

    const updated = withEmailSetting(component, "href", undefined);

    expect(Object.hasOwn(updated, "href")).toBe(false);
    expect(updated).toEqual({ text: "Book" });
  });
});
