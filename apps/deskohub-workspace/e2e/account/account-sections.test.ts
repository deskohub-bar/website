import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useState } from "react";
import { AccountShell } from "@/features/account/components/shell/account-shell";
import { getAccountSectionPath } from "@/features/account/routes";
import type { AccountSection } from "@/features/account/sections";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { requireHydratedAccountLink } from "./account-link.test-utils";
import {
  type AccountSectionNavigationPage,
  accountSectionLandmarks,
  selectAccountSection,
} from "./account-sections";

const sections = [
  "reservations",
  "referrals",
  "profile",
  "assistants",
  "billing",
  "legal",
  "danger",
] as const satisfies readonly AccountSection[];

const accountSectionDataAttribute = "data-account-section";

const sectionPanel = (section: AccountSection, includeLegalLink: boolean) => {
  switch (section) {
    case "reservations":
      return createElement(
        "h2",
        { id: "account-reservations-past-title" },
        "Past reservations"
      );
    case "referrals":
      return createElement(
        "section",
        { "data-screen": "referrals-screen" },
        createElement("h2", null, "Referrals")
      );
    case "profile":
      return createElement(
        "section",
        { "data-screen": "profile-screen" },
        createElement("input", { id: "account-profile-first-name" })
      );
    case "assistants":
      return createElement(
        "h2",
        { id: "account-assistants-title" },
        "Connected assistants"
      );
    case "billing":
      return createElement(
        "section",
        { "aria-labelledby": "account-billing-title" },
        createElement("h2", { id: "account-billing-title" }, "Billing"),
        createElement("select", { id: "account-profile-billing-kind" })
      );
    case "legal":
      return includeLegalLink
        ? createElement(
            "section",
            { "aria-labelledby": "account-legal-title" },
            createElement("h2", { id: "account-legal-title" }, "Legal"),
            // The real section links to the privacy policy more than once.
            createElement(
              "a",
              { href: "/en-US/privacy-policy" },
              "Privacy policy"
            ),
            createElement(
              "a",
              { href: "/en-US/privacy-policy" },
              "privacy policy"
            )
          )
        : null;
    case "danger":
      return createElement(
        "button",
        { id: "delete-account-trigger", type: "button" },
        "Delete account"
      );
  }
};

function AccountShellHarness({
  includeLegalLink = true,
  reservationCount,
}: {
  readonly includeLegalLink?: boolean;
  readonly reservationCount?: number;
}) {
  const [activeSection, setActiveSection] =
    useState<AccountSection>("reservations");

  return createElement(
    "div",
    null,
    createElement(
      AccountShell,
      {
        activeSection,
        // The variadic children below are the rendered panels; this satisfies
        // AccountShellProps' required children field without replacing them.
        // biome-ignore lint/correctness/noChildrenProp: AccountShellProps requires children in its createElement props type.
        children: null,
        locale: "en-US",
        onSectionChange: setActiveSection,
        reservationCount,
        signOut: createElement("button", { type: "button" }, "Sign out"),
      },
      ...sections.map((section) =>
        createElement(
          "div",
          { hidden: activeSection !== section, key: section },
          sectionPanel(section, includeLegalLink)
        )
      )
    ),
    createElement(
      "footer",
      { "data-testid": "public-site-footer" },
      createElement("a", { href: "/en-US/privacy-policy" }, "Privacy policy")
    )
  );
}

const desktopBreakpoint = 768;

const elementIsVisible = (element: Element, width: number | null): boolean => {
  for (
    let current: Element | null = element;
    current !== null;
    current = current.parentElement
  ) {
    if (current.hasAttribute("hidden")) return false;
    if (
      width !== null &&
      ((current.classList.contains("md:hidden") &&
        width >= desktopBreakpoint) ||
        (current.classList.contains("hidden") && width < desktopBreakpoint))
    )
      return false;
    const styles = window.getComputedStyle(current);
    if (styles.display === "none" || styles.visibility === "hidden") {
      return false;
    }
  }
  return true;
};

const fakeLocator = (element: Element, width: number | null) => ({
  click: async () => {
    if (!elementIsVisible(element, width))
      throw new Error("fake target is hidden");
    fireEvent.click(element);
  },
  waitForHandler: async () => requireHydratedAccountLink(element),
});

