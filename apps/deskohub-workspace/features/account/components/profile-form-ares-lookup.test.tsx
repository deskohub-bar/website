import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { testEmailAddress } from "@deskohub/test-email";
import React, { type ComponentPropsWithoutRef } from "react";
import type * as accountActions from "@/features/account/actions";
import type * as avatarActions from "@/features/account/avatar-actions";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { getProfileForm, getProfileInput } from "./profile-form.test-utils";

registerWorkspaceComponentTestEnv();
const { act, cleanup, fireEvent, render } = await import(
  "@testing-library/react"
);

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
type LookupOutcome = Awaited<
  ReturnType<typeof accountActions.lookupAresBusiness>
>;

const lookupAresBusiness = mock<typeof accountActions.lookupAresBusiness>(() =>
  Promise.resolve({
    data: { status: "not-found", message: "No company was found." },
  })
);

mock.module(
  "@/features/account/actions",
  (): Partial<typeof accountActions> => ({
    acknowledgeSignupReferralNotice: () =>
      Promise.resolve({ data: { status: "acknowledged" } }),
    completeCustomerProfile,
    lookupAresBusiness,
    updateCustomerProfile,
    updateLocalePreference: () =>
      Promise.resolve({ data: { status: "saved" } }),
  })
);

mock.module("@/features/account/avatar-actions", (): typeof avatarActions => ({
  removeCustomerAvatar: () => Promise.resolve({ data: { status: "removed" } }),
  uploadCustomerAvatar: () =>
    Promise.resolve({ data: { status: "retryable" } }),
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
          onNavigate?.({ preventDefault: () => event.preventDefault() });
        }}
      >
        {children}
      </a>
    );
  }
);

mock.module("next/link", () => ({ default: MockNextLink }));

const { m } = await import("@/features/i18n");
const { ProfileForm } = await import("./profile-form");

const foundCompany = {
  companyName: "Studio Alpha s.r.o.",
  companyId: "27121043",
  vatId: "CZ27121043",
  addressLine1: "Řetězová 10/3",
  city: "Prague",
  zip: "11000",
  country: "CZ",
} as const;

const businessProfile = {
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+420601111222",
  billing: {
    kind: "business" as const,
    addressLine1: "Original Street 1",
    addressLine2: "Suite 9",
    city: "Prague",
    zip: "11000",
    country: "CZ",
    companyName: "Original Company",
    companyId: "",
    vatId: "CZ12345678",
  },
};

type ProfileFixture = typeof businessProfile;

const renderForm = (
  props: { locale?: "en-US" | "cs-CZ"; profile?: ProfileFixture } = {}
) =>
  render(
    <ProfileForm
      email={testEmailAddress("ada")}
      locale="en-US"
      mode="edit"
      profile={businessProfile}
      section="billing"
      {...props}
    />
  );

const companyIdInput = (
  view: ReturnType<typeof render>,
  locale: "en-US" | "cs-CZ" = "en-US"
) => getProfileInput(view, m.accountAresLookupIcoLabel({}, { locale }));

const lookupButton = (
  view: ReturnType<typeof render>,
  locale: "en-US" | "cs-CZ" = "en-US"
) =>
  view.getByRole("button", {
    name: m.accountAresLookupSubmit({}, { locale }),
  });

const applyButton = (
  view: ReturnType<typeof render>,
  locale: "en-US" | "cs-CZ" = "en-US"
) =>
  view.getByRole("button", {
    name: m.accountAresLookupApply({}, { locale }),
  });

const statusRegion = (view: ReturnType<typeof render>) => {
  const status = view.container.querySelector("#account-profile-ares-status");
  assert(status);
  return status;
};

