import { expect, test } from "bun:test";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { getUnlimitedPassOfferExpiry } from "./unlimited-pass-discovery";

test.each([
  ["2026-11-22", "2026-12-22"],
  // Across the October daylight-saving change and a year end.
  ["2026-10-20", "2026-11-19"],
  ["2026-12-15", "2027-01-14"],
  ["2028-02-10", "2028-03-11"],
])(
  "an Unlimited pass bought on %s with no start date expires on %s",
  (today, expiry) => {
    expect(getUnlimitedPassOfferExpiry({ today }).toString()).toBe(expiry);
  }
);

test("an Unlimited pass expires 30 days after the start date the draft carries", () => {
  expect(
    getUnlimitedPassOfferExpiry({
      today: "2026-11-22",
      startDate: plainDateStringSchema.make("2027-03-15"),
    }).toString()
  ).toBe("2027-04-14");
});
