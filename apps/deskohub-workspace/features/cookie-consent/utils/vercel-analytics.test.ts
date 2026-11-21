import { expect, test } from "bun:test";
import { sanitizeVercelAnalyticsEvent } from "./vercel-analytics";

test("strips gift link context and pass selection from browser analytics", () => {
  const signIn = "https://deskohub.test/en-US/auth/sign-in";
  const passes = "https://deskohub.test/en-US/account/passes";
  expect(
    sanitizeVercelAnalyticsEvent({
      type: "pageview",
      url: `${signIn}#gift=synthetic`,
    })?.url
  ).toBe(signIn);
  expect(
    sanitizeVercelAnalyticsEvent({
      type: "pageview",
      url: `${passes}?pass=synthetic-order`,
    })?.url
  ).toBe(passes);
});
