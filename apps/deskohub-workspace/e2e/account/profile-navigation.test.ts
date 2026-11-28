import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { parsePhoneNumber } from "@deskohub/phone-number";
import { chromium, errors } from "@playwright/test";
import { Option } from "effect";
import { baseLocale, defaultPhoneRegion } from "@/features/i18n";
import {
  type AccountSection,
  accountSectionLabel,
} from "../../features/account/sections";
import { playwrightChromiumAvailable } from "../../shared/testing/playwright-browser";
import {
  isWorkspaceE2EDiagnosticCode,
  WorkspaceE2EError,
  type WorkspaceE2EProfileNavigationDiagnosticCode,
} from "../errors";
import { formatWorkspaceE2EFailureAnnotation } from "../github-actions";
import {
  type AccountSectionNavigationPage,
  accountSectionLandmarks,
  selectAccountSection,
} from "./account-sections";
import {
  type ProfileNavigationBrowser,
  triggerProfileHistoryBack,
  verifyProfileNavigationInBrowser,
} from "./profile-navigation";

type ProfileNavigationDialog = Awaited<
  ReturnType<ProfileNavigationBrowser["waitForDialog"]>
>;

type ProfileNavigationState = {
  billing: {
    companyName: string;
    kind: string;
  };
  dirty: boolean;
  profile: {
    firstName: string;
    lastName: string;
    phone: string;
  };
  section: AccountSection;
  url: string;
};

type ProfileNavigationFailurePhase =
  | "saved-profile-baseline"
  | "profile-handler-wait";

const privateFailureDetails = "private profile navigation fixture details";

