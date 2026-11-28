import { describe, expect, test } from "bun:test";
import { followLinkOnEnter } from "./link-activation";

const keyDown = (key: string) => {
  let prevented = false;
  const event = {
    nativeEvent: { key },
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as Parameters<ReturnType<typeof followLinkOnEnter>>[0];
  return { event, prevented: () => prevented };
};

describe("followLinkOnEnter", () => {
  test("Enter follows the link once, instead of the browser", () => {
    let follows = 0;
    const enter = keyDown("Enter");
    followLinkOnEnter(() => {
      follows += 1;
    })(enter.event);
    expect(follows).toBe(1);
    expect(enter.prevented()).toBe(true);
  });

  test("other keys pass through", () => {
    let follows = 0;
    for (const key of [" ", "Tab", "ArrowDown"]) {
      const other = keyDown(key);
      followLinkOnEnter(() => {
        follows += 1;
      })(other.event);
      expect(other.prevented()).toBe(false);
    }
    expect(follows).toBe(0);
  });
});
