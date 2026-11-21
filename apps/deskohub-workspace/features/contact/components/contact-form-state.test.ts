import { describe, expect, test } from "bun:test";
import type { ContactFormState } from "@/features/contact/actions/contact";
import { m } from "@/features/i18n";
import { resolveContactFormState } from "./contact-form-state";

describe("resolveContactFormState", () => {
  test("keeps hydrated validation errors over a native success", () => {
    const validationError: ContactFormState = {
      status: "error",
      message: "Review the form.",
      values: { name: " S ", email: "bad", phone: "", message: " short " },
      fieldErrors: { name: "Enter your name." },
    };

    expect(
      resolveContactFormState(
        { data: validationError },
        { data: { status: "success", message: "Sent." } },
        "Send failed."
      )
    ).toEqual(validationError);
  });

  test("keeps hydrated action errors authoritative over the native fallback", () => {
    const genericError = "The contact request could not be sent.";
    const nativeSuccess: ContactFormState = {
      status: "success",
      message: m.contactSuccessMessage({}, { locale: "en-US" }),
    };

    expect(
      resolveContactFormState(
        { serverError: "internal" },
        { data: nativeSuccess },
        genericError
      )
    ).toEqual({ status: "error", message: genericError });
  });
});