const makeFakePage = (width: number | null): AccountSectionNavigationPage => ({
  getSectionLink: (label) => {
    const candidates = Array.from(document.querySelectorAll("a"));
    const match = candidates.find((element) => {
      if (!elementIsVisible(element, width)) return false;
      const accessibleName =
        element.textContent?.replaceAll(/\s+/g, " ").trim() ?? "";
      return accessibleName.includes(label);
    });
    if (!match) throw new Error("fake link target was not found");
    return fakeLocator(match, width);
  },
  viewportSize: () => (width === null ? null : { height: 900, width }),
  waitForFunction: async <A>(predicate: (arg: A) => boolean, arg: A) => {
    if (!predicate(arg)) throw new Error("fake account section did not settle");
  },
});

const setResponsiveNavigationVisibility = (
  mode: "desktop" | "mobile"
): void => {
  const navigation = document
    .querySelector("[data-account-mobile-navigation]")
    ?.closest("nav");
  if (!navigation) throw new Error("fake account navigation was not rendered");

  for (const child of Array.from(navigation.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.classList.contains("md:hidden")) {
      child.style.display = mode === "mobile" ? "block" : "none";
    }
    if (child.classList.contains("hidden")) {
      child.style.display = mode === "desktop" ? "block" : "none";
    }
  }
};

beforeAll(registerWorkspaceComponentTestEnv);
afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("selects every section through rendered desktop AccountShell controls", async () => {
  const page = makeFakePage(1440);
  render(createElement(AccountShellHarness));

  for (const section of sections) {
    await selectAccountSection(page, section);

    const landmark = document.querySelector(accountSectionLandmarks[section]);
    expect(landmark).toBeTruthy();
    expect(landmark?.closest("[hidden]")).toBeNull();

    const link = document.querySelector(
      `a[data-account-sidebar-section="${section}"]`
    );
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.getAttribute("href")).toBe(
      getAccountSectionPath("en-US", section)
    );
  }
});

test("does not accept the public footer as the legal account landmark", async () => {
  const page = makeFakePage(1440);
  render(
    createElement(AccountShellHarness, {
      includeLegalLink: false,
    })
  );

  await expect(selectAccountSection(page, "legal")).rejects.toThrow(
    "fake account section did not settle"
  );
});

for (const reservationCount of [0, 3] as const) {
  test(`accepts the rendered Reservations label with count ${reservationCount}`, async () => {
    const page = makeFakePage(1440);
    render(
      createElement(AccountShellHarness, {
        reservationCount,
      })
    );

    await selectAccountSection(page, "reservations");

    expect(
      document.querySelector(accountSectionLandmarks.reservations)
    ).toBeTruthy();
  });
}

test("selects every section through visible mobile section links", async () => {
  const page = makeFakePage(375);
  render(createElement(AccountShellHarness));

  for (const section of sections) {
    await selectAccountSection(page, section);

    const mobileNavigation = document.querySelector(
      "[data-account-mobile-navigation]"
    );
    const link = mobileNavigation?.querySelector<HTMLAnchorElement>(
      `[${accountSectionDataAttribute}="${section}"]`
    );
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.getAttribute("href")).toBe(
      getAccountSectionPath("en-US", section)
    );
    expect(
      mobileNavigation?.querySelectorAll('a[aria-current="page"]')
    ).toHaveLength(1);
    expect(
      document
        .querySelector(accountSectionLandmarks[section])
        ?.closest("[hidden]")
    ).toBeNull();
  }
});

test("resolves the responsive section variant when viewport size is unavailable", async () => {
  for (const mode of ["mobile", "desktop"] as const) {
    cleanup();
    const page = makeFakePage(null);
    render(createElement(AccountShellHarness));
    setResponsiveNavigationVisibility(mode);

    for (const section of sections) {
      await selectAccountSection(page, section);

      const activeLinks = document.querySelectorAll(
        mode === "mobile"
          ? '[data-account-mobile-navigation] a[aria-current="page"]'
          : 'a[data-account-sidebar-section][aria-current="page"]'
      );
      expect(activeLinks).toHaveLength(1);
      expect(
        activeLinks[0]?.getAttribute(
          mode === "mobile"
            ? "data-account-section"
            : "data-account-sidebar-section"
        )
      ).toBe(section);
      expect(
        document
          .querySelector(accountSectionLandmarks[section])
          ?.closest("[hidden]")
      ).toBeNull();
    }
  }
});
