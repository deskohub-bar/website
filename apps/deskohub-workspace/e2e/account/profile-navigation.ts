import { parsePhoneNumber } from "@deskohub/phone-number";
import { type Dialog, expect, type Locator, type Page } from "@playwright/test";
import { Option } from "effect";
import {
  type AccountSection,
  accountSectionLabel,
} from "@/features/account/sections";
import { baseLocale, defaultPhoneRegion } from "@/features/i18n";
import {
  type WorkspaceE2EProfileNavigationDiagnosticCode,
  workspaceE2EError,
} from "../errors";
import { workspaceE2ETimeouts } from "../timeouts";
import {
  type AccountSectionSelectionStage,
  accountSectionLandmarks,
  selectAccountSection,
} from "./account-sections";

const homePath = "/en-US";
const accountPath = "/en-US/account";
const profileFormSelector = "#account-profile-form";
const profileFirstNameSelector = "#account-profile-first-name";
const profileLastNameSelector = "#account-profile-last-name";
const profilePhoneSelector = "#account-profile-phone";
const billingKindSelector = "#account-profile-billing-kind";
const billingCompanyNameSelector = "#account-profile-billing-company-name";
const profileSubmitSelector = "#account-profile-submit";
const unavailableHeading = "Customer accounts are temporarily unavailable";
const persistedProfileSelectionDiagnostics: Readonly<
  Record<
    AccountSectionSelectionStage,
    WorkspaceE2EProfileNavigationDiagnosticCode
  >
> = {
  "link-handler-wait": "account_profile_persisted_profile_handler_wait_failed",
  "panel-hydration-wait":
    "account_profile_persisted_profile_panel_hydration_wait_failed",
  "native-link-click": "account_profile_persisted_profile_click_failed",
  "selected-landmark-wait":
    "account_profile_persisted_profile_landmark_wait_failed",
};

type ProfileNavigationFailureKind =
  | "timeout"
  | "strict-mode-violation"
  | "error";

type ProfileNavigationLocator = Pick<
  Locator,
  "click" | "fill" | "inputValue"
> & {
  expectVisible: (options: { timeout: number }) => Promise<void>;
  expectValue: (value: string, options: { timeout: number }) => Promise<void>;
  expectAttribute: (
    name: string,
    value: string,
    options: { timeout: number }
  ) => Promise<void>;
  expectCount: (count: number, options: { timeout: number }) => Promise<void>;
};

type ProfileNavigationDialog = Pick<Dialog, "accept" | "dismiss" | "type">;

export type ProfileNavigationBrowser = {
  locator: (selector: string) => ProfileNavigationLocator;
  headerLink: (name: string) => ProfileNavigationLocator;
  heading: (name: string, level: number) => ProfileNavigationLocator;
  selectSection: (
    section: AccountSection,
    onStage: (stage: AccountSectionSelectionStage) => void
  ) => Promise<void>;
  billingCompanyValidationMessage: () => Promise<string>;
  waitForDialog: (options: {
    timeout: number;
  }) => Promise<ProfileNavigationDialog>;
  historyBack: () => Promise<void>;
  expectURL: (url: string, options: { timeout: number }) => Promise<void>;
  waitForURL: (url: string, options: { timeout: number }) => Promise<void>;
  goto: (
    url: string,
    options: { timeout: number; waitUntil: "load" }
  ) => Promise<unknown>;
};

/**
 * Closed, value-free summary of a Playwright failure. The raw error can carry
 * private profile values, so only its kind leaves this module.
 */
const classifyProfileNavigationFailure = (
  cause: unknown
): ProfileNavigationFailureKind => {
  if (!(cause instanceof Error)) return "error";
  if (cause.name === "TimeoutError") return "timeout";
  return cause.message.includes("strict mode violation")
    ? "strict-mode-violation"
    : "error";
};

export function triggerProfileHistoryBack(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.history.back();
  });
}

const profileNavigationLocator = (
  locator: Locator
): ProfileNavigationLocator => ({
  click: (options) => locator.click(options),
  fill: (value, options) => locator.fill(value, options),
  inputValue: (options) => locator.inputValue(options),
  expectVisible: (options) => expect(locator).toBeVisible(options),
  expectValue: (value, options) => expect(locator).toHaveValue(value, options),
  expectAttribute: (name, value, options) =>
    expect(locator).toHaveAttribute(name, value, options),
  expectCount: (count, options) => expect(locator).toHaveCount(count, options),
});

export function verifyProfileNavigation(
  page: Page,
  baseUrl: string
): Promise<void> {
  return verifyProfileNavigationInBrowser(
    {
      locator: (selector) => profileNavigationLocator(page.locator(selector)),
      headerLink: (name) =>
        profileNavigationLocator(
          page.getByRole("banner").getByRole("link", { exact: true, name })
        ),
      heading: (name, level) =>
        profileNavigationLocator(
          page.getByRole("heading", { exact: true, level, name })
        ),
      selectSection: (section, onStage) =>
        selectAccountSection(page, section, onStage),
      billingCompanyValidationMessage: () =>
        page.locator(billingCompanyNameSelector).evaluate((input) => {
          if (!(input instanceof HTMLInputElement)) {
            throw new Error("billing company name control is not an input");
          }
          return input.validationMessage;
        }),
      waitForDialog: (options) => page.waitForEvent("dialog", options),
      historyBack: () => triggerProfileHistoryBack(page),
      expectURL: (url, options) => expect(page).toHaveURL(url, options),
      waitForURL: (url, options) => page.waitForURL(url, options),
      goto: (url, options) => page.goto(url, options),
    },
    baseUrl
  );
}