const makeProfileNavigationBrowser = (
  baseUrl: string,
  failurePhase?: ProfileNavigationFailurePhase
): ProfileNavigationBrowser => {
  const homeUrl = `${baseUrl}/en-US`;
  const accountUrl = `${baseUrl}/en-US/account`;
  const originalProfile = {
    firstName: "Ada",
    lastName: "Example",
    phone: "+420 555 000 111",
  };
  const normalizedPhone = Option.getOrThrowWith(
    parsePhoneNumber(originalProfile.phone, defaultPhoneRegion(baseLocale)),
    () => new Error("fake profile phone is not a valid canonical phone number")
  );
  const serverSnapshot = {
    ...originalProfile,
    phone: normalizedPhone,
  };
  const originalBilling = {
    companyName: "Original Company",
    kind: "business",
  };
  const state: ProfileNavigationState = {
    billing: { ...originalBilling },
    dirty: false,
    profile: { ...originalProfile },
    section: "reservations",
    url: accountUrl,
  };
  let dialogResolver: ((dialog: ProfileNavigationDialog) => void) | undefined;
  let documentReloaded = false;

  const isProfileFormVisible = () =>
    state.section === "profile" || state.section === "billing";
  const isVisible = (name: string) => {
    if (name === "#account-profile-form") return isProfileFormVisible();
    if (name === accountSectionLandmarks.profile)
      return state.section === "profile";
    if (name === accountSectionLandmarks.billing)
      return state.section === "billing";
    if (name === "#account-profile-submit") return isProfileFormVisible();
    if (name === "#account-profile-billing-company-name")
      return state.section === "billing" && state.billing.kind === "business";
    return true;
  };
  const valueFor = (name: string) => {
    switch (name) {
      case "#account-profile-first-name":
        return state.profile.firstName;
      case "#account-profile-last-name":
        return state.profile.lastName;
      case "#account-profile-phone":
        return state.profile.phone;
      case "#account-profile-billing-company-name":
        return state.billing.companyName;
      case "#account-profile-billing-kind":
        return state.billing.kind;
      default:
        return "";
    }
  };
  const countFor = (name: string) =>
    name.startsWith("heading:Customer accounts are temporarily unavailable")
      ? 0
      : 1;
  // Like the account layout, a section switch records its section in the
  // account pathname.
  const switchSection = (section: AccountSection) => {
    state.section = section;
    state.url = `${accountUrl}/${section}`;
  };

  const requestDialog = (kind: "history-back" | "home") => {
    const { promise: action, resolve: resolveAction } =
      Promise.withResolvers<void>();
    const dialog = {
      accept: async () => {
        if (kind === "home") {
          state.url = homeUrl;
          state.section = "reservations";
          state.dirty = false;
        }
        resolveAction();
      },
      dismiss: async () => {
        resolveAction();
      },
      type: () => "confirm",
    };
    dialogResolver?.(dialog);
    dialogResolver = undefined;
    return action;
  };

  const makeLocator = (
    name: string
  ): ReturnType<ProfileNavigationBrowser["locator"]> => ({
    expectAttribute: async (attribute, value) => {
      expect(name).toBe("account-link");
      expect(attribute).toBe("href");
      expect(value).toBe("/en-US/account");
    },
    expectCount: async (count) => {
      expect(countFor(name)).toBe(count);
    },
    expectValue: async (value) => {
      expect(valueFor(name)).toBe(value);
    },
    expectVisible: async () => {
      expect(isVisible(name)).toBe(true);
    },
    click: async () => {
      if (name === "home-link") {
        if (state.dirty) return requestDialog("home");
        state.url = homeUrl;
        state.section = "reservations";
        return;
      }
      if (name === "account-link") {
        state.url = accountUrl;
        state.section = "reservations";
        return;
      }
      if (name === "#account-profile-submit") {
        if (
          state.billing.kind === "business" &&
          state.billing.companyName === ""
        ) {
          switchSection("billing");
        }
      }
    },
    fill: async (value: string) => {
      if (
        name === "#account-profile-billing-company-name" &&
        state.section !== "billing"
      ) {
        throw new Error("billing company fill attempted while hidden");
      }
      switch (name) {
        case "#account-profile-first-name":
          state.profile.firstName = value;
          break;
        case "#account-profile-billing-company-name":
          state.billing.companyName = value;
          break;
      }
      state.dirty = true;
    },
    inputValue: async () => {
      if (
        failurePhase === "saved-profile-baseline" &&
        name === "#account-profile-first-name"
      ) {
        throw new Error(privateFailureDetails);
      }
      return valueFor(name);
    },
  });

  const sectionPage: AccountSectionNavigationPage = {
    getSectionLink: (label) => {
      const section = (["profile", "billing"] as const).find(
        (candidate) => accountSectionLabel(candidate, "en-US") === label
      );
      if (section === undefined)
        throw new Error(`unexpected section: ${label}`);
      return {
        click: async () => switchSection(section),
        waitForHandler: async () => {
          if (
            documentReloaded &&
            failurePhase === "profile-handler-wait" &&
            section === "profile"
          ) {
            throw new errors.TimeoutError(privateFailureDetails);
          }
        },
      };
    },
    viewportSize: () => ({ height: 900, width: 1440 }),
    waitForFunction: async (
      _predicate: unknown,
      target: string | { readonly section: AccountSection }
    ) => {
      if (typeof target !== "string" && target.section !== state.section) {
        throw new Error("profile fixture did not select the requested section");
      }
    },
  };

  return {
    locator: makeLocator,
    headerLink: (name) => {
      if (name === "Deskohub Workspace") return makeLocator("home-link");
      if (name === "Account") return makeLocator("account-link");
      throw new Error(`unsupported banner link: ${name}`);
    },
    heading: (name) => makeLocator(`heading:${name}`),
    selectSection: (section, onStage) =>
      selectAccountSection(sectionPage, section, onStage),
    billingCompanyValidationMessage: async () => "Please fill out this field.",
    historyBack: () => requestDialog("history-back"),
    waitForDialog: () => {
      const { promise, resolve } =
        Promise.withResolvers<ProfileNavigationDialog>();
      dialogResolver = resolve;
      return promise;
    },
    goto: async (url) => {
      if (url !== accountUrl)
        throw new Error(`unsupported document URL: ${url}`);
      state.url = url;
      state.section = "reservations";
      state.dirty = false;
      state.profile = { ...serverSnapshot };
      state.billing = { ...originalBilling };
      documentReloaded = true;
    },
    expectURL: async (url) => {
      expect(state.url).toBe(url);
    },
    waitForURL: (url) =>
      Promise.resolve().then(() => {
        expect(state.url).toBe(url);
      }),
  };
};

