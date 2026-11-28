import { expect, type Locator, type Page } from "@playwright/test";
import { type Locale, m } from "@/features/i18n";
import { workspaceE2ETimeouts } from "./timeouts";

const analyticsCheckboxSelector = "#cookie-category-analytics";

type CookieConsentButton = Pick<Locator, "click" | "isVisible" | "waitFor">;

type CookieConsentControls<Button> = {
  readonly getByRole: (...args: Parameters<Page["getByRole"]>) => Button;
};

type CookieConsentPage = CookieConsentControls<CookieConsentButton> & {
  readonly evaluate: (
    condition: typeof hasReactClickHandler,
    selector: string
  ) => Promise<boolean>;
  readonly locator: (selector: string) => Pick<Locator, "isVisible">;
};

/** The cookie banner's button that saves a necessary-only choice. */
export const cookieBannerNecessaryOnlyButton = <Button>(
  page: CookieConsentControls<Button>,
  locale: Locale
) =>
  page.getByRole("button", {
    exact: true,
    name: m.cookieConsentConsentModalAcceptNecessaryBtn({}, { locale }),
  });

export async function dismissLegalCookieConsent(
  page: CookieConsentPage,
  locale: Locale
): Promise<void> {
  const necessaryOnlyButton = cookieBannerNecessaryOnlyButton(page, locale);

  await expect
    .poll(
      async () =>
        (await necessaryOnlyButton.isVisible()) ||
        ((await page.locator(analyticsCheckboxSelector).isVisible()) &&
          (await page.evaluate(
            hasReactClickHandler,
            analyticsCheckboxSelector
          ))),
      { timeout: workspaceE2ETimeouts.uiTransition }
    )
    .toBe(true);

  if (await necessaryOnlyButton.isVisible()) {
    await necessaryOnlyButton.click({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await necessaryOnlyButton.waitFor({
      state: "hidden",
      timeout: workspaceE2ETimeouts.browserAction,
    });
  }
}

export function hasReactClickHandler(selector: string): boolean {
  const element = document.querySelector(selector);
  if (element === null) return false;

  const reactPropsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$")
  );
  if (reactPropsKey === undefined) return false;

  const reactProps: unknown = Object.getOwnPropertyDescriptor(
    element,
    reactPropsKey
  )?.value;
  if (typeof reactProps !== "object" || reactProps === null) return false;

  return "onClick" in reactProps && typeof reactProps.onClick === "function";
}
