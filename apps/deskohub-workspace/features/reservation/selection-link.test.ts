import { describe, expect, test } from "bun:test";
import { defineSelectionLink } from "./selection-link";

type Values = {
  readonly startsOn: string;
  readonly seats: number;
  readonly name: string;
};

type Selection = { readonly startsOn: string; readonly seats: number };

const link = defineSelectionLink({
  kind: "office",
  params: ["startsOn", "seats"],
  read: (searchParams): Values => ({
    startsOn: searchParams.get("startsOn") ?? "",
    seats: Number(searchParams.get("seats") ?? 1),
    name: "",
  }),
  // Written in the reverse of the declared order.
  write: (selection: Selection) => ({
    seats: String(selection.seats),
    startsOn: selection.startsOn,
  }),
  fromStored: (stored: Selection) => stored,
});

describe("defineSelectionLink", () => {
  test("writes its parameters in the declared order", () => {
    expect(
      Object.keys(link.write({ startsOn: "2026-12-01", seats: 1 }))
    ).toEqual(["startsOn", "seats"]);
  });

  test("restores nothing from absent values, whatever the URL names", () => {
    expect(
      link.restore(undefined, new URLSearchParams({ seats: "3" }))
    ).toBeUndefined();
  });

  test("replaces only the selection of restored values a URL names", () => {
    expect(
      link.restore(
        { startsOn: "2026-12-01", seats: 1, name: "Restored" },
        new URLSearchParams({ startsOn: "2026-12-02", seats: "2" })
      )
    ).toEqual({ startsOn: "2026-12-02", seats: 2, name: "Restored" });
  });
});
