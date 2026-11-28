"use client";

import { effectSchemaResolver } from "@deskohub/effect-schema-resolver";
import { useQuery } from "@tanstack/react-query";
import { Option } from "effect";
import { useId } from "react";
import { useForm, useWatch } from "react-hook-form";
import type { AdvertisedPrice } from "@/features/checkout/advertised-price";
import { getWorkspaceTableProductTitle } from "@/features/checkout/product-catalog.i18n";
import {
  getTableBaseAmount,
  getTableUsageAmount,
} from "@/features/checkout/table-product-catalog";
import { type Locale, m } from "@/features/i18n";
import { OfficePeopleField } from "@/features/office/components/office-people-field";
import type { ReservationPageForm } from "@/features/reservation/components/create-reservation-page.server";
import { ReservationAdvertisedPrice } from "@/features/reservation/components/reservation-advertised-price";
import { ReservationCheckoutForm } from "@/features/reservation/components/reservation-checkout-form";
import type { ReservationEmailConfirmationValues } from "@/features/reservation/components/reservation-customer-fields";
import { ReservationFormDateInput } from "@/features/reservation/components/reservation-date-input";
import { ReservationFormCard } from "@/features/reservation/components/reservation-form-card";
import {
  ReservationFormFallback,
  ReservationSkeletonField,
  ReservationSubmitFallback,
} from "@/features/reservation/components/reservation-form-fallback";
import { ReservationFormLabel } from "@/features/reservation/components/reservation-form-label";
import { getReservationAdvertisedTotal } from "@/features/reservation/components/reservation-selection-summary";
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { useAdvertisedOptionPrices } from "@/features/reservation/components/use-advertised-option-prices";
import { useReservationAvailability } from "@/features/reservation/components/use-reservation-availability";
import {
  useReservationSelectionUrl,
  useWatchedSelection,
} from "@/features/reservation/components/use-reservation-selection-url";
import { getReservationCheckoutAvailability } from "@/features/reservation/reservation.i18n";
import { formatReservationDisplayDateTimeRange } from "@/features/reservation/reservation-date";
import { tableSelectionLink } from "@/features/reservation/table-selection-link";
import {
  getTableAvailabilityQuery,
  getTableSlotsQuery,
  getWorkspaceAvailabilityRange,
} from "@/features/reservation/workspace-availability";
import { tableSlotsQueryOptions } from "@/features/reservation/workspace-availability-client";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/shared/components/ui/form";
import { formatMoney } from "@/shared/money/money";
import { withPlainSpaces } from "@/shared/utils/date-time-format";
import {
  getTableBookingOrder,
  getTableBookingPriceRequest,
  type TableBookingFormData,
  type TableBookingFormInput,
  tableBookingFormSchema,
} from "../table-booking-form-values";
import {
  getTableBookingSelection,
  getTableBookingTimes,
} from "../table-booking-selection";

type TableReservationFormProps = Omit<
  ReservationPageForm<readonly number[], TableBookingFormInput>,
  "checkoutOfficeSelection" | "heldOfficePrice" | "pageData"
> & {
  readonly capacities: readonly number[];
  readonly priorDateUnavailable?: boolean;
};

const tableAdvertisedPrice = {
  isPrice: (
    price: AdvertisedPrice
  ): price is Extract<AdvertisedPrice, { kind: "table" }> =>
    price.kind === "table",
  amountOf: ({ quote }: Extract<AdvertisedPrice, { kind: "table" }>) =>
    getReservationAdvertisedTotal(quote.payment),
};

function TableBookingTimeSelect({
  disabled,
  field,
  label,
  locale,
  nextDayFrom,
  options,
}: {
  readonly disabled?: boolean;
  readonly field: {
    readonly name: string;
    readonly value: string;
    readonly onBlur: () => void;
    readonly onChange: (value: string) => void;
    readonly ref: React.Ref<HTMLSelectElement>;
  };
  readonly label: string;
  readonly locale: Locale;
  readonly nextDayFrom?: string;
  readonly options: readonly string[];
}) {
  const getTimeLabel = (time: string) => {
    const formatted = withPlainSpaces(
      Temporal.PlainTime.from(time).toLocaleString(locale, {
        timeStyle: "short",
      })
    );
    return nextDayFrom && time <= nextDayFrom
      ? m.reservationTableTimeNextDay({ time: formatted }, { locale })
      : formatted;
  };
  return (
    <FormItem>
      <ReservationFormLabel required>{label}</ReservationFormLabel>
      <FormControl>
        <select
          {...field}
          className="h-13 w-full rounded-xl border border-navy-blue/20 bg-white px-3 text-navy-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-burned-orange disabled:opacity-60"
          disabled={disabled}
          onChange={(event) => field.onChange(event.target.value)}
          required
          value={field.value}
        >
          <option value="">{label}</option>
          {field.value && !options.includes(field.value) && (
            <option disabled value={field.value}>
              {getTimeLabel(field.value)}
            </option>
          )}
          {options.map((time) => (
            <option key={time} value={time}>
              {getTimeLabel(time)}
            </option>
          ))}
        </select>
      </FormControl>
      <FormMessage />
    </FormItem>
  );
}

