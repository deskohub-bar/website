import { describe, expect, test } from "bun:test";
import {
  accountPhoneRegion,
  type CustomerAccountState,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import { CustomerViewError } from "../../customer-api/customer-view-error";
import { FakeWorkspace } from "../../customer-api/testing/fake-workspace";
import type { SampleAccountKind } from "../../customer-api/testing/sample-fixtures";
import {
  billingFieldsOf,
  type CompletionDraft,
  type CompletionTextField,
  completionDraftOf,
  type ProfileDraftInvalid,
} from "../profile/profile-draft";
import { ProfileSubmitState } from "../profile/profile-save";
import {
  aboutYouFields,
  aboutYouRefusal,
  onboardingView,
  stepOfInvalid,
} from "./onboarding-model";

const phoneRegion = accountPhoneRegion(null);

const draftWith = (change: Partial<CompletionDraft>): CompletionDraft => ({
  ...completionDraftOf(undefined, "CZ"),
  ...change,
});

const refusal = (draft: CompletionDraft, referralsEnabled = true) =>
  aboutYouRefusal({
    draft,
    invitationCode: undefined,
    phoneRegion,
    referralsEnabled,
  });

const invalidOn = (
  ...fields: ReadonlyArray<CompletionTextField>
): ProfileDraftInvalid<CompletionTextField> => ({
  fields: Object.fromEntries(fields.map((field) => [field, "invalid"])),
  first: Option.fromNullishOr(fields[0]),
});

const accountOf = (kind: SampleAccountKind): CustomerAccountState =>
  FakeWorkspace.forKind(kind).data.account;

describe("onboarding steps", () => {
  test("About you holds name and phone, then the referral code only when offered", () => {
    expect(aboutYouFields(true)).toEqual([
      "firstName",
      "lastName",
      "phone",
      "referralCode",
    ]);
    expect(aboutYouFields(false)).toEqual(["firstName", "lastName", "phone"]);
  });

  test("a refused submit returns to the step that shows its field", () => {
    for (const field of [
      "firstName",
      "lastName",
      "phone",
      "referralCode",
    ] as const) {
      expect(stepOfInvalid(invalidOn(field))).toEqual(Option.some("about-you"));
    }
    for (const field of billingFieldsOf("business")) {
      expect(stepOfInvalid(invalidOn(field))).toEqual(Option.some("billing"));
    }
  });

  test("a refusal belongs to the step of its first field", () => {
    expect(stepOfInvalid(invalidOn("phone", "companyName"))).toEqual(
      Option.some("about-you")
    );
    expect(stepOfInvalid(invalidOn("companyName", "phone"))).toEqual(
      Option.some("billing")
    );
    expect(stepOfInvalid({ fields: {}, first: Option.none() })).toEqual(
      Option.none()
    );
  });
});

describe("About you's Continue", () => {
  test("a valid About you moves on, whatever the billing step still lacks", () => {
    expect(
      refusal(draftWith({ firstName: "Jordan", billingKind: "business" }))
    ).toEqual(Option.none());
  });

  test("points at the first name and an unreadable phone, in screen order", () => {
    const found = refusal(draftWith({ phone: "777 12ab" }));
    expect(
      Option.map(found, (invalid) => ({
        fields: Object.keys(invalid.fields).sort(),
        first: invalid.first,
      }))
    ).toEqual(
      Option.some({
        fields: ["firstName", "phone"],
        first: Option.some("firstName"),
      })
    );
  });

  test("never names a billing field", () => {
    const found = refusal(
      draftWith({ firstName: "", billingKind: "business", companyName: "" })
    );
    expect(Option.map(found, (invalid) => Object.keys(invalid.fields))).toEqual(
      Option.some(["firstName"])
    );
  });
});

describe("onboarding view", () => {
  const done = ProfileSubmitState.Done({ referral: Option.none() });

  test("a profile still to complete shows the steps", () => {
    expect(
      onboardingView(
        accountOf("completion-required"),
        ProfileSubmitState.Idle()
      )
    ).toBe("form");
  });

  test("a profile this flow created shows the finish", () => {
    expect(onboardingView(accountOf("linked"), done)).toBe("finish");
    expect(
      onboardingView(accountOf("linked"), ProfileSubmitState.Submitting())
    ).toBe("finish");
    expect(
      onboardingView(
        accountOf("linked"),
        ProfileSubmitState.Failed({ error: CustomerViewError.Unconfirmed() })
      )
    ).toBe("finish");
  });

  test("any other account leaves onboarding", () => {
    expect(onboardingView(accountOf("linked"), ProfileSubmitState.Idle())).toBe(
      "leave"
    );
    expect(onboardingView(accountOf("support-required"), done)).toBe("leave");
    expect(
      onboardingView(
        accountOf("linked"),
        ProfileSubmitState.Failed({ error: CustomerViewError.Unavailable() })
      )
    ).toBe("leave");
    expect(
      onboardingView(
        accountOf("linked"),
        ProfileSubmitState.Invalid({
          invalid: invalidOn("firstName"),
          attempt: {},
        })
      )
    ).toBe("leave");
  });
});
