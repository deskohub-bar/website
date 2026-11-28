import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Option } from "effect";
import { signInStep } from "./sign-in-step";

describe("signInStep", () => {
  const email = testEmailAddress("ada");

  test("offers to continue a fresh session even after sending a link", () => {
    expect(
      signInStep(email, {
        email,
        signInCode: false,
        sentAt: 0,
        nextSignInEmailAt: Option.none(),
        signInAttempt: Option.none(),
      })
    ).toBe("continue");
  });
});
