import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import assert from "node:assert/strict";
import { testEmailAddress } from "@deskohub/test-email";
import React, { Activity, type ComponentPropsWithoutRef } from "react";
import type * as accountActions from "@/features/account/actions";
import type * as avatarActions from "@/features/account/avatar-actions";
import type { CustomerAvatarPresentation } from "@/features/account/contracts";
import { m } from "@/features/i18n";
import { formatReferralInvitationDiscount } from "@/features/referrals/client";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import type { ProfileForm } from "./profile-form";
import { getProfileForm, getProfileInput } from "./profile-form.test-utils";

const adaAddress = testEmailAddress("ada");

registerWorkspaceComponentTestEnv();
const { act, cleanup, fireEvent, render } = await import(
  "@testing-library/react"
);

type CompletionResult = Awaited<
  ReturnType<typeof accountActions.completeCustomerProfile>
>;
type UpdateResult = Awaited<
  ReturnType<typeof accountActions.updateCustomerProfile>
>;

const workspaceRouterRefresh = mock(() => undefined);
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ refresh: workspaceRouterRefresh }),
}));

const completeCustomerProfile = mock<
  typeof accountActions.completeCustomerProfile
>(() => Promise.resolve({ data: { status: "completed" } }));
const updateCustomerProfile = mock<typeof accountActions.updateCustomerProfile>(
  () => Promise.resolve({ data: { status: "updated" } })
);
const uploadCustomerAvatar = mock<typeof avatarActions.uploadCustomerAvatar>(
  () =>
    Promise.resolve({
      data: {
        avatar: {
          url: "https://res.cloudinary.test/upload/v2/avatars/live",
          version: 2,
        },
        status: "uploaded",
      },
    })
);
const removeCustomerAvatar = mock<typeof avatarActions.removeCustomerAvatar>(
  () => Promise.resolve({ data: { status: "removed" } })
);

mock.module(
  "@/features/account/actions",
  (): Partial<typeof accountActions> => ({
    acknowledgeSignupReferralNotice: () =>
      Promise.resolve({ data: { status: "acknowledged" } }),
    updateLocalePreference: () =>
      Promise.resolve({ data: { status: "saved" } }),
    lookupAresBusiness: () =>
      Promise.resolve({ data: { status: "not-found", message: "" } }),
    completeCustomerProfile,
    updateCustomerProfile,
  })
);
const refreshAnalyticsDotyposCustomerId = mock(() => undefined);
mock.module("@/features/account/analytics-customer-link", () => ({
  refreshAnalyticsDotyposCustomerId,
}));
mock.module("@/features/account/avatar-actions", () => ({
  removeCustomerAvatar,
  uploadCustomerAvatar,
}));
type NavigateEvent = {
  readonly preventDefault: () => void;
};

type MockNextLinkProps = ComponentPropsWithoutRef<"a"> & {
  readonly href: string;
  readonly onNavigate?: (event: NavigateEvent) => void;
};

const MockNextLink = React.forwardRef<HTMLAnchorElement, MockNextLinkProps>(
  function MockNextLink(
    { children, href, onClick, onNavigate, ...props },
    ref
  ) {
    return (
      <a
        ref={ref}
        href={href}
        {...props}
        onClick={(event) => {
          onClick?.(event);
          const destination = new URL(href, window.location.href);
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            (event.currentTarget.target !== "" &&
              event.currentTarget.target !== "_self") ||
            event.currentTarget.hasAttribute("download") ||
            destination.origin !== window.location.origin
          ) {
            return;
          }
          onNavigate?.({
            preventDefault: () => event.preventDefault(),
          });
        }}
      >
        {children}
      </a>
    );
  }
);

mock.module("next/link", () => ({ default: MockNextLink }));

const { GuardedLink } = await import("@/shared/components/guarded-link");

const editProfile = {
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+420601111222",
  billing: null,
};

const businessProfile = {
  ...editProfile,
  billing: {
    kind: "business" as const,
    addressLine1: "Original Street 1",
    addressLine2: null,
    city: "Prague",
    zip: "11000",
    country: "CZ",
    companyName: "Original Company",
    companyId: "12345678",
    vatId: null,
  },
};

const personalProfile = {
  ...editProfile,
  billing: {
    kind: "personal" as const,
    addressLine1: "Original Street 1",
    addressLine2: null,
    city: "Prague",
    zip: "11000",
    country: "CZ",
    companyName: null,
    companyId: null,
    vatId: null,
  },
};

