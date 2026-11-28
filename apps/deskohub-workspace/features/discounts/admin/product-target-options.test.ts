import { describe, expect, test } from "bun:test";
import {
  discountProductTargetOptions,
  formatDiscountProductTargets,
  getDiscountProductTargetLabel,
  toDiscountProductTargets,
} from "./product-target-options";

describe("discount product target labels", () => {
  test("label reservation targets in the route locale", () => {
    const labels = (locale: "cs-CZ" | "en-US") =>
      discountProductTargetOptions
        .filter(
          ({ target }) =>
            target.kind !== "entry-pack" && target.kind !== "unlimited"
        )
        .map(({ target }) => getDiscountProductTargetLabel(target, locale));

    expect(labels("en-US")).toEqual([
      "All cowork tiers",
      "Open Space only",
      "Reserved Desk only",
      "Meeting room",
      "Private office",
      "Team Table",
    ]);
    expect(labels("cs-CZ")).toEqual([
      "Všechny úrovně coworku",
      "Pouze Sdílené místo",
      "Pouze Vyhrazené místo",
      "Zasedačka",
      "Soukromá kancelář",
      "Týmový stůl",
    ]);
  });

  test("offers both pass families and the nine priced offers as distinct targets", () => {
    const passOptions = discountProductTargetOptions.filter(
      ({ target }) =>
        target.kind === "entry-pack" || target.kind === "unlimited"
    );

    expect(passOptions).toHaveLength(11);
    expect(new Set(passOptions.map(({ key }) => key)).size).toBe(11);
    const targets = toDiscountProductTargets([
      "entry-pack:reserved-desk:10",
      "unlimited",
    ]);
    expect(targets).toEqual([
      { kind: "entry-pack", tier: "reserved-desk", size: 10 },
      { kind: "unlimited" },
    ]);
    expect(formatDiscountProductTargets(targets, "cs-CZ")).toBe(
      "Balíček vstupů · Rezervovaný stůl · 10 vstupů, Neomezené členství"
    );
  });

  test("join a product summary in the route locale", () => {
    expect(
      formatDiscountProductTargets(
        [{ kind: "cowork", tier: "reserved-desk" }, { kind: "meeting-room" }],
        "cs-CZ"
      )
    ).toBe("Pouze Vyhrazené místo, Zasedačka");
  });
});
