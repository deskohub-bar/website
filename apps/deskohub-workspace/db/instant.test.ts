import "@/shared/polyfills/temporal";

import { expect, test } from "bun:test";
import { toStoredInstant } from "./instant";

test("normalizes an in-memory instant to the precision of a stored timestamp", () => {
  const instant = Temporal.Instant.from("2026-10-12T06:25:49.712747999Z");

  expect(toStoredInstant(instant).toString()).toBe(
    "2026-10-12T06:25:49.712747Z"
  );
});