export async function verifyProfileNavigationInBrowser(
  browser: ProfileNavigationBrowser,
  baseUrl: string
): Promise<void> {
  let diagnosticCode: WorkspaceE2EProfileNavigationDiagnosticCode =
    "account_profile_baseline_failed";
  let selectionStage: AccountSectionSelectionStage | undefined;
  const selectSection = async (
    section: AccountSection,
    onSelectionStage?: (stage: AccountSectionSelectionStage) => void
  ): Promise<void> => {
    await browser.selectSection(section, (stage) => {
      selectionStage = stage;
      onSelectionStage?.(stage);
    });
    selectionStage = undefined;
  };

  try {
    const homeUrl = new URL(homePath, baseUrl).toString();
    const accountUrl = new URL(accountPath, baseUrl).toString();
    // A section switch records its section in the account pathname.
    const accountSectionUrl = (section: AccountSection) =>
      `${accountUrl}/${section}`;
    const profileForm = browser.locator(profileFormSelector);
    const firstName = browser.locator(profileFirstNameSelector);
    const homeLink = browser.headerLink("Deskohub Workspace");
    const accountLink = browser.headerLink("Account");

    const selectProfileSection = async (
      onSelectionStage?: (stage: AccountSectionSelectionStage) => void
    ): Promise<void> => {
      await selectSection("profile", onSelectionStage);
      if (onSelectionStage) {
        diagnosticCode =
          "account_profile_persisted_profile_form_visibility_failed";
      }
      await profileForm.expectVisible({
        timeout: workspaceE2ETimeouts.browserAction,
      });
    };

    await selectProfileSection();
    const originalProfile = {
      firstName: await firstName.inputValue({
        timeout: workspaceE2ETimeouts.browserAction,
      }),
      lastName: await browser.locator(profileLastNameSelector).inputValue({
        timeout: workspaceE2ETimeouts.browserAction,
      }),
      phone: await browser.locator(profilePhoneSelector).inputValue({
        timeout: workspaceE2ETimeouts.browserAction,
      }),
    };
    const canonicalOriginalPhone = Option.getOrThrowWith(
      parsePhoneNumber(originalProfile.phone, defaultPhoneRegion(baseLocale)),
      () => new Error("profile phone is not a valid canonical phone number")
    );
    await selectSection("billing");
    await browser.locator(accountSectionLandmarks.billing).expectVisible({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await browser
      .heading(accountSectionLabel("billing", "en-US"), 2)
      .expectVisible({ timeout: workspaceE2ETimeouts.browserAction });
    const originalBilling = {
      companyName: await browser
        .locator(billingCompanyNameSelector)
        .inputValue({
          timeout: workspaceE2ETimeouts.browserAction,
        }),
      kind: await browser.locator(billingKindSelector).inputValue({
        timeout: workspaceE2ETimeouts.browserAction,
      }),
    };
    const draftFirstName = `${originalProfile.firstName} draft`.slice(0, 100);
    await selectProfileSection();

    diagnosticCode = "account_profile_clean_navigation_failed";
    await Promise.all([
      browser.waitForURL(homeUrl, {
        timeout: workspaceE2ETimeouts.browserNavigation,
      }),
      homeLink.click({ timeout: workspaceE2ETimeouts.browserAction }),
    ]);

    await accountLink.expectVisible({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await accountLink.expectAttribute("href", accountPath, {
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await Promise.all([
      browser.waitForURL(accountUrl, {
        timeout: workspaceE2ETimeouts.browserNavigation,
      }),
      accountLink.click({ timeout: workspaceE2ETimeouts.browserAction }),
    ]);
    await selectProfileSection();
    await browser
      .heading(unavailableHeading, 1)
      .expectCount(0, { timeout: workspaceE2ETimeouts.browserAction });

    diagnosticCode = "account_profile_draft_retention_failed";
    await firstName.fill(draftFirstName, {
      timeout: workspaceE2ETimeouts.browserAction,
    });

    await selectSection("billing");
    await browser.locator(accountSectionLandmarks.billing).expectVisible({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await browser
      .heading(accountSectionLabel("billing", "en-US"), 2)
      .expectVisible({ timeout: workspaceE2ETimeouts.browserAction });
    await selectProfileSection();
    await firstName.expectValue(draftFirstName, {
      timeout: workspaceE2ETimeouts.browserAction,
    });

    diagnosticCode = "account_profile_hidden_billing_validation_failed";
    await selectSection("billing");
    await browser.locator(accountSectionLandmarks.billing).expectVisible({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await browser.locator(billingCompanyNameSelector).fill("", {
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await selectProfileSection();
    await browser.locator(profileSubmitSelector).click({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await browser.locator(accountSectionLandmarks.billing).expectVisible({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await browser.locator(billingCompanyNameSelector).expectValue("", {
      timeout: workspaceE2ETimeouts.browserAction,
    });
    const hiddenBillingValidationMessage =
      await browser.billingCompanyValidationMessage();
    expect(hiddenBillingValidationMessage).not.toBe("");
    await browser
      .locator(billingCompanyNameSelector)
      .fill(originalBilling.companyName, {
        timeout: workspaceE2ETimeouts.browserAction,
      });
    await selectProfileSection();
    await firstName.expectValue(draftFirstName, {
      timeout: workspaceE2ETimeouts.browserAction,
    });

    // The profile form remains mounted while its profile panel is hidden.
    diagnosticCode = "account_profile_header_dismissal_failed";
    await selectSection("billing");
    const headerClickDialogPromise = browser.waitForDialog({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    const headerClickPromise = homeLink.click({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    const headerClickDialog = await headerClickDialogPromise;
    expect(headerClickDialog.type()).toBe("confirm");
    await headerClickDialog.dismiss();
    await headerClickPromise;
    await browser.expectURL(accountSectionUrl("billing"), {
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await selectProfileSection();
    await firstName.expectValue(draftFirstName, {
      timeout: workspaceE2ETimeouts.browserAction,
    });

    diagnosticCode = "account_profile_history_dismissal_failed";
    const backDialogPromise = browser.waitForDialog({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    const backTriggerPromise = browser.historyBack();
    const backDialog = await backDialogPromise;
    expect(backDialog.type()).toBe("confirm");
    await backDialog.dismiss();
    await backTriggerPromise;
    await browser.expectURL(accountSectionUrl("profile"), {
      timeout: workspaceE2ETimeouts.browserAction,
    });
    await selectProfileSection();
    await firstName.expectValue(draftFirstName, {
      timeout: workspaceE2ETimeouts.browserAction,
    });

    diagnosticCode = "account_profile_discard_confirmation_failed";
    const leaveDialogPromise = browser.waitForDialog({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    const leaveClickPromise = homeLink.click({
      timeout: workspaceE2ETimeouts.browserAction,
    });
    const leaveDialog = await leaveDialogPromise;
    expect(leaveDialog.type()).toBe("confirm");
    await leaveDialog.accept();
    await leaveClickPromise;
    await browser.expectURL(homeUrl, {
      timeout: workspaceE2ETimeouts.browserNavigation,
    });

    diagnosticCode = "account_profile_persisted_document_reload_failed";
    await browser.goto(accountUrl, {
      waitUntil: "load",
      timeout: workspaceE2ETimeouts.browserNavigation,
    });

    diagnosticCode = "account_profile_persisted_profile_navigation_failed";
    await selectProfileSection((stage) => {
      diagnosticCode = persistedProfileSelectionDiagnostics[stage];
    });

    diagnosticCode = "account_profile_persisted_first_name_restore_failed";
    await firstName.expectValue(originalProfile.firstName, {
      timeout: workspaceE2ETimeouts.browserAction,
    });

    diagnosticCode = "account_profile_persisted_last_name_restore_failed";
    await browser
      .locator(profileLastNameSelector)
      .expectValue(originalProfile.lastName, {
        timeout: workspaceE2ETimeouts.browserAction,
      });

    diagnosticCode = "account_profile_persisted_phone_restore_failed";
    await browser
      .locator(profilePhoneSelector)
      .expectValue(canonicalOriginalPhone, {
        timeout: workspaceE2ETimeouts.browserAction,
      });

    diagnosticCode = "account_profile_persisted_billing_navigation_failed";
    await selectSection("billing");

    diagnosticCode = "account_profile_persisted_billing_kind_restore_failed";
    await browser
      .locator(billingKindSelector)
      .expectValue(originalBilling.kind, {
        timeout: workspaceE2ETimeouts.browserAction,
      });

    diagnosticCode = "account_profile_persisted_billing_company_restore_failed";
    await browser
      .locator(billingCompanyNameSelector)
      .expectValue(originalBilling.companyName, {
        timeout: workspaceE2ETimeouts.browserAction,
      });

    diagnosticCode =
      "account_profile_persisted_return_profile_navigation_failed";
    await selectProfileSection();

    diagnosticCode =
      "account_profile_persisted_unavailable_heading_expectation_failed";
    await browser
      .heading(unavailableHeading, 1)
      .expectCount(0, { timeout: workspaceE2ETimeouts.browserAction });
  } catch (cause) {
    const failureKind = classifyProfileNavigationFailure(cause);
    throw workspaceE2EError(
      selectionStage === undefined
        ? `Profile navigation verification failed (${failureKind})`
        : `Profile navigation verification failed at section selection stage ${selectionStage} (${failureKind})`,
      {
        diagnosticCode,
        operation: "verify profile navigation and unsaved changes",
      }
    );
  }
}
