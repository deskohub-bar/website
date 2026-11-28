import { Effect } from "effect";
import {
  getTableBaseAmount,
  getTableUsageAmount,
} from "@/features/checkout/table-product-catalog";
import { TeamTableOffersStructuredData } from "@/features/pricing/components/team-table-offers-structured-data";
import { pagePreloadDeadline } from "@/features/reservation/backend/page-preload";
import {
  createReservationPage,
  type ReservationPageRestoration,
} from "@/features/reservation/components/create-reservation-page.server";
import { defaultReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { hasReservationIntervalEnded } from "@/features/reservation/reservation-interval";
import { tableReservationPath } from "@/features/reservation/routes";
import { tableSelectionLink } from "@/features/reservation/table-selection-link";
import { getTableAvailabilityQuery } from "@/features/reservation/workspace-availability";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import { loadTeamTableSeatCapacities } from "../backend/team-table-capacity.server";
import {
  defaultTableBookingPeople,
  getTableBookingPriceRequest,
  type TableBookingFormInput,
} from "../table-booking-form-values";
import { getTableBookingSelection } from "../table-booking-selection";
import {
  TableReservationForm,
  TableReservationFormFallback,
  TableReservationFormUnavailable,
} from "./table-reservation-form";

type TableReservationPageValues = TableBookingFormInput & {
  readonly priorDateUnavailable?: boolean;
};

export const tableReservationPage = createReservationPage({
  kind: "table",
  pathname: tableReservationPath,
  fallback: (locale) => <TableReservationFormFallback locale={locale} />,
  loadPageData: () =>
    loadTeamTableSeatCapacities().pipe(
      Effect.provide(WorkspaceDotyposLayer),
      Effect.timeout(pagePreloadDeadline),
      runWorkspaceEffectOrElse("reservation.table.load-sizes", {
        boundary: "page",
        failureCode: "team_table_inventory_unavailable",
        orElse: () => null,
      })
    ),
  prefillsContact: false,
  read: (searchParams, { pageData, today }) =>
    Effect.succeed({
      ...getTableBookingSelection(tableSelectionLink.read(searchParams), {
        capacities: pageData ?? [],
        today,
      }),
      name: "",
      email: "",
      phone: "",
      billing: defaultReservationBillingSelection,
      marketingConsent: false,
      people: defaultTableBookingPeople,
    } satisfies TableBookingFormInput),
  restore: (
    reservation,
    searchParams,
    { pageData, today }
  ): ReservationPageRestoration<TableReservationPageValues> => {
    if (hasReservationIntervalEnded(reservation)) return { kind: "ended" };
    const booked = tableSelectionLink.fromStored({
      reservedFrom: Temporal.Instant.from(reservation.startsAt),
      reservedUntil: Temporal.Instant.from(reservation.endsAt),
      seats: reservation.seats,
    });
    if (!booked) return { kind: "ended" };
    const restored = tableSelectionLink.restore(booked, searchParams);
    const capacities = pageData ?? [];
    const restoredSize = restored.seats ?? reservation.seats;
    const selection = getTableBookingSelection(restored, { capacities, today });
    return {
      kind: "restored",
      values: {
        ...selection,
        ...(!capacities.includes(restoredSize) && {
          seats: 0,
          startTime: "",
          endTime: "",
        }),
        priorDateUnavailable:
          restored.date !== undefined && restored.date < today,
        name: reservation.name,
        email: reservation.email,
        phone: reservation.phone,
        billing: reservation.billing,
        marketingConsent: false,
        people: defaultTableBookingPeople,
      },
    };
  },
  preload: (values, { locale, submittedCode, today }) => {
    const request = getTableBookingPriceRequest(values, {
      locale,
      submittedCode,
    });
    return {
      advertisedPrices: request ? [request] : [],
      availability: values.seats
        ? [getTableAvailabilityQuery({ today, seats: values.seats })]
        : [],
    };
  },
  offerings: () => [],
  renderForm: ({ checkoutOfficeSelection, pageData, ...form }) =>
    pageData?.length ? (
      <>
        <TeamTableOffersStructuredData
          locale={form.locale}
          prices={pageData.map((seats) => ({
            seats,
            base: getTableBaseAmount(seats),
            hourly: getTableUsageAmount(seats, 60),
          }))}
        />
        <TableReservationForm
          {...form}
          capacities={pageData}
          priorDateUnavailable={form.initialValues.priorDateUnavailable}
          initialValues={{
            ...form.initialValues,
            people:
              checkoutOfficeSelection?.kind === "people"
                ? checkoutOfficeSelection.people
                : form.initialValues.people,
          }}
        />
      </>
    ) : (
      <TableReservationFormUnavailable
        inventoryUnavailable={pageData === null}
        locale={form.locale}
      />
    ),
});
