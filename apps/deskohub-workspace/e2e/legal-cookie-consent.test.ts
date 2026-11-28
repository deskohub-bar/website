import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { m } from "@/features/i18n";
import {
  dismissLegalCookieConsent,
  hasReactClickHandler,
} from "./legal-cookie-consent";

const locale = "en-US" as const;
const analyticsCheckboxSelector = "#cookie-category-analytics";
const necessaryOnlyLabel = m.cookieConsentConsentModalAcceptNecessaryBtn(
  {},
  { locale }
);

type FakeConsentPage = {
  readonly clickCount: () => number;
  readonly evaluateArguments: readonly string[];
  readonly page: Parameters<typeof dismissLegalCookieConsent>[0];
};

const makeFakeConsentPage = (input: {
  readonly analyticsVisible: boolean;
  readonly hydrationResults: readonly boolean[];
  readonly necessaryVisible: boolean;
}): FakeConsentPage => {
  let necessaryVisible = input.necessaryVisible;
  let evaluateIndex = 0;
  let clickCount = 0;
  const evaluateArguments: string[] = [];
  const getNecessaryVisibility = () => necessaryVisible;
  const getAnalyticsVisibility = () => input.analyticsVisible;

  const makeLocator = (isVisible: () => boolean) => ({
    click: async () => {
      if (!isVisible()) throw new Error("fake cookie consent target is hidden");
      clickCount += 1;
      necessaryVisible = false;
    },
    isVisible: async () => isVisible(),
    waitFor: async () => {
      if (isVisible()) throw new Error("fake cookie consent target is visible");
    },
  });

  const necessaryOnlyButton = makeLocator(getNecessaryVisibility);
  const analyticsCheckbox = makeLocator(getAnalyticsVisibility);
  const page: FakeConsentPage["page"] = {
    evaluate: async (_pageFunction, selector) => {
      evaluateArguments.push(selector);
      const result =
        input.hydrationResults[
          Math.min(evaluateIndex, input.hydrationResults.length - 1)
        ];
      evaluateIndex += 1;
      return result ?? false;
    },
    getByRole: (_role, options) => {
      if (options?.name !== necessaryOnlyLabel)
        throw new Error("fake cookie consent helper used the wrong locale");
      return necessaryOnlyButton;
    },
    locator: (selector) => {
      if (selector !== analyticsCheckboxSelector)
        throw new Error(`unexpected fake cookie consent selector: ${selector}`);
      return analyticsCheckbox;
    },
  };

  return {
    clickCount: () => clickCount,
    evaluateArguments,
    page,
  };
};

test("does not race a visible but unhydrated inline analytics control", async () => {
  const fake = makeFakeConsentPage({
    analyticsVisible: true,
    hydrationResults: [false, true],
    necessaryVisible: false,
  });

  await dismissLegalCookieConsent(fake.page, locale);

  expect(fake.clickCount()).toBe(0);
  expect(fake.evaluateArguments).toEqual([
    analyticsCheckboxSelector,
    analyticsCheckboxSelector,
  ]);
});

test("detects the hydrated React click handler on the consent control", async () => {
  GlobalRegistrator.register({ url: "https://workspace.example.test/" });
  try {
    document.body.innerHTML = `<input id="cookie-category-analytics" type="checkbox" />`;
    const checkbox = document.querySelector(analyticsCheckboxSelector);
    if (!checkbox) throw new Error("Analytics checkbox is missing.");

    expect(hasReactClickHandler(analyticsCheckboxSelector)).toBe(false);
    // React stores the current props on the element under a random suffix.
    const reactProps: {
      onChange: () => void;
      onClick?: () => void;
    } = { onChange: () => {} };
    Object.assign(checkbox, { __reactProps$test: reactProps });
    expect(hasReactClickHandler(analyticsCheckboxSelector)).toBe(false);
    reactProps.onClick = () => undefined;
    expect(hasReactClickHandler(analyticsCheckboxSelector)).toBe(true);
    expect(hasReactClickHandler("#missing")).toBe(false);
  } finally {
    await GlobalRegistrator.unregister();
  }
});