export function TableReservationForm({
  capacities,
  checkoutCustomer,
  checkoutSessionId,
  initialAdvertisedPrices,
  initialAvailability,
  initialValues,
  locale,
  priorDateUnavailable,
  replacementToken,
  submittedCode,
  today,
}: TableReservationFormProps) {
  const form = useForm<
    TableBookingFormInput & ReservationEmailConfirmationValues,
    unknown,
    TableBookingFormData
  >({
    defaultValues: initialValues,
    resolver: effectSchemaResolver(tableBookingFormSchema(locale)),
    mode: "onBlur",
    reValidateMode: "onChange",
  });
  const peopleLabelId = useId();
  const sizeLabelId = useId();
  const [name, email] = useWatch({
    control: form.control,
    name: ["name", "email"],
  });
  const selection = useWatchedSelection(tableSelectionLink, form.control);
  const { date, seats, startTime, endTime } = selection;
  useReservationSelectionUrl(tableSelectionLink, selection);

  const capacityOptions = capacities.map(String);
  const hasSize = seats > 0;
  const calendarQuery = hasSize
    ? getTableAvailabilityQuery({ today, seats })
    : undefined;
  const calendar = useReservationAvailability(calendarQuery, {
    initialAvailability,
    replacementToken,
  });
  const unavailableDates = new Set(calendar.availability?.unavailableDates);
  const dateUnavailable = unavailableDates.has(date);
  const slotsQuery =
    !hasSize || dateUnavailable
      ? undefined
      : Option.getOrUndefined(getTableSlotsQuery(selection));
  const slots = useQuery(
    tableSlotsQueryOptions({ query: slotsQuery, replacementToken })
  );
  const slotAvailability = slots.isError ? undefined : slots.data;
  const { startTimes, endTimes } = getTableBookingTimes(
    slotAvailability,
    selection
  );
  const slotUnavailable =
    Boolean(slotAvailability) &&
    (startTimes.length === 0 ||
      (startTime !== "" && !startTimes.includes(startTime)) ||
      (endTime !== "" && !endTimes.includes(endTime)));
  const slotsRetrying = slots.isError && slots.isFetching;
  const isPending =
    calendar.isPending ||
    Boolean(slotsQuery && (slots.isPending || slotsRetrying));
  const isError = calendar.isError || (slots.isError && !slotsRetrying);
  const isUnavailable = !isError && (dateUnavailable || slotUnavailable);
  const availability = getReservationCheckoutAvailability({
    isError,
    isPending,
    locale,
    unavailable: isUnavailable
      ? { date, reservation: { kind: "table" } }
      : undefined,
  });

  const request = getTableBookingPriceRequest(selection, {
    locale,
    submittedCode,
  });
  const title = getWorkspaceTableProductTitle(locale);
  const advertisedPrices = useAdvertisedOptionPrices({
    family: tableAdvertisedPrice,
    initialAdvertisedPrices,
    productLabel: title,
    requests: request ? [request] : [],
    selected: request,
  });
  const selectedPrice = advertisedPrices.selectedPrice;
  const interval = request?.reservation.details;

  return (
    <ReservationCheckoutForm
      advertisedPrice={advertisedPrices.checkout}
      availability={availability}
      checkoutCustomer={checkoutCustomer}
      checkoutSessionId={checkoutSessionId}
      fields={{
        selection: [...tableSelectionLink.params, "people"],
        emailConfirmation: "emailConfirmation",
        marketingConsent: { name: "marketingConsent", value: true },
      }}
      form={form}
      getOfficeSelection={({ people }) => ({ kind: "people", people })}
      getReservation={getTableBookingOrder}
      locale={locale}
      selection={{
        kind: "table",
        fromSearchParams: (searchParams, visit) => {
          const linked = getTableBookingSelection(
            tableSelectionLink.read(searchParams),
            {
              capacities,
              today,
            }
          );
          for (const field of tableSelectionLink.params)
            visit(field, linked[field]);
        },
      }}
      selectionSummary={{
        reservationTitle: title,
        rows: [
          {
            label: m.checkoutStatusSummarySeatsLabel({}, { locale }),
            value: seats,
          },
          ...(interval
            ? [
                {
                  label: m.checkoutStatusSummaryDateLabel({}, { locale }),
                  value: withPlainSpaces(
                    formatReservationDisplayDateTimeRange(
                      Temporal.Instant.from(interval.startsAt),
                      Temporal.Instant.from(interval.endsAt),
                      locale
                    )
                  ),
                },
              ]
            : []),
        ],
      }}
    >
      <FormField
        control={form.control}
        name="seats"
        render={({ field }) => (
          <FormItem data-table-reservation-form="">
            <ReservationFormLabel id={sizeLabelId} required>
              {m.reservationTableSize({}, { locale })}
            </ReservationFormLabel>
            <FormControl>
              <ReservationTypeInput
                aria-labelledby={sizeLabelId}
                aria-required="true"
                className="grid grid-cols-1 gap-3 space-y-0 sm:grid-cols-2 lg:grid-cols-2"
                idPrefix="team-table-size"
                inputRef={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                onChange={(value) => {
                  if (Number(value) === field.value) return;
                  field.onChange(Number(value));
                  form.setValue("startTime", "");
                  form.setValue("endTime", "");
                  void form.trigger("people");
                }}
                value={String(field.value)}
                values={capacityOptions}
              >
                {capacities.map((capacity) => (
                  <ReservationTypeOption
                    key={capacity}
                    price={m.reservationTableRate(
                      {
                        base: formatMoney(getTableBaseAmount(capacity), locale),
                        hourly: formatMoney(
                          getTableUsageAmount(capacity, 60),
                          locale
                        ),
                      },
                      { locale }
                    )}
                    title={m.reservationTableSizeOption(
                      { seats: capacity },
                      { locale }
                    )}
                    value={String(capacity)}
                  />
                ))}
              </ReservationTypeInput>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {!hasSize && (
        <p className="text-sm text-navy-blue/72">
          {m.reservationTableRestoredSizeUnavailable({}, { locale })}
        </p>
      )}
      {priorDateUnavailable && !startTime && (
        <p className="text-sm text-navy-blue/72">
          {m.reservationTableRestoredPastDate({}, { locale })}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem>
              <ReservationFormLabel required>
                {m.reservationDateLabel({}, { locale })}
              </ReservationFormLabel>
              <ReservationFormDateInput
                {...field}
                disabled={!hasSize}
                label={m.reservationDateLabel({}, { locale })}
                locale={locale}
                maximum={
                  calendarQuery?.to ?? getWorkspaceAvailabilityRange(today).to
                }
                minimum={today}
                onChange={(value) => {
                  if (value === field.value) return;
                  field.onChange(value);
                  form.setValue("startTime", "");
                  form.setValue("endTime", "");
                }}
                unavailableDates={unavailableDates}
              />
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="startTime"
          render={({ field }) => (
            <TableBookingTimeSelect
              disabled={startTimes.length === 0}
              field={{
                ...field,
                onChange: (value) => {
                  field.onChange(value);
                  form.setValue("endTime", "");
                },
              }}
              label={m.reservationTableChooseStart({}, { locale })}
              locale={locale}
              options={startTimes}
            />
          )}
        />
        <FormField
          control={form.control}
          name="endTime"
          render={({ field }) => (
            <TableBookingTimeSelect
              disabled={endTimes.length === 0}
              field={field}
              label={m.reservationTableChooseEnd({}, { locale })}
              locale={locale}
              nextDayFrom={startTime}
              options={endTimes}
            />
          )}
        />
      </div>
      <p className="text-sm text-navy-blue/72 empty:sr-only" role="status">
        {isPending
          ? m.reservationAvailabilityLoading({}, { locale })
          : availability.unavailableMessage}
      </p>
      {hasSize && (
        <FormField
          control={form.control}
          name="people"
          render={({ field, fieldState }) => (
            <OfficePeopleField
              contact={email ? { name, email } : undefined}
              error={fieldState.error?.message}
              inputRef={field.ref}
              labelId={peopleLabelId}
              locale={locale}
              onChange={field.onChange}
              people={field.value}
              seatCapacity={seats}
            />
          )}
        />
      )}
      <div className="empty:sr-only" role="status">
        {selectedPrice && (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-navy-blue">
            <dt>{m.invoiceTableBaseLineLabel({}, { locale })}</dt>
            <dd>{formatMoney(selectedPrice.quote.items[0].amount, locale)}</dd>
            <dt>
              {m.invoiceTableUsageLineLabel(
                { minutes: selectedPrice.quote.items[1].durationMinutes },
                { locale }
              )}
            </dt>
            <dd>{formatMoney(selectedPrice.quote.items[1].amount, locale)}</dd>
            <dt className="font-semibold">
              {m.officePeoplePriceTotal({}, { locale })}
            </dt>
            <dd>
              {advertisedPrices.checkout.total && (
                <ReservationAdvertisedPrice
                  {...advertisedPrices.checkout.total}
                  locale={locale}
                />
              )}
            </dd>
          </dl>
        )}
      </div>
    </ReservationCheckoutForm>
  );
}

export function TableReservationFormUnavailable({
  locale,
  inventoryUnavailable,
}: {
  readonly locale: Locale;
  readonly inventoryUnavailable: boolean;
}) {
  const title = getWorkspaceTableProductTitle(locale);
  return (
    <ReservationFormCard ariaLabel={title}>
      <p className="text-navy-blue">
        {inventoryUnavailable
          ? m.reservationTableInventoryError({}, { locale })
          : m.reservationTableNoSizes({}, { locale })}
      </p>
    </ReservationFormCard>
  );
}

export function TableReservationFormFallback({
  locale,
}: {
  readonly locale: Locale;
}) {
  return (
    <ReservationFormFallback
      label={m.reservationAvailabilityLoading({}, { locale })}
    >
      <ReservationSkeletonField />
      <div className="grid gap-4 sm:grid-cols-3">
        <ReservationSkeletonField />
        <ReservationSkeletonField />
        <ReservationSkeletonField />
      </div>
      <ReservationSubmitFallback />
    </ReservationFormFallback>
  );
}
