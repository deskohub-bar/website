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
import React, { Activity } from "react";
import type * as accountActions from "@/features/account/actions";
import type * as avatarActions from "@/features/account/avatar-actions";
import { m } from "@/features/i18n";
import { UnsavedChangesProvider } from "@/shared/components/unsaved-changes-guard";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { getProfileForm, getProfileInput } from "./profile-form.test-utils";

registerWorkspaceComponentTestEnv();
// @testing-library/react must load after the happy-dom registration, or
// React's synthetic change events never fire against controlled inputs.
const { act, cleanup, fireEvent, render, waitFor, within } = await import(
  "@testing-library/react"
);

type UpdateResult = Awaited<
  ReturnType<typeof accountActions.updateCustomerProfile>
>;

const routerRefresh = mock(() => undefined);
const completeCustomerProfile = mock<
  typeof accountActions.completeCustomerProfile
>(() => Promise.resolve({ data: { status: "completed" } }));
const updateCustomerProfile = mock<typeof accountActions.updateCustomerProfile>(
  () => Promise.resolve({ data: { status: "updated" } })
);

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

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

// Keeps the browser Effect runtime, which this navigation mock can't load,
// out of the form.
mock.module("@/features/account/analytics-customer-link", () => ({
  refreshAnalyticsDotyposCustomerId: () => undefined,
}));
mock.module("@/features/account/avatar-actions", (): typeof avatarActions => ({
  removeCustomerAvatar: () => Promise.resolve({ data: { status: "removed" } }),
  uploadCustomerAvatar: () =>
    Promise.resolve({ data: { status: "retryable" } }),
}));

const businessProfile = {
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+420601111222",
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

type Section = "profile" | "billing";
type ActivityMode = "visible" | "hidden";

function ProfileFixture({
  initialSection = "profile",
}: {
  readonly initialSection?: Section;
}) {
  const [section, setSection] = React.useState<Section>(initialSection);
  const [activityMode, setActivityMode] =
    React.useState<ActivityMode>("visible");

  return (
    <UnsavedChangesProvider>
      <button type="button" onClick={() => setSection("profile")}>
        Profile section
      </button>
      <button type="button" onClick={() => setSection("billing")}>
        Billing section
      </button>
      <button
        type="button"
        onClick={() =>
          setActivityMode((current) =>
            current === "visible" ? "hidden" : "visible"
          )
        }
      >
        Toggle activity
      </button>
      <output data-testid="active-section">{section}</output>
      <Activity mode={activityMode}>
        <ProfileFormForTest
          email={testEmailAddress("ada")}
          locale="en-US"
          mode="edit"
          onSectionChange={setSection}
          profile={businessProfile}
          section={section}
        />
      </Activity>
    </UnsavedChangesProvider>
  );
}

function expectDirty() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

function expectClean() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
}

let ProfileFormForTest: typeof import("./profile-form").ProfileForm;

