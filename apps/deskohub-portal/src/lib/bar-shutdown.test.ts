import { describe, expect, test } from "bun:test";
import { getBarState } from "./bar-shutdown";

const cutoff = Date.parse("2026-11-30T23:00:00.000Z");
const defaults = {
  now: cutoff - 24 * 60 * 60 * 1000,
  previewAsOf: null,
  vercelEnv: "production",
  isDev: false,
};

describe("Boardgame Bar shutdown", () => {
  test("stays open up to the final millisecond before midnight in Prague", () => {
    expect(getBarState({ ...defaults, now: cutoff - 1 })).toEqual({
      barClosed: false,
      cacheControl: "private, no-store",
    });
  });

  test("closes at midnight in Prague and stays closed", () => {
    for (const now of [cutoff, cutoff + 1]) {
      expect(getBarState({ ...defaults, now })).toEqual({
        barClosed: true,
        cacheControl:
          "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800",
      });
    }
  });

  test("caps open caching at an hour and lets it expire before midnight", () => {
    expect(getBarState(defaults).cacheControl).toBe(
      "public, max-age=0, must-revalidate, s-maxage=3600"
    );
    expect(
      getBarState({ ...defaults, now: cutoff - 659_001 }).cacheControl
    ).toBe("public, max-age=0, must-revalidate, s-maxage=599");
    expect(
      getBarState({ ...defaults, now: cutoff - 60_000 }).cacheControl
    ).toBe("private, no-store");
  });
});

describe("portal preview time", () => {
  const closedPreview = "2026-11-30T23:00:00Z";

  test("accepts a timezone-qualified date in Vercel preview or local dev", () => {
    expect(
      getBarState({
        ...defaults,
        previewAsOf: closedPreview,
        vercelEnv: "preview",
      })
    ).toEqual({ barClosed: true, cacheControl: "private, no-store" });
    expect(
      getBarState({
        now: cutoff,
        previewAsOf: "2026-11-30T23:59:59.999+01:00",
        vercelEnv: undefined,
        isDev: true,
      })
    ).toEqual({ barClosed: false, cacheControl: "private, no-store" });
  });

  test("ignores the override in production, even in dev mode", () => {
    expect(
      getBarState({ ...defaults, previewAsOf: closedPreview, isDev: true })
    ).toEqual(getBarState(defaults));
  });

  test("does not enable overrides on a build with an unknown environment", () => {
    expect(
      getBarState({
        ...defaults,
        previewAsOf: closedPreview,
        vercelEnv: undefined,
      })
    ).toEqual(getBarState(defaults));
  });

  test.each([
    "",
    "December 1, 2026",
    "2026-12-01",
    "2026-12-01T00:00:00",
    "2026-12-01T24:00:00Z",
    "2026-12-01T00:00:00+25:00",
    "2027-02-30T00:00:00Z",
  ])("ignores the malformed timestamp %j", (previewAsOf) => {
    expect(
      getBarState({ ...defaults, previewAsOf, vercelEnv: "preview" })
    ).toEqual(getBarState(defaults));
  });
});
