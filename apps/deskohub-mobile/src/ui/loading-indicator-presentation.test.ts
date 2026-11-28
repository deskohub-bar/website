import { describe, expect, test } from "bun:test";
import { loadingDieBox } from "@deskohub/brand-motion/loading-die";
import { loadingIndicatorLayout } from "./loading-indicator-presentation";

describe("loadingIndicatorLayout", () => {
  test.each([
    ["inline", "inPlace", 20],
    ["section", "tumble", 32],
    ["screen", "tumble", 64],
  ] as const)(
    "draws %s as %s with the die %d dp tall at rest",
    (size, motion, dieHeight) => {
      const layout = loadingIndicatorLayout(size);
      const box = loadingDieBox(motion);
      expect(layout.motion).toBe(motion);
      // The whole frame scales with the die, so the hop keeps its room.
      expect(layout.height * (box.dieHeight / box.height)).toBeCloseTo(
        dieHeight,
        6
      );
      expect(layout.width / layout.height).toBeCloseTo(
        box.width / box.height,
        6
      );
    }
  );
});