describe("ProfileForm", () => {
  beforeAll(() => {
    registerWorkspaceComponentTestEnv();
  });

  afterEach(() => {
    cleanup();
    completeCustomerProfile.mockClear();
    updateCustomerProfile.mockClear();
    // Client validation can now reject invalid input before the action runs,
    // so queued mockImplementationOnce results from a previous test would
    // otherwise leak into the next action call.
    completeCustomerProfile.mockImplementation(() =>
      Promise.resolve({ data: { status: "completed" } })
    );
    updateCustomerProfile.mockImplementation(() =>
      Promise.resolve({ data: { status: "updated" } })
    );
    uploadCustomerAvatar.mockClear();
    removeCustomerAvatar.mockClear();
    workspaceRouterRefresh.mockClear();
    refreshAnalyticsDotyposCustomerId.mockClear();
  });

  afterAll(async () => {
    await unregisterWorkspaceComponentTestEnv();
  });

  test("renders the verified login email as immutable profile text", async () => {
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm
        mode="edit"
        locale="en-US"
        email={adaAddress}
        profile={editProfile}
      />
    );
    expect(view.getByText(adaAddress)).toBeTruthy();
    expect(view.container.querySelector("#account-profile-email")).toBeNull();
    expect(
      view.queryByText(
        "To protect your reservation history, the login email cannot be changed."
      )
    ).toBeNull();
  });

  test("submits the profile without any email field for the completion mode", async () => {
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm mode="complete" locale="en-US" email={adaAddress} />
    );
    fireEvent.change(view.getByLabelText("First name"), {
      target: { value: "Ada" },
    });

    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    expect(completeCustomerProfile).toHaveBeenCalledTimes(1);
    const input = completeCustomerProfile.mock.calls[0]?.[0];
    expect(input).toEqual({ firstName: "Ada" });
    expect(JSON.stringify(input)).not.toContain("email");
    expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    // Completion creates the Dotypos customer the analytics person links to.
    expect(refreshAnalyticsDotyposCustomerId).toHaveBeenCalledTimes(1);
    await view.findByText("Your customer profile was created and linked.");
  });

  test("offers an optional referral code only during first-time completion", async () => {
    const { ProfileForm } = await import("./profile-form");
    const { parseReferralCode } = await import("@/features/referrals/client");

    const view = render(
      <ProfileForm
        mode="complete"
        locale="en-US"
        email={adaAddress}
        referralCode={parseReferralCode("RFL12345")}
        referralsEnabled
      />
    );
    const field = getProfileInput(
      view,
      m.accountProfileReferralCodeLabel({}, { locale: "en-US" })
    );
    expect(field.id).toBe("profile-referral-code");
    expect(field.name).toBe("referralCode");
    expect(field.value).toBe("RFL12345");
    expect(field.required).toBe(false);
    expect(field.className).toContain("uppercase");
    expect(
      view.getByText(
        m.accountProfileReferralCodeHint(
          { discount: formatReferralInvitationDiscount("en-US") },
          { locale: "en-US" }
        )
      )
    ).toBeTruthy();

    fireEvent.change(view.getByLabelText("First name"), {
      target: { value: "Ada" },
    });
    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    expect(completeCustomerProfile.mock.calls[0]?.[0]).toEqual({
      firstName: "Ada",
      referralCode: "RFL12345",
      prefilledReferralCode: "RFL12345",
    });
    view.unmount();

    const edit = render(
      <ProfileForm
        mode="edit"
        locale="en-US"
        email={adaAddress}
        profile={editProfile}
      />
    );
    expect(edit.container.querySelector("#profile-referral-code")).toBeNull();
  });

  test("offers no referral code field while the referral program is withheld", async () => {
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm
        mode="complete"
        locale="en-US"
        email={adaAddress}
        referralsEnabled={false}
      />
    );

    expect(view.container.querySelector("#profile-referral-code")).toBeNull();
    expect(
      view.queryByLabelText(
        m.accountProfileReferralCodeLabel({}, { locale: "en-US" })
      )
    ).toBeNull();
  });

  test("shows an unavailable referral code on its field without completing", async () => {
    completeCustomerProfile.mockImplementationOnce(() =>
      Promise.resolve({ data: { status: "referral-code-unavailable" } })
    );
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm
        mode="complete"
        locale="cs-CZ"
        email={adaAddress}
        referralsEnabled
      />
    );
    fireEvent.change(view.getByLabelText("Jméno"), {
      target: { value: "Ada" },
    });
    const field = view.container.querySelector("#profile-referral-code");
    assert(field instanceof HTMLInputElement);
    fireEvent.change(field, { target: { value: "rflgone1" } });
    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    expect(completeCustomerProfile.mock.calls[0]?.[0]).toEqual({
      firstName: "Ada",
      referralCode: "rflgone1",
    });
    expect(
      await view.findByText(
        m.accountProfileReferralCodeUnavailable({}, { locale: "cs-CZ" })
      )
    ).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(
      view.queryByText(m.accountCompletionSaved({}, { locale: "cs-CZ" }))
    ).toBeNull();
    expect(workspaceRouterRefresh).not.toHaveBeenCalled();
    expect(view.container.querySelector("#profile-referral-code")).toBeTruthy();
  });

  test("leaves an over-long referral code to the server's validation", async () => {
    completeCustomerProfile.mockImplementationOnce(() =>
      Promise.resolve({
        validationErrors: {
          formErrors: [],
          fieldErrors: { referralCode: ["Too long."] },
        },
      })
    );
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm
        mode="complete"
        locale="en-US"
        email={adaAddress}
        referralsEnabled
      />
    );
    fireEvent.change(view.getByLabelText("First name"), {
      target: { value: "Ada" },
    });
    const field = view.container.querySelector("#profile-referral-code");
    assert(field instanceof HTMLInputElement);
    const referralCode = "A".repeat(65);
    fireEvent.change(field, { target: { value: referralCode } });
    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    expect(completeCustomerProfile.mock.calls[0]?.[0]).toEqual({
      firstName: "Ada",
      referralCode,
    });
    expect(
      await view.findByText(
        m.accountProfileValidationError({}, { locale: "en-US" })
      )
    ).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(
      view.getByText(
        m.accountProfileReferralCodeUnavailable({}, { locale: "en-US" })
      ).id
    ).toBe("profile-referral-code-error");
  });

  test("keeps the full edit snapshot and drafts across identity and billing sections", async () => {
    const { ProfileForm } = await import("./profile-form");

    function SectionHarness() {
      const [section, setSection] = React.useState<"profile" | "billing">(
        "profile"
      );
      return (
        <>
          <button type="button" onClick={() => setSection("profile")}>
            Identity section
          </button>
          <button type="button" onClick={() => setSection("billing")}>
            Billing section
          </button>
          <ProfileForm
            email={adaAddress}
            locale="en-US"
            mode="edit"
            profile={businessProfile}
            section={section}
          />
        </>
      );
    }

    const view = render(<SectionHarness />);
    fireEvent.input(view.getByLabelText("First name"), {
      target: { value: "Grace" },
    });
    fireEvent.input(view.getByLabelText("Last name"), {
      target: { value: "Byron" },
    });
    fireEvent.input(view.getByLabelText("Phone"), {
      target: { value: "+420602222333" },
    });
    fireEvent.click(view.getByRole("button", { name: "Billing section" }));

    await act(async () => {
      fireEvent.input(view.getByLabelText("Company name"), {
        target: { value: "Draft Company" },
      });
      fireEvent.input(view.getByLabelText("Company ID (IČO)"), {
        target: { value: "87654321" },
      });
      fireEvent.input(view.getByLabelText("VAT ID"), {
        target: { value: "CZ87654321" },
      });
      fireEvent.input(view.getByLabelText("Street and number"), {
        target: { value: "Draft Street 2" },
      });
      fireEvent.input(view.getByLabelText("Apartment, suite"), {
        target: { value: "Suite 2" },
      });
      fireEvent.input(view.getByLabelText("City"), {
        target: { value: "Brno" },
      });
      fireEvent.input(view.getByLabelText("Postal code"), {
        target: { value: "60200" },
      });
      fireEvent.input(view.getByLabelText("Country code"), {
        target: { value: "CZ" },
      });
    });

    const form = getProfileForm(view);
    await act(async () => {
      fireEvent.submit(form);
      await Promise.resolve();
    });

    expect(updateCustomerProfile).toHaveBeenCalledTimes(1);
    expect(updateCustomerProfile.mock.calls[0]?.[0]).toEqual({
      firstName: "Grace",
      lastName: "Byron",
      phone: "+420602222333",
      billing: {
        kind: "business",
        companyName: "Draft Company",
        companyId: "87654321",
        vatId: "CZ87654321",
        addressLine1: "Draft Street 2",
        addressLine2: "Suite 2",
        city: "Brno",
        zip: "60200",
        country: "CZ",
      },
    });
    expect(view.getByText("Profile updated.")).toBeTruthy();
    expect(
      view.container.querySelectorAll("#account-profile-feedback")
    ).toHaveLength(1);
    expect(
      view.container.querySelectorAll("#account-profile-submit")
    ).toHaveLength(1);
    expect(workspaceRouterRefresh).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Identity section" }));
    fireEvent.click(view.getByRole("button", { name: "Billing section" }));
    expect(getProfileInput(view, "Company name").value).toBe("Draft Company");
    expect(getProfileInput(view, "Street and number").value).toBe(
      "Draft Street 2"
    );
    expect(view.getByText("Profile updated.")).toBeTruthy();
  });

  test("returns to profile when a hidden required identity field is invalid", async () => {
    const { ProfileForm } = await import("./profile-form");

    function SectionHarness() {
      const [section, setSection] = React.useState<"profile" | "billing">(
        "profile"
      );
      return (
        <>
          <button type="button" onClick={() => setSection("profile")}>
            Identity section
          </button>
          <button type="button" onClick={() => setSection("billing")}>
            Billing section
          </button>
          <output data-testid="active-section">{section}</output>
          <ProfileForm
            email={adaAddress}
            locale="en-US"
            mode="edit"
            onSectionChange={setSection}
            profile={businessProfile}
            section={section}
          />
        </>
      );
    }

    const view = render(<SectionHarness />);
    fireEvent.click(view.getByRole("button", { name: "Billing section" }));
    fireEvent.input(view.getByLabelText("Company name"), {
      target: { value: "Draft Company" },
    });
    fireEvent.input(view.getByLabelText("First name"), {
      target: { value: "" },
    });

    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    const firstName = getProfileInput(view, "First name");
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(view.getByTestId("active-section").textContent).toBe("profile");
    expect(firstName.validity.valid).toBe(false);
    expect(view.getByText("Enter your first name.")).toBeTruthy();
    expect(
      view.container.querySelector("[data-screen='profile-screen']")
        ?.parentElement?.hidden
    ).toBe(false);

    fireEvent.click(view.getByRole("button", { name: "Billing section" }));
    expect(getProfileInput(view, "Company name").value).toBe("Draft Company");
  });

  test("returns to billing when a hidden required billing field is invalid", async () => {
    const { ProfileForm } = await import("./profile-form");

    function SectionHarness() {
      const [section, setSection] = React.useState<"profile" | "billing">(
        "profile"
      );
      return (
        <>
          <output data-testid="active-section">{section}</output>
          <ProfileForm
            email={adaAddress}
            locale="en-US"
            mode="edit"
            onSectionChange={setSection}
            profile={businessProfile}
            section={section}
          />
        </>
      );
    }

    const view = render(<SectionHarness />);
    const companyName = getProfileInput(view, "Company name");
    fireEvent.input(companyName, { target: { value: "" } });

    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(view.getByTestId("active-section").textContent).toBe("billing");
    expect(companyName.validity.valid).toBe(false);
    expect(
      view.getByRole("region", {
        name: m.accountSectionBilling({}, { locale: "en-US" }),
      }).parentElement?.hidden
    ).toBe(false);
  });

  test("keeps a deferred completion draft for the next update save", async () => {
    const { promise: pendingCompletion, resolve: resolveCompletion } =
      Promise.withResolvers<CompletionResult>();
    completeCustomerProfile.mockImplementationOnce(() => pendingCompletion);

    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm mode="complete" locale="en-US" email={adaAddress} />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const firstName = getProfileInput(view, "First name");
      const form = getProfileForm(view);

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Ada" } });
        fireEvent.submit(form);
      });
      expect(view.container.querySelector("fieldset")?.disabled).toBe(false);
      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
      });

      await act(async () => {
        resolveCompletion({ data: { status: "completed" } });
        await pendingCompletion;
      });

      expect(firstName.value).toBe("Grace");
      // Later saves use the update action, but the completion stays reported.
      expect(
        view.container.querySelector("#account-profile-feedback p")
      ).not.toBeNull();
      expect(workspaceRouterRefresh).not.toHaveBeenCalled();
      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith(
        "You have unsaved profile changes. Leave this page?"
      );

      const pendingUpdate = Promise.withResolvers<UpdateResult>();
      updateCustomerProfile.mockImplementationOnce(() => pendingUpdate.promise);
      await act(async () => {
        fireEvent.submit(form);
      });

      expect(completeCustomerProfile).toHaveBeenCalledTimes(1);
      expect(updateCustomerProfile).toHaveBeenCalledTimes(1);
      // The completion stays reported until the update settles, while the
      // pending update holds the submit button.
      expect(
        view.container.querySelector("#account-profile-feedback p")
      ).not.toBeNull();
      const submit = form.querySelector("button[type='submit']");
      assert(submit instanceof HTMLButtonElement);
      expect(submit.disabled).toBe(true);

      await act(async () => {
        pendingUpdate.resolve({ data: { status: "updated" } });
        await pendingUpdate.promise;
      });

      expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("disables the form during a delayed completion refresh", async () => {
    let refreshReleased = false;
    const refresh = Promise.withResolvers<void>();
    let requestRefresh: (() => void) | undefined;
    workspaceRouterRefresh.mockImplementationOnce(() => {
      assert(requestRefresh, "Expected the refresh fixture to render");
      requestRefresh();
    });

    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );

    function DelayedRefresh({ requested }: { readonly requested: boolean }) {
      if (requested && !refreshReleased) throw refresh.promise;
      return null;
    }

    function RefreshFixture() {
      const [requested, setRequested] = React.useState(false);
      requestRefresh = () => setRequested(true);
      return (
        <UnsavedChangesProvider>
          <React.Suspense fallback={<p>Waiting for refresh</p>}>
            <DelayedRefresh requested={requested} />
            <ProfileForm mode="complete" locale="en-US" email={adaAddress} />
          </React.Suspense>
        </UnsavedChangesProvider>
      );
    }

    const view = render(<RefreshFixture />);
    const firstName = getProfileInput(view, "First name");
    const form = getProfileForm(view);

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "Ada" } });
      fireEvent.submit(form);
    });

    const fieldset = view.container.querySelector("fieldset");
    assert(fieldset);
    const submitButton = view.container.querySelector(
      "#account-profile-submit"
    );
    assert(submitButton instanceof HTMLButtonElement);
    expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(fieldset.disabled).toBe(true);
    expect(submitButton.disabled).toBe(true);

    await act(async () => {
      refreshReleased = true;
      refresh.resolve();
      await refresh.promise;
    });

    expect(getProfileInput(view, "First name").value).toBe("Ada");
    expect(form.getAttribute("aria-busy")).toBe("false");
    expect(fieldset.disabled).toBe(false);
    expect(submitButton.disabled).toBe(false);
  });

  test("keeps native required validation before executing", async () => {
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm mode="complete" locale="en-US" email={adaAddress} />
    );
    const form = getProfileForm(view);
    expect(getProfileInput(view, "First name").required).toBe(true);
    expect(form.noValidate).toBe(false);

    await act(async () => {
      fireEvent.submit(form);
    });

    expect(completeCustomerProfile).not.toHaveBeenCalled();
  });

  test("associates the first-name validation error with the field", async () => {
    updateCustomerProfile.mockImplementationOnce(() =>
      Promise.resolve({
        validationErrors: {
          formErrors: [],
          fieldErrors: { firstName: ["Enter your first name."] },
        },
      })
    );
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm
        mode="edit"
        locale="en-US"
        email={adaAddress}
        profile={editProfile}
      />
    );

    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    const firstName = view.getByLabelText("First name");
    expect(firstName.getAttribute("aria-invalid")).toBe("true");
    expect(firstName.getAttribute("aria-describedby")).toBe(
      "account-profile-first-name-error"
    );
    expect(view.getByText("Enter your first name.").id).toBe(
      "account-profile-first-name-error"
    );
  });

  test("forces phone correction instead of saving when the phone fails validation", async () => {
    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm
        mode="edit"
        locale="en-US"
        email={adaAddress}
        profile={{ ...editProfile, phone: "555-ALPHA" }}
      />
    );

    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    // The shared contract schema rejects the unparseable phone on the client,
    // so the save never leaves the form.
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    const phone = view.getByLabelText("Phone");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    expect(phone.getAttribute("aria-describedby")).toBe(
      "account-profile-phone-error"
    );
    expect(
      view.getByText("Enter a valid phone number or clear the field.").id
    ).toBe("account-profile-phone-error");
    expect(workspaceRouterRefresh).not.toHaveBeenCalled();
  });

  test("preserves typed values and the guard after a rejected save", async () => {
    updateCustomerProfile.mockImplementationOnce(() =>
      Promise.resolve({
        serverError: "We could not update your profile. Please try again.",
      })
    );
    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={editProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const firstName = getProfileInput(view, "First name");
      const lastName = getProfileInput(view, "Last name");

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
        fireEvent.input(lastName, { target: { value: "Byron" } });
        fireEvent.submit(getProfileForm(view));
      });

      expect(firstName.value).toBe("Grace");
      expect(lastName.value).toBe("Byron");
      expect(
        view.getByText("We could not update your profile. Please try again.")
      ).toBeTruthy();

      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith(
        "You have unsaved profile changes. Leave this page?"
      );
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("preserves typed values and the guard after validation errors", async () => {
    updateCustomerProfile.mockImplementationOnce(() =>
      Promise.resolve({
        validationErrors: {
          formErrors: [],
          fieldErrors: { firstName: ["Enter your first name."] },
        },
      })
    );
    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={editProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const firstName = getProfileInput(view, "First name");

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
        fireEvent.submit(getProfileForm(view));
      });

      expect(firstName.value).toBe("Grace");
      expect(firstName.getAttribute("aria-invalid")).toBe("true");
      expect(
        view.getByText("Please review the highlighted fields and try again.")
      ).toBeTruthy();

      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith(
        "You have unsaved profile changes. Leave this page?"
      );
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("clears the guard after a successful save without extra edits", async () => {
    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={editProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const firstName = getProfileInput(view, "First name");

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
        const form = getProfileForm(view);
        fireEvent.submit(form);
        fireEvent.submit(form);
      });

      expect(updateCustomerProfile).toHaveBeenCalledTimes(1);
      expect(refreshAnalyticsDotyposCustomerId).not.toHaveBeenCalled();
      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(event.cancelBubble).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("clears the guard when a changed value returns to its original value", async () => {
    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={editProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const firstName = getProfileInput(view, "First name");

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
        fireEvent.input(firstName, { target: { value: "Ada" } });
      });

      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(event.cancelBubble).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("preserves the original baseline across Activity hide and show", async () => {
    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      function ActivityHarness() {
        const [mode, setMode] = React.useState<"visible" | "hidden">("visible");
        return (
          <UnsavedChangesProvider>
            <button
              type="button"
              onClick={() =>
                setMode((currentMode) =>
                  currentMode === "visible" ? "hidden" : "visible"
                )
              }
            >
              Toggle activity
            </button>
            <Activity mode={mode}>
              <ProfileForm
                mode="edit"
                locale="en-US"
                email={adaAddress}
                profile={editProfile}
              />
            </Activity>
            <GuardedLink href="/next">Next</GuardedLink>
          </UnsavedChangesProvider>
        );
      }

      const view = render(<ActivityHarness />);
      const firstName = getProfileInput(view, "First name");
      const toggle = view.getByRole("button", { name: "Toggle activity" });

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
      });
      await act(async () => {
        fireEvent.click(toggle);
      });
      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(getProfileInput(view, "First name").value).toBe("Grace");
      await act(async () => {
        fireEvent.input(view.getByLabelText("First name"), {
          target: { value: "Ada" },
        });
      });

      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(event.cancelBubble).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("retains a personal billing draft after hiding billing and stays dirty", async () => {
    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={personalProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const addressLine1 = getProfileInput(view, "Street and number");

      await act(async () => {
        fireEvent.input(addressLine1, { target: { value: "Draft Street 3" } });
        fireEvent.change(view.getByLabelText("Billing profile"), {
          target: { value: "hidden" },
        });
      });
      await act(async () => {
        fireEvent.change(view.getByLabelText("Billing profile"), {
          target: { value: "personal" },
        });
      });

      expect(getProfileInput(view, "Street and number").value).toBe(
        "Draft Street 3"
      );
      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith(
        "You have unsaved profile changes. Leave this page?"
      );
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("gives phone and billing inputs the reservation autofill tokens", async () => {
    const { ProfileForm } = await import("./profile-form");
    const view = render(
      <ProfileForm
        mode="edit"
        locale="en-US"
        email={adaAddress}
        profile={businessProfile}
      />
    );
    const autocompleteOf = (id: string) =>
      view.container.querySelector(`#${id}`)?.getAttribute("autocomplete");

    const phone = view.container.querySelector("#account-profile-phone");
    expect(phone?.getAttribute("type")).toBe("tel");
    expect(phone?.getAttribute("autocomplete")).toBe("tel");
    expect(autocompleteOf("account-profile-billing-company-name")).toBe(
      "organization"
    );
    expect(autocompleteOf("account-profile-billing-address-line1")).toBe(
      "address-line1"
    );
    expect(autocompleteOf("account-profile-billing-address-line2")).toBe(
      "address-line2"
    );
    expect(autocompleteOf("account-profile-billing-city")).toBe(
      "address-level2"
    );
    expect(autocompleteOf("account-profile-billing-zip")).toBe("postal-code");
    expect(autocompleteOf("account-profile-billing-country")).toBe("country");
    expect(autocompleteOf("account-profile-billing-company-id")).toBeNull();
    expect(autocompleteOf("account-profile-billing-vat-id")).toBeNull();
  });

  test("submits only the active billing kind and keeps the saved baseline", async () => {
    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={businessProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const companyName = getProfileInput(view, "Company name");
      const addressLine1 = getProfileInput(view, "Street and number");

      await act(async () => {
        fireEvent.input(companyName, { target: { value: "Draft Company" } });
        fireEvent.input(addressLine1, { target: { value: "Draft Street 4" } });
        fireEvent.change(view.getByLabelText("Billing profile"), {
          target: { value: "personal" },
        });
      });
      await act(async () => {
        fireEvent.submit(getProfileForm(view));
      });

      const billing = updateCustomerProfile.mock.calls[0]?.[0].billing;
      assert(billing);
      expect(billing.kind).toBe("personal");
      expect(billing.addressLine1).toBe("Draft Street 4");
      expect("companyName" in billing).toBe(false);

      await act(async () => {
        fireEvent.change(view.getByLabelText("Billing profile"), {
          target: { value: "business" },
        });
      });
      expect(getProfileInput(view, "Company name").value).toBe("Draft Company");

      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith(
        "You have unsaved profile changes. Leave this page?"
      );
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("keeps edits typed after submission and stays guarded when the save succeeds", async () => {
    const { promise: pendingUpdate, resolve: resolveUpdate } =
      Promise.withResolvers<UpdateResult>();
    updateCustomerProfile.mockImplementationOnce(() => pendingUpdate);

    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={editProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const firstName = getProfileInput(view, "First name");

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
        fireEvent.submit(getProfileForm(view));
      });
      expect(updateCustomerProfile).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Augusta" } });
        resolveUpdate({ data: { status: "updated" } });
        await pendingUpdate;
      });

      // The in-flight edit survives the success and keeps the guard on.
      expect(firstName.value).toBe("Augusta");
      expect(view.getByText("Profile updated.")).toBeTruthy();
      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith(
        "You have unsaved profile changes. Leave this page?"
      );

      // Returning to the submitted value clears the guard again.
      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
      });
      const secondEvent = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      view.getByRole("link", { name: "Next" }).dispatchEvent(secondEvent);
      expect(secondEvent.defaultPrevented).toBe(false);
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("moves to the billing section when client validation rejects a hidden billing field", async () => {
    const { ProfileForm } = await import("./profile-form");

    function SectionHarness() {
      const [section, setSection] = React.useState<"profile" | "billing">(
        "profile"
      );
      return (
        <>
          <output data-testid="active-section">{section}</output>
          <ProfileForm
            email={adaAddress}
            locale="en-US"
            mode="edit"
            onSectionChange={setSection}
            profile={businessProfile}
            section={section}
          />
        </>
      );
    }

    const view = render(<SectionHarness />);
    // Whitespace passes the native required check but fails the shared
    // contract schema's trimmed non-empty rule.
    fireEvent.input(view.getByLabelText("Company name"), {
      target: { value: "   " },
    });

    await act(async () => {
      fireEvent.submit(getProfileForm(view));
    });

    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(view.getByTestId("active-section").textContent).toBe("billing");
    const companyName = getProfileInput(view, "Company name");
    expect(companyName.getAttribute("aria-invalid")).toBe("true");
    expect(
      view.getByText("Please review the highlighted fields and try again.")
    ).toBeTruthy();
  });

  test("keeps an in-flight edit returned to its original value when the save succeeds", async () => {
    const { promise: pendingUpdate, resolve: resolveUpdate } =
      Promise.withResolvers<UpdateResult>();
    updateCustomerProfile.mockImplementationOnce(() => pendingUpdate);

    const { ProfileForm } = await import("./profile-form");
    const { UnsavedChangesProvider } = await import(
      "@/shared/components/unsaved-changes-guard"
    );
    const originalConfirm = window.confirm;
    const confirm = mock(() => false);
    window.location.href = "http://localhost/account";
    window.confirm = confirm;

    try {
      const view = render(
        <UnsavedChangesProvider>
          <ProfileForm
            mode="edit"
            locale="en-US"
            email={adaAddress}
            profile={editProfile}
          />
          <GuardedLink href="/next">Next</GuardedLink>
        </UnsavedChangesProvider>
      );
      const firstName = getProfileInput(view, "First name");

      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Grace" } });
        fireEvent.submit(getProfileForm(view));
      });
      expect(updateCustomerProfile).toHaveBeenCalledTimes(1);
      expect(updateCustomerProfile.mock.calls[0]?.[0].firstName).toBe("Grace");

      // The customer reverts the in-flight edit to the original value before
      // the save resolves: the typed value must survive the success.
      await act(async () => {
        fireEvent.input(firstName, { target: { value: "Ada" } });
        resolveUpdate({ data: { status: "updated" } });
        await pendingUpdate;
      });

      expect(firstName.value).toBe("Ada");
      expect(view.getByText("Profile updated.")).toBeTruthy();

      // The server saved "Grace", so the reverted "Ada" is still unsaved.
      const link = view.getByRole("link", { name: "Next" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith(
        "You have unsaved profile changes. Leave this page?"
      );
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("suppresses the completion refresh when an in-flight edit returned to its original value", async () => {
    const { promise: pendingCompletion, resolve: resolveCompletion } =
      Promise.withResolvers<CompletionResult>();
    completeCustomerProfile.mockImplementationOnce(() => pendingCompletion);

    const { ProfileForm } = await import("./profile-form");

    const view = render(
      <ProfileForm mode="complete" locale="en-US" email={adaAddress} />
    );
    const firstName = getProfileInput(view, "First name");

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "Grace" } });
      fireEvent.submit(getProfileForm(view));
    });

    // Clearing the field returns it to its original (empty) value, so the
    // submitted snapshot differs from what the customer is looking at even
    // though nothing looks dirty against the original defaults.
    await act(async () => {
      fireEvent.input(firstName, { target: { value: "" } });
      resolveCompletion({ data: { status: "completed" } });
      await pendingCompletion;
    });

    expect(firstName.value).toBe("");
    // The field shows "" while the submitted snapshot was "Grace", so no
    // refresh happens and the form stays interactive.
    expect(workspaceRouterRefresh).not.toHaveBeenCalled();
    expect(view.container.querySelector("fieldset")?.disabled).toBe(false);
  });

  test("surfaces the native company-name error inline when submit is blocked natively", async () => {
    const { ProfileForm } = await import("./profile-form");

    const emptyCompanyProfile = {
      ...editProfile,
      billing: {
        kind: "business" as const,
        addressLine1: "Original Street 1",
        addressLine2: null,
        city: "Prague",
        zip: "11000",
        country: "CZ",
        companyName: "",
        companyId: "12345678",
        vatId: null,
      },
    };

    const view = render(
      <ProfileForm
        mode="edit"
        locale="en-US"
        email={adaAddress}
        profile={emptyCompanyProfile}
        section="billing"
      />
    );
    const companyName = getProfileInput(view, "Company name");
    expect(companyName.value).toBe("");
    expect(companyName.getAttribute("aria-invalid")).toBeNull();

    // requestSubmit runs native constraint validation without blurring the
    // field: the inline error must still be installed and linked.
    await act(async () => {
      getProfileForm(view).requestSubmit();
    });

    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(companyName.getAttribute("aria-invalid")).toBe("true");
    expect(companyName.getAttribute("aria-describedby")).toBe(
      "account-profile-billing-company-name-error"
    );
    const errorMessage = view.container.querySelector(
      "#account-profile-billing-company-name-error"
    );
    expect(errorMessage?.textContent).toBe(
      "Please review the highlighted fields and try again."
    );
  });

  describe("avatar control", () => {
    const existingAvatar = {
      url: "https://res.cloudinary.test/upload/v1/avatars/live",
      version: 1,
    };

    const renderEditProfile = async (
      props: Partial<ComponentPropsWithoutRef<typeof ProfileForm>> = {}
    ) => {
      const { ProfileForm: ProfileFormComponent } = await import(
        "./profile-form"
      );
      return render(
        <ProfileFormComponent
          avatarPresentation={{ kind: "available", avatar: null }}
          email={adaAddress}
          locale="en-US"
          mode="edit"
          profile={editProfile}
          {...props}
        />
      );
    };

    const fileInput = (view: ReturnType<typeof render>) => {
      const input = view.container.querySelector("input[type='file']");
      assert(input instanceof HTMLInputElement);
      return input;
    };

    const pickAvatarFile = (view: ReturnType<typeof render>) => {
      fireEvent.change(fileInput(view), {
        target: {
          files: [
            new File([new Uint8Array([137, 80])], "avatar.png", {
              type: "image/png",
            }),
          ],
        },
      });
    };

    test("falls back to initials when the avatar image fails to load", async () => {
      const view = await renderEditProfile({
        avatarPresentation: { kind: "available", avatar: existingAvatar },
      });
      const image = view.getByAltText("Your profile picture");

      await act(async () => {
        fireEvent.error(image);
      });

      expect(view.container.querySelector("img")).toBeNull();
      expect(view.getByText("AL")).toBeTruthy();
    });

    test("keeps dirty identity and billing drafts when refreshed server props arrive after an avatar upload", async () => {
      const { ProfileForm: ProfileFormComponent } = await import(
        "./profile-form"
      );
      const refreshedAvatar = {
        url: "https://res.cloudinary.test/upload/v2/avatars/live",
        version: 2,
      };

      function RefreshHarness() {
        const [profile, setProfile] = React.useState(businessProfile);
        const [avatarPresentation, setAvatarPresentation] =
          React.useState<CustomerAvatarPresentation>({
            kind: "available",
            avatar: null,
          });
        const [section, setSection] = React.useState<"profile" | "billing">(
          "profile"
        );
        return (
          <>
            <button type="button" onClick={() => setSection("profile")}>
              Identity section
            </button>
            <button type="button" onClick={() => setSection("billing")}>
              Billing section
            </button>
            <button
              type="button"
              onClick={() => {
                // The router refresh re-renders the form with fresh server
                // data while the customer's drafts are dirty.
                setProfile({
                  ...businessProfile,
                  firstName: "Server",
                  lastName: "Refreshed",
                });
                setAvatarPresentation({
                  kind: "available",
                  avatar: refreshedAvatar,
                });
              }}
            >
              Apply server refresh
            </button>
            <ProfileFormComponent
              email={adaAddress}
              locale="en-US"
              mode="edit"
              profile={profile}
              avatarPresentation={avatarPresentation}
              section={section}
              onSectionChange={setSection}
            />
          </>
        );
      }

      const view = render(<RefreshHarness />);

      // Dirty the identity drafts.
      await act(async () => {
        fireEvent.input(view.getByLabelText("First name"), {
          target: { value: "Grace" },
        });
        fireEvent.input(view.getByLabelText("Last name"), {
          target: { value: "Byron" },
        });
      });
      // Dirty the billing drafts too.
      fireEvent.click(view.getByRole("button", { name: "Billing section" }));
      await act(async () => {
        fireEvent.input(view.getByLabelText("Company name"), {
          target: { value: "Draft Company" },
        });
      });

      // Upload the avatar from the identity section.
      fireEvent.click(view.getByRole("button", { name: "Identity section" }));
      pickAvatarFile(view);
      await view.findByText("Profile photo updated.");

      // The successful upload refreshes server data: the form re-renders
      // with new profile and avatar props while both drafts are dirty.
      fireEvent.click(
        view.getByRole("button", { name: "Apply server refresh" })
      );

      expect(updateCustomerProfile).not.toHaveBeenCalled();
      expect(completeCustomerProfile).not.toHaveBeenCalled();
      // The refreshed avatar prop is applied…
      expect(
        view.getByAltText("Your profile picture").getAttribute("src")
      ).toBe(refreshedAvatar.url);
      // …but neither draft is clobbered by the refreshed server values.
      fireEvent.click(view.getByRole("button", { name: "Billing section" }));
      expect(getProfileInput(view, "Company name").value).toBe("Draft Company");
      fireEvent.click(view.getByRole("button", { name: "Identity section" }));
      expect(getProfileInput(view, "First name").value).toBe("Grace");
      expect(getProfileInput(view, "Last name").value).toBe("Byron");
      expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    });

    test("keeps the previous image and the usable picker on a validation rejection", async () => {
      uploadCustomerAvatar.mockImplementationOnce(() =>
        Promise.resolve({
          data: { status: "rejected", reason: "file-too-large" },
        })
      );
      const view = await renderEditProfile({
        avatarPresentation: { kind: "available", avatar: existingAvatar },
      });

      pickAvatarFile(view);
      await view.findByText(
        "That image is larger than 2 MB. Choose a smaller file."
      );

      expect(
        view.getByAltText("Your profile picture").getAttribute("src")
      ).toBe(existingAvatar.url);
      expect(fileInput(view).value).toBe("");
      expect(workspaceRouterRefresh).not.toHaveBeenCalled();
    });

    test("returns to initials after a successful removal", async () => {
      const view = await renderEditProfile({
        avatarPresentation: { kind: "available", avatar: existingAvatar },
      });

      await act(async () => {
        fireEvent.click(
          view.getByRole("button", { name: "Remove profile photo" })
        );
      });
      await view.findByText("Profile photo removed.");

      expect(view.container.querySelector("img")).toBeNull();
      expect(view.getByText("AL")).toBeTruthy();
      expect(
        view.queryByRole("button", { name: "Remove profile photo" })
      ).toBeNull();
      expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
