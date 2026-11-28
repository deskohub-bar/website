import { describe, expect, test } from "bun:test";
import { noticePresentation } from "./notice-presentation";

describe("noticePresentation", () => {
  test("a missing or empty message announces nothing even with a title", () => {
    for (const message of [undefined, ""]) {
      expect(
        noticePresentation("info", message, "t").announcement
      ).toBeUndefined();
    }
  });

  test("announces the title and then the message", () => {
    expect(noticePresentation("error", "m").announcement).toBe("m");
    expect(noticePresentation("error", "m", "t").announcement).toBe("t\nm");
  });
});
