import type { FormEvent } from "react";
import type {
  FieldErrors,
  FieldPath,
  FieldPathValue,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";
import type {
  SiteToolEntryPackQuote,
  SiteToolReservationIntent,
} from "@/features/agent-tools/webmcp/use-prepare-reservation-site-tool";
import type { CheckoutSummary } from "@/features/checkout/checkout-summary";
import { type Locale, m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import type { ReservationBillingSelectionInput } from "@/features/reservation/reservation-billing";
import type { CheckoutOfficeSelection } from "@/features/reservation/reservation-checkout-contact";
import type {
  ReservationCheckoutCustomerForm,
  ReservationContactValues,
} from "@/features/reservation/reservation-existing-customer";
import type { ReservationOrderIssuanceData } from "@/features/reservation/reservation-order";
import {
  getInvalidFormFields,
  type InvalidFormField,
} from "@/shared/utils/form-field-errors";
import type { ReservationCheckoutAdvertisedPrice } from "./reservation-checkout-form";
import { confirmReservationContactEmail } from "./reservation-customer-fields";
import type { useCheckoutEmailVerification } from "./use-checkout-email-verification";
import type {
  CheckoutSubmission,
  useReservationCheckout,
} from "./use-reservation-checkout";
import type { useReservationCheckoutStep } from "./use-reservation-checkout-step";

export type ReservationFormData = FieldValues &
  ReservationContactValues & {
    readonly billing: ReservationBillingSelectionInput;
    readonly marketingConsent: boolean;
  };

/** Where a submission of the form led. */
export type ReservationFormSubmission =
  | CheckoutSubmission
  | {
      readonly status: "invalid";
      readonly fields: readonly InvalidFormField[];
    }
  /**
   * A signed-out customer was sent the sign-in email; checkout continues
   * once they verify it.
   */
  | { readonly status: "email-verification" };

export type ReservationSubmitOptions = {
  readonly event?: FormEvent<HTMLFormElement>;
  /** Labels a marketing consent the site tool ticked for the customer. */
  readonly marketingConsentSource?: "site_tool";
  readonly siteTool?: SiteToolReservationIntent;
};

type ReservationCheckout = ReturnType<typeof useReservationCheckout>;

type AdvertisedPriceState = Pick<
  ReservationCheckoutAdvertisedPrice,
  "isError" | "isFetching" | "token"
>;

type AvailabilityState = {
  readonly isPending: boolean;
  readonly unavailableMessage?: string;
};

/** Visits one form field with a value of that field's type. */
export type ReservationFormFieldVisitor<Input extends FieldValues> = <
  Name extends FieldPath<Input>,
>(
  name: Name,
  value: FieldPathValue<Input, Name>
) => void;

/** One form field with a value of that field's own type. */
type ReservationFormFieldEntry<Input extends FieldValues> = {
  readonly [Name in FieldPath<Input>]: {
    readonly name: Name;
    readonly value: FieldPathValue<Input, Name>;
  };
}[FieldPath<Input>];

/** The fields of a reservation form the checkout reads and writes by name. */
export type ReservationCheckoutFormFields<Input extends FieldValues> = {
  /**
   * The fields of the selection step, checked before the contact step. The
   * contact-details fields are never among them.
   */
  readonly selection: readonly FieldPath<Input>[];
  /** The repeated email of someone else's contact. */
  readonly emailConfirmation: FieldPath<Input>;
  /** The marketing-consent field with the value that gives consent. */
  readonly marketingConsent: ReservationFormFieldEntry<Input>;
};

/** What the checkout form's submission reads and drives in one render. */
type ReservationFormSubmissionContext<
  Input extends FieldValues,
  Data extends ReservationFormData,
> = {
  readonly advertisedPrice: AdvertisedPriceState;
  readonly asksMarketingConsent: boolean;
  readonly availability: AvailabilityState;
  readonly booksForSomeoneElse: boolean;
  readonly checkout: ReservationCheckout;
  readonly checkoutCustomer: ReservationCheckoutCustomerForm;
  readonly checkoutStep: ReturnType<typeof useReservationCheckoutStep>;
  readonly displayedOfficePrice?: CheckoutSummary;
  readonly emailVerification: ReturnType<typeof useCheckoutEmailVerification>;
  readonly entryPackId?: OrderId;
  readonly fields: ReservationCheckoutFormFields<Input>;
  readonly form: UseFormReturn<Input, unknown, Data>;
  readonly getOfficeSelection?: (data: Data) => CheckoutOfficeSelection;
  readonly getReservation: (data: Data) => ReservationOrderIssuanceData;
  readonly locale: Locale;
};

/**
 * The fields of the contact-details step. Every other field belongs to the
 * space picked at the first step.
 */
const contactStepFieldNames: ReadonlySet<string> = new Set([
  "address",
  "billing",
  "email",
  "emailConfirmation",
  "marketingConsent",
  "name",
  "phone",
]);

/** Why valid details can't go to checkout, short of the price. */
const rejectCheckout = <
  Input extends FieldValues,
  Data extends ReservationFormData,
>({
  availability,
  booksForSomeoneElse,
  checkout,
  fields,
  form,
  locale,
}: ReservationFormSubmissionContext<Input, Data>):
  | ReservationFormSubmission
  | undefined => {
  if (
    booksForSomeoneElse &&
    !confirmReservationContactEmail(form, fields.emailConfirmation, locale)
  ) {
    checkout.capturePrePaymentOutcome("validation");
    return {
      status: "invalid",
      fields: [
        {
          name: "emailConfirmation",
          message: m.contactValidationEmailConfirmationMismatch({}, { locale }),
        },
      ],
    };
  }
  if (availability.unavailableMessage) {
    checkout.capturePrePaymentOutcome("availability_changed");
    checkout.setSubmissionError(availability.unavailableMessage);
    return { status: "error", message: availability.unavailableMessage };
  }
  return undefined;
};

/** The checkout request for valid details under a signed price. */
const getCheckoutDetails = <
  Input extends FieldValues,
  Data extends ReservationFormData,
>(
  {
    asksMarketingConsent,
    booksForSomeoneElse,
    displayedOfficePrice,
    entryPackId,
    getReservation,
  }: ReservationFormSubmissionContext<Input, Data>,
  {
    advertisedPriceToken,
    data,
    officeSelection,
    marketingConsentSource,
    entryPackQuote,
  }: {
    readonly advertisedPriceToken: string;
    readonly data: Data;
    readonly officeSelection?: CheckoutOfficeSelection;
    readonly marketingConsentSource: "site_tool" | undefined;
    readonly entryPackQuote: SiteToolEntryPackQuote | undefined;
  }
): Parameters<ReservationCheckout["startCheckout"]>[0] => ({
  advertisedPriceToken: entryPackQuote?.token ?? advertisedPriceToken,
  ...(entryPackQuote && { siteToolEntryPackQuote: true }),
  ...(displayedOfficePrice && { displayedOfficePrice }),
  ...(entryPackId && { entryPackId }),
  ...(!booksForSomeoneElse && { customer: "account" }),
  // Without the checkbox the account already consented: send no consent.
  ...(asksMarketingConsent && {
    marketingConsent: data.marketingConsent,
    ...(data.marketingConsent &&
      marketingConsentSource && { marketingConsentSource }),
  }),
  reservation: getReservation(data),
  ...(officeSelection?.kind === "people" && { people: officeSelection.people }),
});

/** Takes valid details to checkout, or a signed-out customer to sign-in. */
const checkoutReservation = <
  Input extends FieldValues,
  Data extends ReservationFormData,
>(
  context: ReservationFormSubmissionContext<Input, Data>,
  data: Data,
  marketingConsentSource: "site_tool" | undefined,
  siteTool: SiteToolReservationIntent | undefined
): ReservationFormSubmission | Promise<CheckoutSubmission> => {
  const { advertisedPrice, checkout, checkoutCustomer, emailVerification } =
    context;
  if (siteTool && (checkout.preparedCheckout || !siteTool.isCurrent())) {
    return {
      status: "error",
      message: m.reservationErrorMessage({}, { locale: context.locale }),
    };
  }
  const entryPackQuote = siteTool?.entryPackQuote;
  if (
    entryPackQuote &&
    (context.booksForSomeoneElse ||
      context.entryPackId !== entryPackQuote.passId ||
      checkoutCustomer.status === "signed-out")
  ) {
    return {
      status: "error",
      message: m.coworkEntryPackUnavailableDescription(
        {},
        { locale: context.locale }
      ),
    };
  }
  if (checkout.preparedCheckout) return checkout.preparedCheckout;

  checkout.clearSubmissionError();
  emailVerification.clearError();
  const rejection = rejectCheckout(context);
  if (rejection) return rejection;
  if (!advertisedPrice.token) {
    checkout.capturePrePaymentOutcome("transport_error");
    const message = m.reservationErrorMessage({}, { locale: context.locale });
    checkout.setSubmissionError(message);
    return { status: "error", message };
  }

  const officeSelection = context.getOfficeSelection?.(data);
  if (checkoutCustomer.status === "signed-out") {
    emailVerification.verify({
      name: data.name,
      email: data.email,
      phone: data.phone,
      billing: data.billing,
      marketingConsent: data.marketingConsent,
      ...(officeSelection && { officeSelection }),
    });
    return { status: "email-verification" };
  }

  return checkout.startCheckout(
    getCheckoutDetails(context, {
      advertisedPriceToken: advertisedPrice.token,
      data,
      officeSelection,
      marketingConsentSource,
      entryPackQuote,
    })
  );
};

/** Names the invalid fields; a stale selection goes back to its step. */
const rejectInvalidForm = <
  Input extends FieldValues,
  Data extends ReservationFormData,
>(
  {
    booksForSomeoneElse,
    checkout,
    checkoutStep,
    fields,
    form,
    locale,
  }: ReservationFormSubmissionContext<Input, Data>,
  errors: FieldErrors<Input>
): ReservationFormSubmission => {
  if (booksForSomeoneElse) {
    confirmReservationContactEmail(form, fields.emailConfirmation, locale);
  }
  checkout.capturePrePaymentOutcome("validation");
  const submission: ReservationFormSubmission = {
    status: "invalid",
    fields: getInvalidFormFields(errors),
  };
  // A selection that went stale since the first step is fixed there.
  if (Object.keys(errors).some((name) => !contactStepFieldNames.has(name))) {
    checkoutStep.goTo("selection");
  }
  return submission;
};

/**
 * Submits the checkout form. The submit button and the site tool share this
 * path: validation, the availability and price checks, then checkout.
 */
export const submitReservationForm = async <
  Input extends FieldValues,
  Data extends ReservationFormData,
>(
  context: ReservationFormSubmissionContext<Input, Data>,
  { event, marketingConsentSource, siteTool }: ReservationSubmitOptions = {}
): Promise<ReservationFormSubmission> => {
  let submission: ReservationFormSubmission | Promise<CheckoutSubmission> = {
    status: "invalid",
    fields: [],
  };
  await context.form.handleSubmit(
    (data) => {
      submission = checkoutReservation(
        context,
        data,
        marketingConsentSource,
        siteTool
      );
    },
    (errors) => {
      submission = rejectInvalidForm(context, errors);
    }
  )(event);
  return submission;
};

/** Validates the space picked at the first step before the contact step. */
export const continueReservationToContact = async <
  Input extends FieldValues,
  Data extends ReservationFormData,
>({
  availability,
  checkout,
  checkoutStep,
  fields,
  form,
}: ReservationFormSubmissionContext<Input, Data>) => {
  checkout.clearSubmissionError();
  const values = form.getValues();
  const selectionFieldNames = fields.selection.filter(
    (name) => Object.hasOwn(values, name) && !contactStepFieldNames.has(name)
  );
  if (!(await form.trigger(selectionFieldNames, { shouldFocus: true }))) {
    checkout.capturePrePaymentOutcome("validation");
    return;
  }
  if (availability.unavailableMessage) {
    checkout.capturePrePaymentOutcome("availability_changed");
    checkout.setSubmissionError(availability.unavailableMessage);
    return;
  }
  checkoutStep.goTo("contact");
};

/** Whether the form can't submit in its current state. */
export const isReservationSubmitDisabled = <
  Input extends FieldValues,
  Data extends ReservationFormData,
>(
  {
    advertisedPrice,
    availability,
    checkout,
    checkoutCustomer,
    emailVerification,
    form,
  }: ReservationFormSubmissionContext<Input, Data>,
  isContactStep: boolean
) =>
  form.formState.isSubmitting ||
  (isContactStep &&
    (checkoutCustomer.status === "unavailable" ||
      checkoutCustomer.status === "support-required")) ||
  isCheckoutBusy(checkout, emailVerification) ||
  isSelectionUnconfirmed(advertisedPrice, availability);

const isCheckoutBusy = (
  checkout: ReservationCheckout,
  emailVerification: ReturnType<typeof useCheckoutEmailVerification>
) =>
  checkout.isSubmittingCheckout ||
  emailVerification.isVerifying ||
  checkout.hasPreparedPayRedirect;

const isSelectionUnconfirmed = (
  advertisedPrice: AdvertisedPriceState,
  availability: AvailabilityState
) =>
  Boolean(availability.unavailableMessage) ||
  availability.isPending ||
  advertisedPrice.isFetching ||
  // A failed refresh keeps the previous, possibly expired, token.
  advertisedPrice.isError ||
  !advertisedPrice.token;
