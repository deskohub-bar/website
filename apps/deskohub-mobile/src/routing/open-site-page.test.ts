import { afterEach, describe, expect, mock, test } from "bun:test";
import { Platform } from "react-native";

const browserTabs: Array<string> = [];
mock.module("expo-web-browser", () => ({
  openBrowserAsync: async (url: string) => {
    browserTabs.push(url);
    return { type: "opened" };
  },
}));

const { openSitePage } = await import("./open-site-page");

const platform = Platform as { OS: string };
const nativeOS = platform.OS;
const nativeWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

/** The web, with `open` answering as a browser would. */
const onTheWeb = (open: (url: string) => object | null) => {
  platform.OS = "web";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { open },
  });
};

afterEach(() => {
  platform.OS = nativeOS;
  if (nativeWindow) Object.defineProperty(globalThis, "window", nativeWindow);
  else Reflect.deleteProperty(globalThis, "window");
  browserTabs.length = 0;
});

describe("openSitePage", () => {
  test("opens the in-app browser tab on a device", async () => {
    await openSitePage("https://example.test/en-US/pricing");
    expect(browserTabs).toEqual(["https://example.test/en-US/pricing"]);
  });

  test("opens a new tab on the web, cut off from the app", async () => {
    // A caller that reports a blocked tab.
    const tab: { opener?: unknown } = { opener: "app" };
    const opened: Array<string> = [];
    onTheWeb((url) => {
      opened.push(url);
      return tab;
    });
    await openSitePage("https://example.test/en-US/pricing", {
      failIfBlocked: true,
    });
    expect(opened).toEqual(["https://example.test/en-US/pricing"]);
    expect(tab.opener).toBeNull();
  });

  test("fails on the web when the browser blocks the tab, if asked", async () => {
    onTheWeb(() => null);
    await expect(
      openSitePage("https://example.test/en-US/pricing", {
        failIfBlocked: true,
      })
    ).rejects.toThrow();
  });

  test("otherwise keeps Expo's web opener, which never fails", async () => {
    onTheWeb(() => null);
    await openSitePage("https://example.test/en-US/terms");
    expect(browserTabs).toEqual(["https://example.test/en-US/terms"]);
  });
});
