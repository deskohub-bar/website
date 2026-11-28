import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Effect } from "effect";
import type { AdvertisedPriceRequest } from "@/features/checkout/advertised-price";
import { getTableCheckoutSummary } from "@/features/checkout/checkout-summary-table";
import { buildTableReservationQuote } from "@/features/checkout/reservation-quote-table";
import { m } from "@/features/i18n";
import { mockCheckoutEmailVerification } from "@/features/reservation/components/use-checkout-email-verification.test-utils";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import type { TableBookingSelection } from "@/features/team-table/table-booking-selection";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import { stubFetch } from "@/shared/testing/fetch-stub.test-utils";
import { workspaceUseAction } from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();
mockCheckoutEmailVerification();
workspaceUseAction.mockReturnValue({
  executeAsync: async () => ({}),
});
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
mock.module("@/features/cookie-consent", () => ({
  useVisitorConsent: () => false,
  visitorConsent: { accepts: () => false },
}));
mock.module("@/features/reservation/actions/prepare-pay-state", () => ({
  preparePayState: async () => ({}),
}));
mock.module("@/features/reservation/actions/get-advertised-price", () => ({
  getAdvertisedPrices: async (requests: readonly AdvertisedPriceRequest[]) => ({
    data: await Promise.all(
      requests.flatMap((request) =>
        request.reservation.kind === "table"
          ? [
              Effect.runPromise(
                buildTableReservationQuote(request.reservation.details)
              ).then((quote) => ({
                request,
                advertisedPrice: {
                  kind: "table",
                  advertisedPriceToken: "table-price",
                  quote,
                  summary: getTableCheckoutSummary(quote),
                },
              })),
            ]
          : []
      )
    ),
  }),
}));

const { TableReservationForm, TableReservationFormUnavailable } = await import(
  "./table-reservation-form"
);

const locale = "en-US";
const today = getCurrentWorkspaceDate();
const date = today.add({ days: 2 }).toString();
const fetchBefore = globalThis.fetch;
const queries = new QueryClient({
  defaultOptions: { queries: { retryDelay: 0 } },
});

afterEach(() => {
  cleanup();
  queries.clear();
  globalThis.fetch = fetchBefore;
});
afterAll(unregisterWorkspaceComponentTestEnv);

const availableCalendar = () =>
  Response.json({
    from: today.toString(),
    to: today.add({ months: 6 }).toString(),
    unavailableDates: [],
    reservedDeskWorkstationRequiredDates: [],
    unavailableCoworkTiers: [],
    meetingRoomUnavailable: false,
    officeUnavailable: false,
    unavailableMonitorOptions: [],
    notices: [],
  });

const availableSlots = (
  seats: number,
  entries: readonly {
    readonly startTime: string;
    readonly endTimes: readonly string[];
  }[]
) =>
  Response.json({
    date,
    seats,
    slotMinutes: 15,
    usableFrom: "00:00",
    usableUntil: "17:00",
    availableStarts: entries.map(({ startTime }) => startTime),
    availableEndsByStart: entries,
  });

const renderForm = (
  selection: TableBookingSelection,
  priorDateUnavailable = false
) =>
  render(
    <QueryClientProvider client={queries}>
      <TableReservationForm
        capacities={[4, 6]}
        checkoutCustomer={{ status: "signed-out" }}
        initialValues={{
          ...selection,
          people: { contactAttends: true, invitees: [] },
          name: "",
          email: "",
          phone: "",
          marketingConsent: false,
        }}
        initialAdvertisedPrices={[]}
        initialAvailability={[]}
        locale={locale}
        priorDateUnavailable={priorDateUnavailable}
        today={today.toString()}
      />
    </QueryClientProvider>
  );

