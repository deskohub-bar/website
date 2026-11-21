import { afterEach, describe, expect, test } from "bun:test";
import {
  CONSENT_UPDATED_EVENT,
  type ConsentState,
  type CookieConsentChoices,
  initializeConsentMode,
  syncConsentMode,
} from "./consent-mode";

type FakeWindow = EventTarget & Pick<Window, "dataLayer" | "gtag">;

const browser = globalThis as { window?: FakeWindow };

/** Installs a browser `window` whose `gtag` records every call. */
const installWindow = (
  window: Partial<Pick<Window, "dataLayer">> & { gtag?: false } = {}
) => {
  const gtagCalls: unknown[][] = [];
  const fakeWindow: FakeWindow = Object.assign(new EventTarget(), {
    dataLayer: window.dataLayer,
    gtag:
      window.gtag === false
        ? undefined
        : (...call: unknown[]) => {
            gtagCalls.push(call);
          },
  });
  browser.window = fakeWindow;
  return { window: fakeWindow, gtagCalls };
};

afterEach(() => {
  delete browser.window;
});

describe("initializeConsentMode", () => {
  test("creates the data layer and sets the default consent", () => {
    const { window, gtagCalls } = installWindow();

    initializeConsentMode();

    expect(window.dataLayer).toEqual([]);
    expect(gtagCalls).toEqual([
      [
        "consent",
        "default",
        {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "denied",
          functionality_storage: "granted",
          personalization_storage: "denied",
          security_storage: "granted",
        },
      ],
    ]);
  });

  test("keeps an existing data layer", () => {
    const dataLayer = [{ event: "gtm.js" }];
    const { window } = installWindow({ dataLayer });

    initializeConsentMode();

    expect(window.dataLayer).toBe(dataLayer);
    expect(window.dataLayer).toEqual([{ event: "gtm.js" }]);
  });

  test("still creates the data layer before gtag has loaded", () => {
    const { window } = installWindow({ gtag: false });

    initializeConsentMode();

    expect(window.dataLayer).toEqual([]);
  });

  test("does nothing on the server", () => {
    expect(() => initializeConsentMode()).not.toThrow();
  });
});

const bannerChoices = (
  accepted: string[] | undefined
): CookieConsentChoices => ({
  getUserPreferences: () =>
    ({ acceptedCategories: accepted }) as ReturnType<
      CookieConsentChoices["getUserPreferences"]
    >,
  acceptedCategory: (category) => accepted?.includes(category) ?? false,
});

const announcedCategories = (window: EventTarget) => {
  const announced: unknown[] = [];
  window.addEventListener(CONSENT_UPDATED_EVENT, (event) => {
    announced.push((event as CustomEvent).detail);
  });
  return announced;
};

function expectConsentUpdates(
  calls: unknown[][],
  expected: Partial<ConsentState>
) {
  const updates = calls.flatMap(([api, command, state]) => {
    expect([api, command]).toEqual(["consent", "update"]);
    return Object.entries(state as object);
  });
  expect(updates.sort()).toEqual(Object.entries(expected).sort());
}

describe("syncConsentMode", () => {
  test("grants accepted categories, denies the rest, and announces the choice", () => {
    const { window, gtagCalls } = installWindow();
    const announced = announcedCategories(window);

    syncConsentMode(bannerChoices(["necessary", "analytics", "preferences"]));

    expectConsentUpdates(gtagCalls, {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      personalization_storage: "granted",
    });
    expect(announced).toEqual([
      { acceptedCategories: ["necessary", "analytics", "preferences"] },
    ]);
  });

  test("grants marketing storage when marketing is accepted", () => {
    const { gtagCalls } = installWindow();

    syncConsentMode(bannerChoices(["necessary", "marketing"]));

    expectConsentUpdates(gtagCalls, {
      analytics_storage: "denied",
      ad_storage: "granted",
      ad_user_data: "granted",
      ad_personalization: "granted",
      personalization_storage: "denied",
    });
  });

  test("announces an empty choice even before gtag has loaded", () => {
    const { window } = installWindow({ gtag: false });
    const announced = announcedCategories(window);

    syncConsentMode(bannerChoices(undefined));

    expect(announced).toEqual([{ acceptedCategories: [] }]);
  });

  test("can sync consent without a browser", () => {
    expect(() => syncConsentMode(bannerChoices([]))).not.toThrow();
  });
});