async function runLookup(
  view: ReturnType<typeof render>,
  result: accountActions.AresBusinessLookupResult,
  options: { ico?: string; locale?: "en-US" | "cs-CZ" } = {}
) {
  const { ico = "27121043", locale = "en-US" } = options;
  const { promise: pendingLookup, resolve: resolveLookup } =
    Promise.withResolvers<LookupOutcome>();
  lookupAresBusiness.mockImplementationOnce(() => pendingLookup);
  fireEvent.input(companyIdInput(view, locale), {
    target: { value: ico },
  });
  await act(async () => {
    fireEvent.click(lookupButton(view, locale));
    await Promise.resolve();
  });
  await act(async () => {
    resolveLookup({ data: result });
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  completeCustomerProfile.mockClear();
  lookupAresBusiness.mockReset();
  lookupAresBusiness.mockImplementation(() =>
    Promise.resolve({
      data: { status: "not-found", message: "No company was found." },
    })
  );
  updateCustomerProfile.mockClear();
  workspaceRouterRefresh.mockClear();
});

afterAll(unregisterWorkspaceComponentTestEnv);

describe("ProfileForm ARES business lookup", () => {
  test("reaches the lookup control by keyboard and applies a found company in en-US and cs-CZ", async () => {
    for (const locale of ["en-US", "cs-CZ"] as const) {
      const view = renderForm({ locale });
      await runLookup(
        view,
        { status: "found", company: { ...foundCompany } },
        {
          locale,
        }
      );

      expect(lookupAresBusiness).toHaveBeenCalledWith({ ico: "27121043" });
      expect(
        view.getByText(m.accountAresLookupReviewTitle({}, { locale }))
      ).toBeTruthy();
      expect(
        view.getByText(m.accountAresLookupApply({}, { locale }))
      ).toBeTruthy();

      const applyControl = applyButton(view, locale);
      const companyId = companyIdInput(view, locale);
      companyId.focus();
      expect(document.activeElement).toBe(companyId);
      await act(async () => {
        fireEvent.keyDown(companyId, { key: "Tab" });
        applyControl.focus();
      });
      expect(document.activeElement).toBe(applyControl);

      await act(async () => {
        fireEvent.click(applyControl);
      });

      expect(
        getProfileInput(view, m.accountProfileCompanyNameLabel({}, { locale }))
          .value
      ).toBe(foundCompany.companyName);
      expect(
        getProfileInput(view, m.accountProfileVatIdLabel({}, { locale })).value
      ).toBe(foundCompany.vatId);
      expect(
        view.getByText(m.accountAresLookupApplied({}, { locale }))
      ).toBeTruthy();
      expect(
        view.queryByText(m.accountAresLookupReviewTitle({}, { locale }))
      ).toBeNull();
      view.unmount();
    }
  });

  test("applies only present fields and never clears absent draft values", async () => {
    const view = renderForm();
    await runLookup(view, {
      status: "found",
      company: {
        companyName: foundCompany.companyName,
        companyId: foundCompany.companyId,
        vatId: undefined,
        addressLine1: foundCompany.addressLine1,
        addressLine2: undefined,
        city: foundCompany.city,
        zip: foundCompany.zip,
        country: foundCompany.country,
      },
    });

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: m.accountAresLookupApply({}, { locale: "en-US" }),
        })
      );
    });

    expect(getProfileInput(view, "Company name").value).toBe(
      foundCompany.companyName
    );
    expect(getProfileInput(view, "VAT ID").value).toBe("CZ12345678");
    expect(getProfileInput(view, "Apartment, suite").value).toBe("Suite 9");

    await act(async () => {
      fireEvent.input(view.getByLabelText("First name"), {
        target: { value: "Grace" },
      });
      fireEvent.submit(getProfileForm(view));
      await Promise.resolve();
    });

    expect(updateCustomerProfile).toHaveBeenCalledTimes(1);
    const billing = updateCustomerProfile.mock.calls[0]?.[0].billing;
    assert(billing?.kind === "business", "Expected submitted business billing");
    expect(billing.vatId).toBe("CZ12345678");
    expect(billing.addressLine2).toBe("Suite 9");
  });

  test("preserves concurrent edits elsewhere in the form while a lookup is pending", async () => {
    const view = renderForm();
    const { promise: pendingLookup, resolve: resolveLookup } =
      Promise.withResolvers<LookupOutcome>();
    lookupAresBusiness.mockImplementationOnce(() => pendingLookup);

    fireEvent.input(companyIdInput(view), {
      target: { value: "27121043" },
    });
    await act(async () => {
      fireEvent.click(lookupButton(view));
      await Promise.resolve();
    });

    const lookupControl = view.getByRole("button", {
      name: m.accountAresLookupLoading({}, { locale: "en-US" }),
    });
    assert(lookupControl instanceof HTMLButtonElement);
    expect(lookupControl.disabled).toBe(true);
    expect(getProfileInput(view, "First name").disabled).toBe(false);

    await act(async () => {
      fireEvent.input(view.getByLabelText("First name"), {
        target: { value: "Grace" },
      });
      fireEvent.input(view.getByLabelText("City"), {
        target: { value: "Brno" },
      });
      resolveLookup({
        data: {
          status: "found",
          company: { ...foundCompany, city: undefined },
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(applyButton(view));
    });

    expect(getProfileInput(view, "First name").value).toBe("Grace");
    expect(getProfileInput(view, "City").value).toBe("Brno");
    expect(getProfileInput(view, "Company name").value).toBe(
      foundCompany.companyName
    );
  });

  test.each(["en-US", "cs-CZ"] as const)(
    "surfaces the resolved server error in the live region for %s",
    async (locale) => {
      const view = renderForm({ locale });
      const serverErrorMessage = m.accountSessionExpired({}, { locale });
      lookupAresBusiness.mockImplementationOnce(() =>
        Promise.resolve({ serverError: serverErrorMessage })
      );

      await act(async () => {
        fireEvent.input(companyIdInput(view, locale), {
          target: { value: "27121043" },
        });
        fireEvent.click(lookupButton(view, locale));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(statusRegion(view).textContent).toBe(serverErrorMessage);
      expect(
        view.queryByRole("button", {
          name: m.accountAresLookupRetry({}, { locale }),
        })
      ).toBeTruthy();
    }
  );

  test.each(["en-US", "cs-CZ"] as const)(
    "announces the pending lookup and the found review in the live region for %s",
    async (locale) => {
      const view = renderForm({ locale });
      const { promise: pendingLookup, resolve: resolveLookup } =
        Promise.withResolvers<LookupOutcome>();
      lookupAresBusiness.mockImplementationOnce(() => pendingLookup);

      fireEvent.input(companyIdInput(view, locale), {
        target: { value: "27121043" },
      });
      await act(async () => {
        fireEvent.click(lookupButton(view, locale));
        await Promise.resolve();
      });

      expect(statusRegion(view).textContent).toBe(
        m.accountAresLookupLoading({}, { locale })
      );

      await act(async () => {
        resolveLookup({
          data: { status: "found", company: { ...foundCompany } },
        });
        await Promise.resolve();
      });

      expect(statusRegion(view).textContent).toBe(
        m.accountAresLookupReviewReady({}, { locale })
      );
      expect(
        view.queryByRole("button", {
          name: m.accountAresLookupApply({}, { locale }),
        })
      ).toBeTruthy();
    }
  );

  test("surfaces the localized action error in the live region when the lookup execution fails", async () => {
    const view = renderForm();
    lookupAresBusiness.mockImplementationOnce(() =>
      Promise.reject(new TypeError("network down"))
    );

    await act(async () => {
      fireEvent.input(companyIdInput(view), {
        target: { value: "27121043" },
      });
      fireEvent.click(lookupButton(view));
      await Promise.resolve();
      await Promise.resolve();
    });

    const actionErrorMessage = m.accountAresLookupActionError(
      {},
      { locale: "en-US" }
    );
    expect(statusRegion(view).textContent).toContain(actionErrorMessage);
    expect(
      view.queryByText(m.accountAresLookupReviewTitle({}, { locale: "en-US" }))
    ).toBeNull();
  });

  test("dismisses the review when the company ID input changes", async () => {
    const view = renderForm();
    await runLookup(view, { status: "found", company: { ...foundCompany } });
    expect(
      view.getByText(m.accountAresLookupReviewTitle({}, { locale: "en-US" }))
    ).toBeTruthy();

    await act(async () => {
      fireEvent.input(companyIdInput(view), { target: { value: "12345678" } });
    });

    expect(
      view.queryByRole("button", {
        name: m.accountAresLookupApply({}, { locale: "en-US" }),
      })
    ).toBeNull();
  });

  test("dismisses the review when the billing kind changes", async () => {
    const view = renderForm();
    await runLookup(view, { status: "found", company: { ...foundCompany } });
    expect(
      view.getByText(m.accountAresLookupReviewTitle({}, { locale: "en-US" }))
    ).toBeTruthy();

    await act(async () => {
      fireEvent.change(view.getByLabelText("Billing profile"), {
        target: { value: "personal" },
      });
      fireEvent.change(view.getByLabelText("Billing profile"), {
        target: { value: "business" },
      });
    });

    expect(
      view.queryByRole("button", {
        name: m.accountAresLookupApply({}, { locale: "en-US" }),
      })
    ).toBeNull();
  });

  test("links the invalid-ICO message to the field and moves focus there", async () => {
    const view = renderForm();
    const invalidMessage = m.accountAresLookupInvalidIco(
      {},
      { locale: "en-US" }
    );
    await runLookup(view, {
      status: "invalid-ico",
      message: invalidMessage,
    });

    const input = companyIdInput(view);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(
      "account-profile-ares-status"
    );
    expect(statusRegion(view).getAttribute("aria-live")).toBe("polite");
    expect(statusRegion(view).textContent).toContain(invalidMessage);
    expect(document.activeElement).toBe(input);
  });

  test.each(["not-found", "unavailable"] as const)(
    "reports %s in the live region and offers an explicit retry",
    async (status) => {
      const view = renderForm();
      const message =
        status === "not-found"
          ? m.accountAresLookupNotFound({}, { locale: "en-US" })
          : m.accountAresLookupUnavailable({}, { locale: "en-US" });
      await runLookup(view, { status, message });

      expect(statusRegion(view).textContent).toContain(message);
      const retryButton = view.getByRole("button", {
        name: m.accountAresLookupRetry({}, { locale: "en-US" }),
      });
      assert(retryButton instanceof HTMLButtonElement);
      expect(retryButton.disabled).toBe(false);

      await act(async () => {
        fireEvent.click(retryButton);
        await Promise.resolve();
      });
      expect(lookupAresBusiness).toHaveBeenCalledTimes(2);
      expect(lookupAresBusiness.mock.calls[1]?.[0]).toEqual({
        ico: "27121043",
      });
    }
  );
});