test("offers live starts and only the ends for the selected start, and reprices a changed span", async () => {
  let failSlots = false;
  globalThis.fetch = stubFetch(async (input) => {
    const url = new URL(String(input), "https://workspace.example");
    const { searchParams } = url;
    if (searchParams.get("mode") === "table-slots") {
      if (failSlots) return new Response(null, { status: 503 });
      const seats = Number(searchParams.get("seats"));
      const entries =
        seats === 4
          ? [
              { startTime: "09:00", endTimes: ["09:15", "09:30"] },
              { startTime: "09:15", endTimes: ["09:30", "09:45"] },
            ]
          : [{ startTime: "11:00", endTimes: ["11:15"] }];
      return availableSlots(seats, entries);
    }
    return availableCalendar();
  });

  renderForm({ date, startTime: "09:00", endTime: "09:30", seats: 4 }, true);

  const start = screen.getByRole("combobox", { name: "Start time" });
  const end = screen.getByRole("combobox", { name: "End time" });
  await within(start).findByRole("option", { name: "9:15 AM" });
  expect(within(end).getByRole("option", { name: "9:15 AM" })).toBeDefined();
  expect(within(end).queryByRole("option", { name: "9:45 AM" })).toBeNull();
  const usage = await screen.findByText(
    m.invoiceTableUsageLineLabel({ minutes: 30 }, { locale })
  );
  expect(usage.nextElementSibling?.textContent).toBe(
    formatMoney(currencyCZK(4_000), locale)
  );

  fireEvent.change(start, { target: { value: "09:15" } });
  expect(within(end).queryByRole("option", { name: "9:15 AM" })).toBeNull();
  expect(within(end).getByRole("option", { name: "9:45 AM" })).toBeDefined();
  fireEvent.change(end, { target: { value: "09:30" } });
  const updatedUsage = await screen.findByText(
    m.invoiceTableUsageLineLabel({ minutes: 15 }, { locale })
  );
  expect(updatedUsage.nextElementSibling?.textContent).toBe(
    formatMoney(currencyCZK(2_000), locale)
  );

  fireEvent.click(screen.getByRole("radio", { name: /Table for 6/ }));
  await waitFor(() => {
    expect(within(start).queryByRole("option", { name: "9:15 AM" })).toBeNull();
    expect(
      within(start).getByRole("option", { name: "11:00 AM" })
    ).toBeDefined();
    expect(end.hasAttribute("disabled")).toBe(true);
  });

  failSlots = true;
  await act(async () => {
    await queries.invalidateQueries({
      queryKey: ["workspace-availability", "table-slots"],
    });
  });
  expect(
    (await screen.findAllByText(m.reservationAvailabilityError({}, { locale })))
      .length
  ).toBeGreaterThan(0);
  expect(
    screen.queryByText(m.reservationTableUnavailable({}, { locale }))
  ).toBeNull();
  expect(
    screen.getByText(m.reservationTableRestoredPastDate({}, { locale }))
  ).toBeDefined();
});

test("waits for a replacement table size before requesting calendar and slot availability", async () => {
  const requests: { mode: string | null; seats: string | null }[] = [];
  globalThis.fetch = stubFetch(async (input) => {
    const { searchParams } = new URL(
      String(input),
      "https://workspace.example"
    );
    const mode = searchParams.get("mode");
    const seats = searchParams.get("seats");
    requests.push({ mode, seats });
    return mode === "table-slots"
      ? availableSlots(Number(seats), [
          { startTime: "11:00", endTimes: ["11:15"] },
        ])
      : availableCalendar();
  });

  renderForm({ date, seats: 0, startTime: "", endTime: "" });
  await act(async () => {});
  expect(requests).toEqual([]);
  expect(
    screen.getByText(m.reservationTableRestoredSizeUnavailable({}, { locale }))
  ).toBeDefined();
  expect(
    screen
      .getAllByRole("radio", { name: /Table for/ })
      .every((radio) => radio instanceof HTMLInputElement && !radio.checked)
  ).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: /Table for 6/ }));
  const start = screen.getByRole("combobox", { name: "Start time" });
  await within(start).findByRole("option", { name: "11:00 AM" });
  expect(requests).toHaveLength(2);
  expect(requests).toContainEqual({ mode: null, seats: "6" });
  expect(requests).toContainEqual({ mode: "table-slots", seats: "6" });
  expect(
    screen.queryByText(
      m.reservationTableRestoredSizeUnavailable({}, { locale })
    )
  ).toBeNull();
});

test("shows the appropriate degraded state without booking fields", () => {
  const { rerender } = render(
    <TableReservationFormUnavailable inventoryUnavailable locale={locale} />
  );
  expect(
    screen.getByText(m.reservationTableInventoryError({}, { locale }))
  ).toBeDefined();
  expect(screen.queryByRole("combobox")).toBeNull();

  rerender(
    <TableReservationFormUnavailable
      inventoryUnavailable={false}
      locale={locale}
    />
  );
  expect(
    screen.getByText(m.reservationTableNoSizes({}, { locale }))
  ).toBeDefined();
  expect(screen.queryByRole("combobox")).toBeNull();
});