describe("ProfileForm action lifecycle", () => {
  beforeAll(async () => {
    ({ ProfileForm: ProfileFormForTest } = await import("./profile-form"));
  });

  afterEach(() => {
    cleanup();
    completeCustomerProfile.mockClear();
    updateCustomerProfile.mockClear();
    routerRefresh.mockClear();
  });

  afterAll(async () => {
    await unregisterWorkspaceComponentTestEnv();
  });

  test("reveals profile after a billing save reports a phone error and retains drafts", async () => {
    const { promise: pendingUpdate, resolve: resolveUpdate } =
      Promise.withResolvers<UpdateResult>();
    updateCustomerProfile.mockImplementationOnce(() => pendingUpdate);

    const view = render(<ProfileFixture initialSection="billing" />);
    await act(async () => {
      fireEvent.input(view.getByLabelText("First name"), {
        target: { value: "Grace" },
      });
      fireEvent.input(view.getByLabelText("Last name"), {
        target: { value: "Byron" },
      });
      fireEvent.input(view.getByLabelText("Phone"), {
        target: { value: "+420602222333" },
      });
    });
    await act(async () => {
      fireEvent.input(view.getByLabelText("Company name"), {
        target: { value: "Draft Company" },
      });
      fireEvent.input(view.getByLabelText("Street and number"), {
        target: { value: "Draft Street 2" },
      });
      expect(getProfileInput(view, "Company name").value).toBe("Draft Company");
      fireEvent.click(view.getByRole("button", { name: "Profile section" }));
      fireEvent.click(view.getByRole("button", { name: "Billing section" }));
      expect(getProfileInput(view, "Company name").value).toBe("Draft Company");
      fireEvent.submit(getProfileForm(view));
    });

    await waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("active-section").textContent).toBe("billing");
    expect(updateCustomerProfile.mock.calls[0]?.[0]).toMatchObject({
      billing: { companyName: "Draft Company" },
    });

    await act(async () => {
      resolveUpdate({
        validationErrors: {
          formErrors: [],
          fieldErrors: {
            phone: ["Enter a valid phone number or clear the field."],
          },
        },
      });
      await pendingUpdate;
    });

    await waitFor(() =>
      expect(view.getByTestId("active-section").textContent).toBe("profile")
    );
    expect(getProfileInput(view, "First name").value).toBe("Grace");
    const companyName = getProfileInput(view, "Company name");
    expect(companyName.value).toBe("Draft Company");
    expect(view.getByLabelText("Phone").getAttribute("aria-invalid")).toBe(
      "true"
    );
    expect(
      view.getByText("Enter a valid phone number or clear the field.")
    ).toBeTruthy();
    expectDirty();
  });

  test("updates the profile display from the submitted identity and retains later drafts", async () => {
    const { promise: pendingUpdate, resolve: resolveUpdate } =
      Promise.withResolvers<UpdateResult>();
    updateCustomerProfile.mockImplementationOnce(() => pendingUpdate);

    const view = render(<ProfileFixture />);
    const profileScreen = () => {
      const element = view.container.querySelector(
        "[data-screen='profile-screen']"
      );
      assert(element instanceof HTMLElement);
      return element;
    };
    const firstName = getProfileInput(view, "First name");
    const lastName = getProfileInput(view, "Last name");

    expect(within(profileScreen()).getByText("Ada Lovelace")).toBeTruthy();
    expect(
      profileScreen().querySelector("div[aria-hidden='true']")?.textContent
    ).toBe("AL");

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "Ada" } });
      fireEvent.input(lastName, { target: { value: "Saved" } });
      fireEvent.submit(getProfileForm(view));
    });

    await waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledTimes(1));
    expect(updateCustomerProfile.mock.calls[0]?.[0]).toMatchObject({
      firstName: "Ada",
      lastName: "Saved",
    });

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "Later" } });
      fireEvent.input(lastName, { target: { value: "Draft" } });
      resolveUpdate({ data: { status: "updated" } });
      await pendingUpdate;
    });

    await waitFor(() =>
      expect(within(profileScreen()).getByText("Ada Saved")).toBeTruthy()
    );
    expect(within(profileScreen()).queryByText("Ada Lovelace")).toBeNull();
    expect(
      profileScreen().querySelector("div[aria-hidden='true']")?.textContent
    ).toBe("AS");
    expect(firstName.value).toBe("Later");
    expect(lastName.value).toBe("Draft");
    expect(routerRefresh).not.toHaveBeenCalled();
    expectDirty();
  });

  test("keeps the saved profile display identity when the edit save fails", async () => {
    const { promise: pendingUpdate, resolve: resolveUpdate } =
      Promise.withResolvers<UpdateResult>();
    updateCustomerProfile.mockImplementationOnce(() => pendingUpdate);

    const view = render(<ProfileFixture />);
    const profileScreen = () => {
      const element = view.container.querySelector(
        "[data-screen='profile-screen']"
      );
      assert(element instanceof HTMLElement);
      return element;
    };
    const firstName = getProfileInput(view, "First name");
    const lastName = getProfileInput(view, "Last name");

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "Changed" } });
      fireEvent.input(lastName, { target: { value: "Name" } });
      fireEvent.submit(getProfileForm(view));
    });
    await waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveUpdate({
        serverError: "We could not update your profile. Please try again.",
      });
      await pendingUpdate;
    });

    await waitFor(() =>
      expect(
        within(profileScreen()).getByText(
          "We could not update your profile. Please try again."
        )
      ).toBeTruthy()
    );
    expect(within(profileScreen()).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(profileScreen()).queryByText("Changed Name")).toBeNull();
    expect(
      profileScreen().querySelector("div[aria-hidden='true']")?.textContent
    ).toBe("AL");
    expect(firstName.value).toBe("Changed");
    expect(lastName.value).toBe("Name");
    expect(routerRefresh).not.toHaveBeenCalled();
    expectDirty();
  });

  test("reports a transport failure with the generic profile error and allows a retry", async () => {
    updateCustomerProfile.mockImplementationOnce(() =>
      Promise.reject(new Error("synthetic transport failure"))
    );

    const view = render(<ProfileFixture />);
    const feedback = () => {
      const element = view.container.querySelector("#account-profile-feedback");
      assert(element instanceof HTMLElement);
      return element;
    };
    const firstName = getProfileInput(view, "First name");

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "Changed" } });
      fireEvent.submit(getProfileForm(view));
    });
    await waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(feedback().textContent).toBe(
        m.accountProfileError({}, { locale: "en-US" })
      )
    );
    const submit = view.container.querySelector("#account-profile-submit");
    assert(submit instanceof HTMLButtonElement);
    expect(submit.disabled).toBe(false);
    expect(firstName.value).toBe("Changed");
    expectDirty();
  });

  test("reveals billing after a profile save reports a company error with feedback", async () => {
    updateCustomerProfile.mockImplementationOnce(() =>
      Promise.resolve({
        validationErrors: {
          formErrors: [],
          fieldErrors: {
            billing: ["companyName: Company name is required."],
          },
        },
      })
    );

    const view = render(<ProfileFixture initialSection="profile" />);
    await act(async () => {
      fireEvent.input(view.getByLabelText("First name"), {
        target: { value: "Grace" },
      });
      fireEvent.submit(getProfileForm(view));
    });

    await waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(view.getByTestId("active-section").textContent).toBe("billing")
    );

    const companyName = view.getByLabelText("Company name");
    expect(companyName.getAttribute("aria-invalid")).toBe("true");
    expect(companyName.getAttribute("aria-describedby")).toBe(
      "account-profile-billing-company-name-error"
    );
    const companyNameError = view.container.querySelector(
      "#account-profile-billing-company-name-error"
    );
    expect(companyNameError?.textContent).toBe(
      "Please review the highlighted fields and try again."
    );
    expectDirty();
  });

  test("preserves the full submitted baseline through late edits and Activity hide/show", async () => {
    const { promise: pendingUpdate, resolve: resolveUpdate } =
      Promise.withResolvers<UpdateResult>();
    updateCustomerProfile.mockImplementationOnce(() => pendingUpdate);

    const view = render(<ProfileFixture />);
    await act(async () => {
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
    });
    await act(async () => {
      fireEvent.input(view.getByLabelText("Company name"), {
        target: { value: "Draft Company" },
      });
      fireEvent.input(view.getByLabelText("Company ID (IČO)"), {
        target: { value: "87654321" },
      });
      fireEvent.input(view.getByLabelText("Street and number"), {
        target: { value: "Draft Street 2" },
      });
      fireEvent.input(view.getByLabelText("City"), {
        target: { value: "Brno" },
      });
      expect(getProfileInput(view, "Company name").value).toBe("Draft Company");
      fireEvent.submit(getProfileForm(view));
    });

    await waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledTimes(1));
    expect(updateCustomerProfile.mock.calls[0]?.[0]).toEqual({
      firstName: "Grace",
      lastName: "Byron",
      phone: "+420602222333",
      billing: {
        kind: "business",
        companyName: "Draft Company",
        companyId: "87654321",
        vatId: undefined,
        addressLine1: "Draft Street 2",
        addressLine2: undefined,
        city: "Brno",
        zip: "11000",
        country: "CZ",
      },
    });

    await act(async () => {
      fireEvent.input(view.getByLabelText("Phone"), {
        target: { value: "+420603333444" },
      });
      fireEvent.input(view.getByLabelText("Company name"), {
        target: { value: "Late Company" },
      });
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Toggle activity" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Toggle activity" }));
    });

    expect(getProfileInput(view, "Phone").value).toBe("+420603333444");
    expect(getProfileInput(view, "Company name").value).toBe("Late Company");

    await act(async () => {
      resolveUpdate({ data: { status: "updated" } });
      await pendingUpdate;
    });
    await waitFor(() =>
      expect(view.getByText("Profile updated.")).toBeTruthy()
    );

    expect(getProfileInput(view, "Phone").value).toBe("+420603333444");
    expect(getProfileInput(view, "Company name").value).toBe("Late Company");
    expect(routerRefresh).not.toHaveBeenCalled();
    expectDirty();

    await act(async () => {
      fireEvent.input(view.getByLabelText("Phone"), {
        target: { value: "+420602222333" },
      });
      fireEvent.input(view.getByLabelText("Company name"), {
        target: { value: "Draft Company" },
      });
    });
    expectClean();

    await act(async () => {
      fireEvent.input(view.getByLabelText("Company name"), {
        target: { value: "Later Company" },
      });
    });
    expectDirty();
  });

  test("derives native invalid section priority from the current first invalid field", async () => {
    const view = render(<ProfileFixture initialSection="billing" />);
    const form = getProfileForm(view);
    const firstName = getProfileInput(view, "First name");
    const lastName = getProfileInput(view, "Last name");
    const phone = getProfileInput(view, "Phone");
    const companyName = getProfileInput(view, "Company name");
    const addressLine1 = getProfileInput(view, "Street and number");
    const [profilePanel, billingPanel] =
      form.querySelectorAll("fieldset > div");
    assert(profilePanel instanceof HTMLDivElement);
    assert(billingPanel instanceof HTMLDivElement);
    expect(profilePanel.hidden).toBe(true);
    expect(billingPanel.hidden).toBe(false);

    // happy-dom excludes controls under [hidden] from requestSubmit. Expose
    // the inactive panel so both attempts still use native invalid events.
    profilePanel.hidden = false;

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "" } });
      fireEvent.input(lastName, { target: { value: "Byron" } });
      fireEvent.input(phone, { target: { value: "+420602222333" } });
      fireEvent.input(companyName, { target: { value: "" } });
      fireEvent.input(addressLine1, { target: { value: "Draft Street 2" } });
      form.requestSubmit();
    });

    expect(view.getByTestId("active-section").textContent).toBe("profile");
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(firstName.value).toBe("");
    expect(lastName.value).toBe("Byron");
    expect(phone.value).toBe("+420602222333");
    expect(companyName.value).toBe("");
    expect(addressLine1.value).toBe("Draft Street 2");

    await act(async () => {
      fireEvent.input(firstName, { target: { value: "Grace" } });
      billingPanel.hidden = false;
      form.requestSubmit();
    });

    expect(view.getByTestId("active-section").textContent).toBe("billing");
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(view.getByLabelText("First name")).toBe(firstName);
    expect(view.getByLabelText("Company name")).toBe(companyName);
    expect(firstName.value).toBe("Grace");
    expect(lastName.value).toBe("Byron");
    expect(phone.value).toBe("+420602222333");
    expect(companyName.value).toBe("");
    expect(addressLine1.value).toBe("Draft Street 2");
  });
});
