import { tableSeatsSchema } from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Match, Result, Schema } from "effect";
import type { AdvertisedPriceRequest } from "@/features/checkout/advertised-price";
import type { CanonicalPromotionCode } from "@/features/discounts";
import { defaultPhoneRegion, type Locale, m } from "@/features/i18n";
import {
  officePeopleSchema,
  validateOfficePeople,
} from "@/features/office/office-people";
import {
  defaultReservationBillingSelection,
  reservationBillingSelectionInputSchema,
} from "@/features/reservation/reservation-billing";
import { reservationCustomerSchema } from "@/features/reservation/reservation-contact";
import {
  getTableAdvertisedPriceReservation,
  normalizedTableReservationOrderSchema,
} from "@/features/reservation/table-reservation";
import {
  getTableReservationInterval,
  isTableReservationBookable,
  isTableReservationSlotTime,
} from "@/features/reservation/table-reservation-time";
import type { TableBookingSelection } from "./table-booking-selection";

export const tableBookingFormSchema = (locale: Locale) =>
  Schema.Struct({
    ...reservationCustomerSchema(defaultPhoneRegion(locale)).fields,
    billing: reservationBillingSelectionInputSchema,
    marketingConsent: Schema.Boolean,
    seats: tableSeatsSchema,
    date: Schema.String,
    startTime: Schema.String,
    endTime: Schema.String,
    people: officePeopleSchema,
  }).check(
    Schema.makeFilter(({ date, startTime, endTime }) => {
      if (!date) {
        return {
          path: ["date"],
          issue: m.reservationTableChooseDate({}, { locale }),
        };
      }
      if (!isTableReservationSlotTime(startTime)) {
        return {
          path: ["startTime"],
          issue: m.reservationTableStartRequired({}, { locale }),
        };
      }
      const interval = getTableReservationInterval(date, startTime, endTime);
      if (!interval) {
        return {
          path: ["endTime"],
          issue: m.reservationTableEndRequired({}, { locale }),
        };
      }
      return (
        isTableReservationBookable(interval, Temporal.Now.instant()) || {
          path: ["startTime"],
          issue: m.reservationValidationTableEnded({}, { locale }),
        }
      );
    }),
    Schema.makeFilter(({ email, people, seats }) => {
      const result = validateOfficePeople(people, {
        contactEmail: email,
        seatCapacity: seats,
      });
      if (Result.isSuccess(result)) return true;
      const message = Match.valueTags(result.failure, {
        OverCapacity: () =>
          m.reservationTablePeopleOverCapacity({}, { locale }),
        NoPeople: () => m.officePeopleNoPeople({}, { locale }),
        InviteeRejected: ({ reason }) =>
          ({
            invalid: m.officePeopleInvalidEmail,
            duplicate: m.officePeopleDuplicateEmail,
            contact: m.officePeopleContactEmail,
          })[reason]({}, { locale }),
      });
      return { path: ["people"], issue: message };
    })
  );

export type TableBookingFormInput = ReturnType<
  typeof tableBookingFormSchema
>["Encoded"];
export type TableBookingFormData = ReturnType<
  typeof tableBookingFormSchema
>["Type"];

export const getTableBookingOrder = (values: TableBookingFormData) => {
  const interval = getTableReservationInterval(
    values.date,
    values.startTime,
    values.endTime
  );
  if (!interval)
    throw new Error("Validated Team Table booking has no interval.");

  return normalizedTableReservationOrderSchema.make({
    kind: "table",
    ...interval,
    seats: values.seats,
    name: values.name,
    email: values.email,
    phone: values.phone,
    billing: values.billing ?? defaultReservationBillingSelection,
  });
};

export const getTableBookingPriceRequest = (
  { date, startTime, endTime, seats }: TableBookingSelection,
  {
    locale,
    submittedCode,
  }: {
    readonly locale: Locale;
    readonly submittedCode?: CanonicalPromotionCode;
  }
) => {
  if (!seats) return undefined;
  const interval = getTableReservationInterval(date, startTime, endTime);
  if (
    !interval ||
    !isTableReservationBookable(interval, Temporal.Now.instant())
  )
    return undefined;
  return {
    locale,
    ...(submittedCode && { submittedCode }),
    reservation: getTableAdvertisedPriceReservation({
      kind: "table",
      seats,
      ...interval,
    }),
  } satisfies AdvertisedPriceRequest;
};

export const defaultTableBookingPeople = { contactAttends: true, invitees: [] };
