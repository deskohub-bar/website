import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import {
  setGoogleConsentDefaults,
  updateGoogleConsentMode,
} from "./google-consent-mode";

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);
afterEach(() => {
  window.gtag = undefined;
  window.dataLayer = undefined;
});

describe("Google consent mode", () => {
  test("calls an installed gtag as a method of the window", () => {
    window.dataLayer = [];
    window.gtag = function gtag(this: Window, ...gtagArguments) {
      this.dataLayer?.push(gtagArguments);
    };

    setGoogleConsentDefaults();
    updateGoogleConsentMode([], { announceToTagManager: false });

    expect(window.dataLayer.length).toBeGreaterThan(1);
    expect(window.dataLayer[0]).toEqual([
      "consent",
      "default",
      expect.any(Object),
    ]);
  });

  test("queues calls on the data layer before GTM installs gtag", () => {
    setGoogleConsentDefaults();

    expect(window.dataLayer).toEqual([
      ["consent", "default", expect.any(Object)],
    ]);
  });
});