const chromiumAvailable = await playwrightChromiumAvailable();

const startNavigationTestServer = async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`
      <!doctype html>
      <title>ready</title>
      <script>
        if (window.navigation) {
          window.navigation.addEventListener("navigate", (event) => {
            if (event.navigationType !== "traverse") return;
            document.title = "cancelled-back";
            event.preventDefault();
          });
        }
      </script>
    `);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("navigation regression server did not receive a port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

test("redacts a saved-profile baseline failure with its closed diagnostic", async () => {
  const browser = makeProfileNavigationBrowser(
    "https://account-navigation.example.test",
    "saved-profile-baseline"
  );
  const failure = await verifyProfileNavigationInBrowser(
    browser,
    "https://account-navigation.example.test"
  ).then(
    () => undefined,
    (cause: unknown) => cause
  );

  expectProfileNavigationFailure(failure, "account_profile_baseline_failed");
});

test("names the section selection stage and failure kind without the private cause", async () => {
  const browser = makeProfileNavigationBrowser(
    "https://account-navigation.example.test",
    "profile-handler-wait"
  );
  const failure = await verifyProfileNavigationInBrowser(
    browser,
    "https://account-navigation.example.test"
  ).then(
    () => undefined,
    (cause: unknown) => cause
  );

  expectProfileNavigationFailure(
    failure,
    "account_profile_persisted_profile_handler_wait_failed"
  );
  expect(failure).toMatchObject({
    message:
      "Profile navigation verification failed at section selection stage link-handler-wait (timeout)",
  });
});

const closedProfileNavigationFailureMessage =
  /^Profile navigation verification failed (at section selection stage (link-handler-wait|panel-hydration-wait|native-link-click|selected-landmark-wait) )?\((timeout|strict-mode-violation|error)\)$/;

const expectProfileNavigationFailure = (
  failure: unknown,
  diagnosticCode: WorkspaceE2EProfileNavigationDiagnosticCode
) => {
  expect(failure).toBeInstanceOf(WorkspaceE2EError);
  if (!(failure instanceof WorkspaceE2EError)) return;

  expect(failure.diagnosticCode).toBe(diagnosticCode);
  expect(isWorkspaceE2EDiagnosticCode(failure.diagnosticCode)).toBe(true);
  expect(failure).toMatchObject({
    diagnosticCode,
    operation: "verify profile navigation and unsaved changes",
  });
  expect(failure.message).toMatch(closedProfileNavigationFailureMessage);
  expect(failure.cause).toBeUndefined();
  expect(failure.causes).toBeUndefined();
  expect(failure.message).not.toContain(privateFailureDetails);
  expect(JSON.stringify(failure)).not.toContain(privateFailureDetails);
  const annotation = formatWorkspaceE2EFailureAnnotation({
    caseId: "account-profile-completion",
    diagnosticCode: failure.diagnosticCode,
    failureKind: "error",
    outcome: "failed",
    stepId: "verifyPages",
  });
  expect(annotation).toContain(`diagnostic_code=${diagnosticCode}`);
  expect(annotation).not.toContain(privateFailureDetails);
};

test.skipIf(!chromiumAvailable)(
  "resolves the evaluated trigger when the Navigation API cancels same-document back",
  async () => {
    const server = await startNavigationTestServer();
    try {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${server.baseUrl}/first`);
        await page.evaluate(() => {
          window.history.pushState({}, "", "/second");
        });

        expect(await page.evaluate(() => "navigation" in window)).toBe(true);

        const triggerOutcome = await Promise.race([
          triggerProfileHistoryBack(page).then(() => "resolved" as const),
          new Promise<"timed-out">((resolve) =>
            setTimeout(() => resolve("timed-out"), 1000)
          ),
        ]);

        expect(triggerOutcome).toBe("resolved");
        await page.waitForFunction(() => document.title === "cancelled-back", {
          timeout: 1000,
        });
        expect(page.url()).toBe(`${server.baseUrl}/second`);
      } finally {
        await browser.close();
      }
    } finally {
      await server.close();
    }
  }
);
